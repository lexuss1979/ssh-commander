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
- `web/` — React 18 + Vite + xterm.js. Вход: `src/main.tsx`, корневой компонент `src/App.tsx`. Сообщения чата агента рендерятся как markdown (`react-markdown` + `remark-gfm`, компонент `src/components/Markdown.tsx`). Layout в стиле VS Code: разделы (Обзор/Терминал/Файлы/Docker) — верхним таббаром, левый сайдбар только для профилей; вкладки keep-alive (скрываются `display:none`, не размонтируются; страницы получают prop `visible`, фоновые эффекты на паузе при скрытии, xterm делает `fit()` при возврате); AI-агент — постоянная панель справа (drag-разделитель, сворачивание, состояние в `localStorage` `sc-agent-open`/`sc-agent-width`, на окнах < 900 px — оверлей), монтируется один раз на профиль (`key={profile.id}`), WS не рвётся при переключении вкладок и сворачивании панели. Редактор файлов — CodeMirror 6 (`@uiw/react-codemirror` + `@codemirror/language-data` + `theme-one-dark` + search, компонент `src/components/CodeEditor.tsx`, подключается через `React.lazy` отдельным чанком, тема синхронизирована с `data-theme` через MutationObserver, Ctrl+F) — используется в модалке редактирования FilesPage. Вкладка «Обзор» — `src/pages/OverviewPage.tsx` (метрики, polling 3 c только при видимой вкладке). TerminalPage: палитра истории команд (Ctrl+R), чип контейнера + кнопка «Системный shell», «Спросить агента» (выделение или последние ~30 строк, ≤4 КБ; App держит стейт `agentRequest`, AgentPage авто-отправляет «Объясни этот вывод терминала: …» при готовом WS и свободном агенте, иначе prefill в поле ввода). DockerPage: колонки CPU/MEM (polling 3 c при видимой вкладке), prune-кнопки, секция Compose, кнопка терминала в строке контейнера.
- `Dockerfile` — multi-stage: `web-builder` → `server-builder` → `server-deps` (`npm ci --omit=dev`, в runtime попадают только прод-зависимости) → runtime `node:20-alpine`.
- `docker-compose.yml` — публикация `127.0.0.1:8080:8080`, volumes `./data:/data` и `./keys:/keys`.
- `docker-compose.dev.yml` — dev-сервис `ssh-commander-dev` (`target: dev` из Dockerfile): Vite + tsx watch в одном контейнере, исходники смонтированы bind-mount'ами, горячая перезагрузка при изменении `server/src` и `web/src` без пересборки образа. Изменение зависимостей (package.json/lock) требует `scripts/docker-dev.sh up` (пересборка dev-стадии).
- `scripts/docker-dev.sh` — обёртка над dev-compose: `up|down|restart|logs|build`.
- `docs/roadmap.md` — план развития (эпики нового функционала); реализация идёт последовательно, перед каждым эпиком — детальное планирование.
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

