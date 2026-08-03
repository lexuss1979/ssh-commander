# AGENTS.md — ssh-commander

Локальный веб-инструмент для управления удалённым Linux-сервером по SSH: терминал, файловый менеджер (SFTP), Docker Explorer и AI-агент. Запускается через Docker, слушает только `127.0.0.1`, защищён паролем. Интерфейс и системный промпт агента — на русском.

## Быстрые команды

```bash
# Production (основной способ запуска)
docker compose up -d --build        # пересборка обязательна после изменений кода
docker compose down                 # остановить

# Dev-режим в Docker: hot-reload без пересборки образа при изменении кода
scripts/docker-dev.sh up            # dev-образ (только npm ci) + запуск: API на :8081, web на :5173
scripts/docker-dev.sh logs          # логи обоих процессов
scripts/docker-dev.sh restart       # перезапуск контейнера
scripts/docker-dev.sh down

# Разработка
cd server && npm install && npm run dev   # API + WebSocket на :8080
cd web && npm install && npm run dev      # Vite на :5173, проксирует /api и /ws на :8080

# Сборка и тесты
cd server && npm run build && npm test    # tsc + vitest (unit)
cd web && npm run build                   # tsc && vite build → web/dist
```

Фронтенд собирается внутри Dockerfile автоматически — вручную собирать его для контейнера не нужно.

## Структура проекта

- `server/` — Node.js + TypeScript (ESM). Express + WebSocket (`ws`) + `ssh2`. Вход: `src/index.ts`.
- `web/` — React 18 + Vite + xterm.js. Вход: `src/main.tsx`, корневой компонент `src/App.tsx`. Сообщения чата агента рендерятся как markdown (`react-markdown` + `remark-gfm`, компонент `src/components/Markdown.tsx`).
- `Dockerfile` — multi-stage: `web-builder` → `server-builder` → runtime `node:20-alpine`.
- `docker-compose.yml` — публикация `127.0.0.1:8080:8080`, volumes `./data:/data` и `./keys:/keys`.
- `docker-compose.dev.yml` — dev-сервис `ssh-commander-dev` (`target: dev` из Dockerfile): Vite + tsx watch в одном контейнере, исходники смонтированы bind-mount'ами, горячая перезагрузка при изменении `server/src` и `web/src` без пересборки образа. Изменение зависимостей (package.json/lock) требует `scripts/docker-dev.sh up` (пересборка dev-стадии).
- `scripts/docker-dev.sh` — обёртка над dev-compose: `up|down|restart|logs|build`.
- `data/` — volume: `profiles.json` (профили серверов, пароли открытым текстом) и `ai-dialogues.json` (история диалогов AI-агента).
- `keys/` — SSH-ключи, монтируются в контейнер в `/keys` (не копируются в образ).
- `server/test/` — unit-тесты (vitest) и ручные интеграционные сценарии (`*.manual.mjs`).

## Конфигурация (env)

Задаётся через `.env` (шаблон — `.env.example`), в контейнере — через `environment` в compose.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `APP_PORT` / `APP_HOST` | `8080` / `0.0.0.0` | Порт и адрес HTTP/WS сервера |
| `APP_PASSWORD` | `admin` | Пароль входа в веб-интерфейс |
| `DATA_DIR` | `/data` (docker) | Каталог с `profiles.json` |
| `KEYS_DIR` | `/keys` (docker) | Каталог с SSH-ключами |
| `WEB_DIST` | авто-определение | Путь к собранному фронтенду |
| `AI_API_BASE` | `https://api.openai.com/v1` | Базовый URL OpenAI-совместимого API |
| `AI_API_KEY` | пусто | Ключ API; без него агент недоступен |
| `AI_MODEL` | `gpt-4.1-mini` | Модель агента |
| `AI_MAX_STEPS` | `30` | Лимит шагов цикла агента |
| `AI_TEMPERATURE` | `0.2` | Температура модели |

`WEB_DIST`/`KEYS_DIR` при локальном запуске определяются относительно расположения модуля (работает и локальная раскладка `server/dist`, и docker-раскладка `/app/dist`); явный env всегда приоритетнее.

## Архитектура сервера

- `src/auth.ts` — вход по паролю, httpOnly-cookie `sc_session` (24 ч, in-memory), rate-limit 10 попыток / 15 мин на IP, проверка авторизации для REST и WS.
- `src/profiles.ts` — CRUD профилей в `profiles.json` (zod-валидация, атомарная запись через tmp+rename). Поля профиля: `name, host, port, username, authType (key|password), keyPath, password, dockerCommand (по умолчанию docker), note`. Путь к ключу — путь внутри контейнера (`/keys/...`).
- `src/ssh/manager.ts` — постоянные SSH-подключения на профиль (кэш в памяти, авто-переподключение по `close`): `exec` (timeout 60 c, лимит вывода 2 МБ), `execStream` (для `docker logs -f`), `openShell` (PTY), `getSftp`/`withSftp`.
- `src/ssh/sftp.ts` — promise-обёртки над callback-API SFTP (`readdir, stat, readFile, writeFile, mkdir, rmdir, unlink, rename, chmod`). Всегда использовать их, а не сырые callback-методы.
- `src/services/docker.ts` — docker CLI по SSH: команда собирается из `dockerCommand` профиля + экранированных аргументов (`shq`); `parseDockerJsonOutput` понимает NDJSON, JSON-массив и одиночный объект.
- `src/routes/keys.ts` — `GET /api/keys`: список файлов в `KEYS_DIR` (для выпадающего списка ключей в форме).
- `src/ws/terminal.ts` — терминальные сессии на профиль: буфер ввода до готовности shell, переживают перезагрузку вкладки (60 c после последнего отсоединения), удаляются по завершении процесса.
- `src/ai/` — агент: `client.ts` (Chat Completions, streaming SSE, аккумуляция tool_calls), `tools.ts` (определения инструментов + `READ_ONLY_TOOLS`), `guard.ts` (deny-лист read-only команд), `agent.ts` (цикл, подтверждения, лимит шагов).
- `src/ai/dialogues.ts` — хранение диалогов агента в `DATA_DIR/ai-dialogues.json` (zod-валидация, атомарная запись tmp+rename, кэш в памяти).
- `src/routes/ai.ts` — REST для диалогов: `GET/POST /api/ai/dialogues`, `GET/DELETE /api/ai/dialogues/:id`.