- `src/auth.ts` — вход по паролю, httpOnly-cookie `sc_session` (24 ч, in-memory), rate-limit 10 попыток / 15 мин на IP (счётчик сбрасывается при успешном входе, протухшие записи чистятся), проверка авторизации для REST и WS.
- `src/profiles.ts` — CRUD профилей в `profiles.json` (zod-валидация, атомарная запись через tmp+rename). Поля профиля: `name, host, port, username, authType (key|password), keyPath, password, dockerCommand (по умолчанию docker), note`. Путь к ключу — путь внутри контейнера (`/keys/...`). При update непереданный секрет (`password`/`keyPath`) сохраняется из существующего профиля; при смене `authType` новый секрет обязателен. Битый JSON хранилища переименовывается в `*.corrupt-<timestamp>`, а persist отказывается перезаписывать файл до рестарта — молчаливого затирания нет (то же в `ai/dialogues.ts`).
- `src/ssh/manager.ts` — постоянные SSH-подключения на профиль (кэш в памяти, авто-переподключение по `close`; параллельные `getClient` делят один connect, при ошибке подключения клиент закрывается и запись удаляется): `exec` (timeout 60 c, лимит вывода 2 МБ), `execStream` (для `docker logs -f`; `close()` до получения канала закрывает канал сразу после его получения), `execRawChannel` (сырой канал: stdout-стрим + stdin + exit code, для tar-передач файлов), `openShell` (PTY), `getSftp`/`withSftp`.
- `src/ssh/sftp.ts` — promise-обёртки над callback-API SFTP (`readdir, stat, readFile, writeFile, mkdir, rmdir, unlink, rename, chmod`). Всегда использовать их, а не сырые callback-методы.
- `src/services/docker.ts` — docker CLI по SSH: команда собирается из `dockerCommand` профиля + экранированных аргументов (`shq`); `parseDockerJsonOutput` понимает NDJSON, JSON-массив и одиночный объект. Команда контейнера в `run` (`runContainerArgs`) оборачивается в `sh -c <shq(command)>` — многословная команда трактуется как shell-строка, а не имя бинаря. Compose поддерживается только v2 (плагин `docker compose`; standalone v1 отклоняется с понятной ошибкой), детект кэшируется на профиль.
- `src/services/metrics.ts` + `src/routes/metrics.ts` — метрики сервера для вкладки «Обзор» (`GET /api/metrics?profileId=`): CPU/mem/disk/uptime/load по SSH, кэш снимка 2 с на профиль.
- `src/services/file-search.ts` — поиск файлов: `mode=name` (`find -iname`) и `mode=content` (`grep -rInF`), лимиты 500 результатов / 30 c.
- `src/services/transfer.ts` — сборка tar-команд для скачивания/загрузки каталогов (`download-dir`/`upload-dir`), детект отсутствия `tar` с понятной ошибкой.
- `src/services/history.ts` + `src/routes/terminal.ts` — история shell-команд (`GET /api/terminal/history?profileId=&limit=`): форматы bash/zsh, дедуп, по умолчанию 100 / максимум 200.
- `src/routes/keys.ts` — `GET /api/keys`: список файлов в `KEYS_DIR` (для выпадающего списка ключей в форме).
- `src/ws/terminal.ts` — терминальные сессии на профиль: буфер ввода до готовности shell, переживают перезагрузку вкладки (60 c после последнего отсоединения), удаляются по завершении процесса. Опциональный `container` в query — PTY-сессия `docker exec -it` в контейнер, ключ сессии `profileId::container` (системный shell и shell контейнера — разные сессии).
- `src/ai/` — агент: `client.ts` (Chat Completions, streaming SSE, аккумуляция tool_calls, таймаут соединения 120 c), `tools.ts` (определения инструментов + `READ_ONLY_TOOLS`), `guard.ts` (deny-лист read-only команд), `agent.ts` (цикл, подтверждения, лимит шагов), `plan.ts` (режим планирования: `PLAN_MODE_INSTRUCTION`, `toolsForRequest`, `buildPlanRequestMessages`), `messages.ts` (санитизация истории сообщений).
- `src/ai/dialogues.ts` — хранение диалогов агента в `DATA_DIR/ai-dialogues.json` (zod-валидация, атомарная запись tmp+rename, кэш в памяти).
- `src/routes/ai.ts` — REST для диалогов: `GET/POST /api/ai/dialogues`, `GET/DELETE /api/ai/dialogues/:id`.

## REST и WebSocket API

Все маршруты кроме `/api/auth/*` и `/api/health` требуют cookie-сессии.

- `POST /api/auth/login|logout`
- CRUD `/api/profiles`, `GET /api/keys`
- Диалоги агента: `GET /api/ai/dialogues?profileId=` (список-сводки), `POST /api/ai/dialogues` `{profileId}` (создать), `GET /api/ai/dialogues/:id` (полный диалог), `DELETE /api/ai/dialogues/:id`
- `GET /api/metrics?profileId=` — снимок метрик сервера (вкладка «Обзор»).
- `GET /api/terminal/history?profileId=&limit=` — история shell-команд (палитра Ctrl+R в терминале).
- `/api/files/list|read|write|mkdir|rename|chmod|delete|download|upload|search|download-dir|upload-dir` — `profileId` и `path` в query/body; upload — raw body (`express.raw`, лимит 200 МБ); download — стрим; search — `mode=name|content`; download-dir — tar.gz стрим; upload-dir — raw tar.gz → `tar -xzf`.
- `/api/docker/containers|images|volumes|networks`, действия контейнеров (`start|stop|restart|rm`), `pull`, `rmi`, `run`, `logs` (tail и follow-стрим), `GET /stats`, `POST /prune` `{target: containers|images|volumes|system}`, `GET /compose/status`, `GET /compose/ps`, `POST /compose/up|down`.
- WS `/ws/terminal?profileId=&cols=&rows=[&container=<id>]` — сообщения: клиент `input|resize|close`, сервер `output|connected|close|error`.
- WS `/ws/agent?profileId=&dialogueId=` — клиент `message {content, planMode?}|approve|reject|approve_plan|stop`, сервер `dialogue|token|message|tool_pending|tool_result|plan_ready|running|done|error`. Диалог загружается в сессию при подключении и сохраняется по ходу каждого шага; если `dialogueId` не передан, сервер создаёт новый диалог и сообщает его id событием `dialogue`.

## AI-агент: правила подтверждений

Два класса инструментов:
- Read-only (выполняются автоматически): `exec_readonly, read_file, list_dir, docker_ps, docker_logs, docker_inspect`.
- Мутирующие (ждут approve/reject в UI): `exec, write_file, docker_action`.

`exec_readonly` дополнительно фильтруется deny-листом в `guard.ts`: запрещены конвейеры/редиректы/подстановки, мутирующие команды (`rm, mv, cp, chmod, chattr, setfacl, dd, wipefs, tee, unlink, mkfs* и xfs_* по префиксу, systemctl, apt, docker ...`), мутирующие флаги `find` (`-delete, -exec, -execdir, -ok, -okdir`), интерпретаторы и прочее. Результат `exec`/`exec_readonly` всегда содержит exit code; ненулевой код возвращается модели как ошибка. Если расширяешь набор инструментов — обязательно:
1. добавь определение в `tools.ts`,
2. добавь имя в `READ_ONLY_TOOLS` (если read-only) и обработчик в `runTool` в `agent.ts`,
3. если инструмент исполняет произвольный shell — проверь, что он не попал в read-only класс без проверок guard.

Режим планирования (`planMode`, `src/ai/plan.ts`): клиент шлёт `message` с `planMode: true` — запрос к API идёт БЕЗ tools, модель возвращает текст плана, сервер отвечает `plan_ready` и ждёт. `approve_plan` запускает обычный цикл с инструментами (per-tool approve/reject сохраняется); правки плана — повторным `message` с `planMode: true`. Шаги планирования не расходуют `AI_MAX_STEPS`. В UI — переключатель «План» и PlanCard в AgentPage.

## Правила работы с кодом

- TypeScript strict; сервер — ESM, относительные импорты с расширением `.js`; фронтенд — `noUnusedLocals`, `noUnusedParameters`.
- Пути в API: абсолютные, нормализация `//` и хвостового `/`; операции удаления запрещают `/` и `..` (`src/util/path.ts`); рекурсивное удаление использует `rm -rf -- <shq(path)>`.
- Секреты: ключи, `.env` и `data/profiles.json` в git не попадают (`.gitignore`); не добавлять их в коммиты и не логировать содержимое.
- Docker-сборка: при изменении сервера/фронта контейнер пересобирается через `docker compose up -d --build`; `WEB_DIST` в Dockerfile задан явно — не удалять.
- Интерфейс: тёмная и светлая темы на CSS-переменных (`web/src/styles.css`, атрибут `data-theme` на `<html>`), переключатель в сайдбаре, выбор сохраняется в `localStorage`; русский язык; скроллируемые области используют `scrollbar-gutter: stable` против дёргания layout.
- Git: репозиторий инициализирован в корне проекта, ветка `main`.

## Тестирование

- `cd server && npm test` — unit-тесты (14 файлов, 105 тестов): `guard.test.ts` (deny-лист), `path.test.ts` (безопасность путей), `docker-json.test.ts` (парсер вывода docker), `docker-run.test.ts` (сборка `docker run` с `sh -c`), `docker-ops.test.ts` (prune/compose-аргументы, парсинг `stats`), `dialogues.test.ts` и `profiles.test.ts` (хранилища, частичный update секретов), `corrupt-store.test.ts` (битый JSON: `*.corrupt-*` и отказ persist), `metrics.test.ts` (парсинг метрик), `file-search.test.ts` (команды и парсинг поиска), `transfer.test.ts` (tar-команды, детект отсутствия tar), `history.test.ts` (парсинг истории bash/zsh, дедуп), `plan.test.ts` (режим планирования), `messages.test.ts` (санитизация истории сообщений агента).
- `server/test/integration.manual.mjs` — ручной интеграционный сценарий: требует запущенный сервер (`APP_PASSWORD=test123`) и тестовый sshd (linuxserver/openssh-server на `127.0.0.1:2222`, user `test`); покрывает auth, WS-guard, SFTP CRUD, терминал, docker CLI.
- `server/test/agent.manual.mjs` — цикл агента против мокового OpenAI-совместимого endpoint'а (read-only авто, мутация через approve).
- Перед сдачей изменений: `npm run build` в обоих каталогах и `npm test` — зелёные, `npm audit` без уязвимостей.

## Безопасность (кратко)

Сервис однопользовательский: localhost-only, пароль из `APP_PASSWORD`, httpOnly-cookie, rate-limit логина. SSH-пароли лежат открытым текстом в `data/profiles.json` — это осознанный компромисс локального инструмента, volume наружу не публиковать. Мутирующие действия агента никогда не выполняются без подтверждения; deny-лист read-only команд консервативен — лучше отказать, чем пропустить.