## REST и WebSocket API

Все маршруты кроме `/api/auth/*` и `/api/health` требуют cookie-сессии.

- `POST /api/auth/login|logout`
- CRUD `/api/profiles`, `GET /api/keys`
- Диалоги агента: `GET /api/ai/dialogues?profileId=` (список-сводки), `POST /api/ai/dialogues` `{profileId}` (создать), `GET /api/ai/dialogues/:id` (полный диалог), `DELETE /api/ai/dialogues/:id`
- `/api/files/list|read|write|mkdir|rename|chmod|delete|download|upload` — `profileId` и `path` в query/body; upload — raw body (`express.raw`, лимит 200 МБ); download — стрим.
- `/api/docker/containers|images|volumes|networks`, действия контейнеров (`start|stop|restart|rm`), `pull`, `rmi`, `run`, `logs` (tail и follow-стрим).
- WS `/ws/terminal?profileId=&cols=&rows=` — сообщения: клиент `input|resize|close`, сервер `output|connected|close|error`.
- WS `/ws/agent?profileId=&dialogueId=` — клиент `message|approve|reject|stop`, сервер `dialogue|token|message|tool_pending|tool_result|running|done|error`. Диалог загружается в сессию при подключении и сохраняется по ходу каждого шага; если `dialogueId` не передан, сервер создаёт новый диалог и сообщает его id событием `dialogue`.

## AI-агент: правила подтверждений

Два класса инструментов:
- Read-only (выполняются автоматически): `exec_readonly, read_file, list_dir, docker_ps, docker_logs, docker_inspect`.
- Мутирующие (ждут approve/reject в UI): `exec, write_file, docker_action`.

`exec_readonly` дополнительно фильтруется deny-листом в `guard.ts`: запрещены конвейеры/редиректы/подстановки, мутирующие команды (`rm, mv, cp, chmod, systemctl, apt, docker ...`), интерпретаторы и прочее. Если расширяешь набор инструментов — обязательно:
1. добавь определение в `tools.ts`,
2. добавь имя в `READ_ONLY_TOOLS` (если read-only) и обработчик в `runTool` в `agent.ts`,
3. если инструмент исполняет произвольный shell — проверь, что он не попал в read-only класс без проверок guard.

## Правила работы с кодом

- TypeScript strict; сервер — ESM, относительные импорты с расширением `.js`; фронтенд — `noUnusedLocals`, `noUnusedParameters`.
- Пути в API: абсолютные, нормализация `//` и хвостового `/`; операции удаления запрещают `/` и `..` (`src/util/path.ts`); рекурсивное удаление использует `rm -rf -- <shq(path)>`.
- Секреты: ключи, `.env` и `data/profiles.json` в git не попадают (`.gitignore`); не добавлять их в коммиты и не логировать содержимое.
- Docker-сборка: при изменении сервера/фронта контейнер пересобирается через `docker compose up -d --build`; `WEB_DIST` в Dockerfile задан явно — не удалять.
- Интерфейс: тёмная и светлая темы на CSS-переменных (`web/src/styles.css`, атрибут `data-theme` на `<html>`), переключатель в сайдбаре, выбор сохраняется в `localStorage`; русский язык; скроллируемые области используют `scrollbar-gutter: stable` против дёргания layout.
- Git: репозиторий инициализирован в корне проекта, ветка `main`.

## Тестирование

- `cd server && npm test` — unit-тесты: `guard.test.ts` (deny-лист), `docker-json.test.ts` (парсер вывода docker), `path.test.ts` (безопасность путей).
- `server/test/integration.manual.mjs` — ручной интеграционный сценарий: требует запущенный сервер (`APP_PASSWORD=test123`) и тестовый sshd (linuxserver/openssh-server на `127.0.0.1:2222`, user `test`); покрывает auth, WS-guard, SFTP CRUD, терминал, docker CLI.
- `server/test/agent.manual.mjs` — цикл агента против мокового OpenAI-совместимого endpoint'а (read-only авто, мутация через approve).
- Перед сдачей изменений: `npm run build` в обоих каталогах и `npm test` — зелёные, `npm audit` без уязвимостей.

## Безопасность (кратко)

Сервис однопользовательский: localhost-only, пароль из `APP_PASSWORD`, httpOnly-cookie, rate-limit логина. SSH-пароли лежат открытым текстом в `data/profiles.json` — это осознанный компромисс локального инструмента, volume наружу не публиковать. Мутирующие действия агента никогда не выполняются без подтверждения; deny-лист read-only команд консервативен — лучше отказать, чем пропустить.
