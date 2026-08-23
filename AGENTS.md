# AGENTS.md — ssh-commander

Локальный веб-инструмент для управления удалённым Linux-сервером по SSH: терминал, файловый менеджер (SFTP), Docker Explorer и AI-агент. Запускается через Docker, слушает только `127.0.0.1`, защищён паролем. Интерфейс и системный промпт агента — на русском.

Этот файл — только правила, команды и инварианты. Детали реализации (устройство сервисов, API-маршруты, механика UI, состав unit-тестов) — в `docs/architecture.md`; заглядывай туда при работе с конкретной подсистемой.

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

## Карта проекта

- `server/` — Node.js + TypeScript (ESM, strict). Express + `ws` + `ssh2`. Вход `src/index.ts`; HTTP-маршруты — `src/routes/`, бизнес-логика — `src/services/`, SSH-слой — `src/ssh/`, AI-агент — `src/ai/`, WebSocket — `src/ws/`.
- `web/` — React 18 + Vite + xterm.js. Вход `src/main.tsx`, корневой компонент `src/App.tsx`. Layout в стиле VS Code: верхний таббар разделов профиля, левый сайдбар, постоянная панель AI-агента справа. Вкладки и панель агента — keep-alive: скрываются `display:none`, не размонтируются, WS не рвётся; страницы получают prop `visible` и ставят фоновый polling на паузу при скрытии. Страницы — `src/pages/`, переиспользуемое — `src/components/`.
- `Dockerfile` — multi-stage (`web-builder` → `server-builder` → `server-deps` → runtime `node:20-alpine`).
- `docker-compose.yml` — публикация `127.0.0.1:8080:8080`, volumes `./data:/data` и `./keys:/keys`. `docker-compose.dev.yml` + `scripts/docker-dev.sh` — dev-режим с hot-reload; изменение зависимостей (package.json/lock) требует пересборки dev-стадии через `scripts/docker-dev.sh up`.
- `docs/roadmap.md` — план развития (эпики); перед каждым эпиком — детальное планирование. `docs/architecture.md` — детали реализации.
- `data/` — volume: `profiles.json` (профили, пароли открытым текстом), `db-connections.json` (подключения БД, пароли открытым текстом), `ai-dialogues.json` (диалоги агента), `memory/<profileId>/MEMORY.md` (память агента).
- `keys/` — SSH-ключи, монтируются в контейнер в `/keys` (в образ не копируются); импорт через UI сохраняет с правами 0600.
- `server/test/` — unit-тесты (vitest) и ручные сценарии (`*.manual.mjs` / `*.manual.ts`).

## Конфигурация (env)

Задаётся через `.env` (шаблон — `.env.example`), в контейнере — через `environment` в compose.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `APP_PORT` / `APP_HOST` | `8080` / `0.0.0.0` | Порт и адрес HTTP/WS сервера |
| `APP_PASSWORD` | `admin` | Пароль входа в веб-интерфейс |
| `DATA_DIR` | `/data` (docker) | Каталог с `profiles.json`, `db-connections.json`, `ai-dialogues.json` и `memory/` |
| `KEYS_DIR` | `/keys` (docker) | Каталог с SSH-ключами |
| `WEB_DIST` | авто-определение | Путь к собранному фронтенду |
| `AI_API_BASE` | `https://api.openai.com/v1` | Базовый URL OpenAI-совместимого API |
| `AI_API_KEY` | пусто | Ключ API; без него агент недоступен |
| `AI_MODEL` | `gpt-4.1-mini` | Модель агента |
| `AI_MAX_STEPS` | `30` | Лимит шагов цикла агента |
| `AI_TEMPERATURE` | `0.2` | Температура модели |
| `AI_SEARCH_API_BASE` | пусто | Anthropic-совместимая база веб-поиска для агента (у DeepSeek — `https://api.deepseek.com/anthropic`, тот же `AI_API_KEY`). Пусто — поиск выключен, инструмент `web_search` модели не объявляется |
| `AI_SEARCH_MODEL` | `deepseek-v4-flash` | Модель для веб-поиска (серверный инструмент `web_search_20260209`) |
| `TUNNEL_PORT_MIN` / `TUNNEL_PORT_MAX` | `10000` / `10049` | Диапазон портов для SSH-туннелей (локальный конец). В Docker compose публикуется на `127.0.0.1` |

`WEB_DIST`/`KEYS_DIR` при локальном запуске определяются относительно расположения модуля (работает и локальная раскладка `server/dist`, и docker-раскладка `/app/dist`); явный env всегда приоритетнее.

## Правила работы с кодом

- TypeScript strict; сервер — ESM, относительные импорты с расширением `.js`; фронтенд — `noUnusedLocals`, `noUnusedParameters`.
- Пути в API: абсолютные, нормализация `//` и хвостового `/`; операции удаления запрещают `/` и `..` (`src/util/path.ts`); рекурсивное удаление использует `rm -rf -- <shq(path)>`.
- Секреты: ключи, `.env` и `data/profiles.json` в git не попадают (`.gitignore`); не добавлять их в коммиты и не логировать содержимое.
- Docker-сборка: при изменении сервера/фронта контейнер пересобирается через `docker compose up -d --build`; `WEB_DIST` в Dockerfile задан явно — не удалять.
- Интерфейс: тёмная и светлая темы на CSS-переменных (`web/src/styles.css`, атрибут `data-theme` на `<html>`), переключатель в сайдбаре, выбор сохраняется в `localStorage`; русский язык; скроллируемые области используют `scrollbar-gutter: stable` против дёргания layout.
- Git: репозиторий инициализирован в корне проекта, ветка `main`.

## AI-агент: правила и инварианты

Два класса инструментов:
- Read-only (выполняются автоматически): `exec_readonly, read_file, read_memory, list_dir, docker_ps, docker_logs, docker_inspect, security_audit, web_search, list_servers` (`web_search` — только при настроенном `AI_SEARCH_API_BASE`; запрос уходит во внешний поисковый API — приватный нюанс, отключается env целиком).
- Мутирующие (никогда не выполняются без approve/reject в UI): `exec, write_file, write_memory, docker_action, connect_server`.

Если расширяешь набор инструментов — обязательно:
1. добавь определение в `src/ai/tools.ts`,
2. добавь имя в `READ_ONLY_TOOLS` (если read-only) и обработчик в `runTool` в `src/ai/agent.ts`,
3. если инструмент исполняет произвольный shell — проверь, что он не попал в read-only класс без проверок guard.

- `exec_readonly` фильтруется deny-листом в `src/ai/guard.ts` (запрещены конвейеры/редиректы/подстановки, мутирующие команды и флаги, интерпретаторы). Deny-лист консервативен — лучше отказать, чем пропустить. Результат `exec`/`exec_readonly` всегда содержит exit code; ненулевой код возвращается модели как ошибка.
- Мульти-серверный режим: диалог привязан к домашнему профилю, остальные серверы подключаются (`attach_server` от пользователя или `connect_server` через approve, хранятся в `extraProfileIds`). Инструменты выполняются только на подключённых серверах (`resolveServer` в `agent.ts`); память и sudo-пароли — per-profile. Подробности — `docs/architecture.md`.
- `security_audit` — детерминированный белый список read-only команд (`src/services/security-audit.ts`), произвольный shell не принимает. Sudo-пароль приходит через WS `sudo_credentials`, хранится только в памяти сессии, не логируется, не сохраняется и не передаётся модели.
- Режим планирования (`planMode`, `src/ai/plan.ts`): запрос к API идёт без tools, модель возвращает текст плана (`plan_ready`), `approve_plan` запускает обычный цикл с инструментами; шаги планирования не расходуют `AI_MAX_STEPS`.

### Память агента (MEMORY.md)

- Для каждого профиля память хранится в `DATA_DIR/memory/<profileId>/MEMORY.md` (`src/ai/memory.ts`). Это локальная память приложения, к удалённому серверу отношения не имеет; имя файла — санитизированный `profileId`, выход за `memory/` невозможен.
- Содержимое подгружается в системный промпт в начале каждой сессии.
- `read_memory` — read-only, автоматически; `write_memory` — мутирующий, требует подтверждения и принимает полный новый текст файла (агент обязан сохранять прежние записи). Инструменты памяти нельзя заменять на `exec`/`write_file`.
- Запись атомарная (tmp+rename), чтение для контекста ограничено 64 КБ.

## Неочевидные инварианты

- Хранилища JSON (`profiles.ts`, `db-connections.ts`, `ai/dialogues.ts`): zod-валидация, атомарная запись tmp+rename. Битый JSON переименовывается в `*.corrupt-<timestamp>`, persist отказывается перезаписывать файл до рестарта — молчаливого затирания нет.
- SFTP — только promise-обёртки из `src/ssh/sftp.ts`, не сырые callback-методы ssh2.
- `src/ssh/manager.ts` — постоянные SSH-подключения на профиль с авто-переподключением; параллельные `getClient` делят один connect. `exec`: timeout 60 c, лимит вывода 2 МБ, опциональный `stdin` (подача пароля в `sudo -S`). `execStream`: `handle.code` резолвится на всех терминальных путях (ошибка exec, close до открытия канала, отказ подключения, close/error канала) — потребитель может безопасно вешать `.then` сразу (до правки follow docker-логов отдавал пустое тело).
- Docker по SSH (`src/services/docker.ts`): команда собирается из `dockerCommand` профиля + `shq`-экранирование аргументов; команда контейнера в `run` оборачивается в `sh -c` (многословная команда = shell-строка). Compose — только v2 (`docker compose`), standalone v1 отклоняется.
- Update профиля: непереданный секрет (`password`/`keyPath`/`keyPassphrase`) сохраняется из существующего профиля; при смене `authType` новый секрет обязателен. То же у подключений БД (`db-connections.ts`): непереданный пароль сохраняется из существующей записи. `logPaths` обновляется так же частично; замена списка — `PUT /api/profiles/:id/log-paths` без разрыва SSH-подключения (полный update оборвал бы открытый tail-стрим).
- Подключения БД (вкладка «Базы данных», эпик 12): пароль пользователя передаётся **первой строкой stdin** канала (`IFS= read -r PGPASSWORD/MYSQL_PWD` в `sh -c` внутри контейнера) — не в argv, не в env хоста, не из env контейнера (может протухнуть). `\n`/`\r` в пароле отклоняются валидацией. Тумблер «только чтение» — серверный SET перед запросом, защита от случайности, не от намеренного. Подробности — `docs/architecture.md`.
- Живой просмотр логов (эпик 14, `GET /api/files/tail`): follow-стримы ограничены `services/stream-limits.ts` — 3 слота на профиль **суммарно по всем подсистемам**, включая follow docker-логов (`routes/docker.ts` тоже занимает слот); слот снимается на любом пути завершения (req close и settle `handle.code`), идемпотентно. Предпроверка (stat + сниф бинарности по SFTP) — до `flushHeaders`, отказ идёт JSON-ошибкой. Backpressure follow-веток — `createChunkGate` из `services/chunk-gate.ts` (дроп чанков с маркером, `finish()` на settle), не пауза SSH-канала. Разовый `tail` при упоре в лимит вывода получает хвостовую пометку об обрезке. `normalizeLogPaths` прогоняется на всех входах схемы профиля (create/update/PUT/импорт).
- Метрики/порты/cron — кэш 2 с на профиль. История нагрузки (`metrics-history.ts`) — in-memory, пишется хуком внутри `collectMetrics`: собственный опрос не нужен, историю кормят запросы `/api/metrics` и `/api/overview`.
- SSH-туннели — in-memory реестр без персистентности; локальный конец слушает на `127.0.0.1`, диапазон `TUNNEL_PORT_MIN`–`TUNNEL_PORT_MAX`.
- Мутации crontab — только пользовательского (`crontab -`), с защитой от гонки через `expectedRaw` (409 при расхождении); системные файлы read-only.
- Службы systemd (вкладка «Службы», `/api/services`, эпик 13): снимок — один exec с маркерами и `LC_ALL=C`, детект systemd по тексту (не по коду); имя unit'а валидируется regex `^[A-Za-z0-9@._:\-]+$` (плюс запрет `.`/`..`) до всего остального. Sudo для действий — **прямая форма `sudo -S -p '' -- systemctl <action> -- <unit>` без `sh -c`**, пароль первой строкой stdin канала (не в argv/логах, живёт в памяти одного запроса, в UI может удерживаться в стейте вкладки без persist); ретрай по access-denied безопасен (мутация не началась), зонд `sudo -S -p '' -- true` даёт явный 400 («Неверный sudo-пароль» / «нет прав sudo» / «sudo не установлен»). Ошибки действий: 400 — пользовательские причины (нужен пароль, masked/not-found/job-failed — с текстом systemd как есть), 502 — только транспорт. Follow-журналы (`follow=1`) — через общий лимитер на профиль (`services/stream-limits.ts`, сверх лимита 429) и `createChunkGate` (дроп чанков при `res.writableLength > 1 МБ` с маркером «пропущено N байт»); отказ `journalctl` без прав выглядит как пустой вывод с кодом 0, а не ошибка — UI показывает подсказку про группы `adm`/`systemd-journal`. Sudo для журнала в v1 не делается.
- Действия над процессами (вкладка «Обзор», `/api/processes`, эпик 17): `POST /api/processes/:pid/signal` `{signal: TERM|KILL|HUP, sudoPassword?}` и `POST /api/processes/:pid/renice` `{nice: −20..19, sudoPassword?}`. pid — каноничное целое 2..4194304 (`parsePid`; запрет `0`/`1`/отрицательных обязателен: `kill -TERM -1` кладёт всё, до чего дотянется), сигнал — whitelist-enum, произвольная строка не принимается. Команда `kill -<sig> <pid>` **без `--`** (builtin login-shell по-разному понимает `--`, pid после валидации опцией быть не может); sudo — по схеме эпика 13 через общий зонд `services/sudo.ts` (вынесен из systemd.ts, его же ждёт эпик 19; пароль первой строкой stdin, память одного запроса); категория «утилиты нет на сервере» (BusyBox без `renice`, образ без `/bin/kill` под `sudo --`) → 400, а не 502; после мутации — `invalidateMetricsCache` — refetch «Обзора» и сайдбара сразу свежий. Инструмент агента не заводится (`kill`/`pkill`/`killall` в deny-листе `guard.ts` осознанно).
- Перед сдачей изменений: `npm run build` в обоих каталогах и `npm test` — зелёные, `npm audit` без уязвимостей.

## Тестирование

- `cd server && npm test` — unit-тесты vitest, примерно по одному `*.test.ts` на подсистему (полный состав — `docs/architecture.md`).
- Ручные сценарии (требуют инфраструктуры, команды запуска — в `docs/architecture.md` и самих файлах):
  - `server/test/integration.manual.mjs` — нужен запущенный сервер (`APP_PASSWORD=test123`) и тестовый sshd (linuxserver/openssh-server на `127.0.0.1:2222`, user `test`).
  - `server/test/agent.manual.mjs` — цикл агента против мокового OpenAI-совместимого endpoint'а.
  - `server/test/multi-server.manual.mjs` + `server/test/mock-openai-manual.mjs` — мульти-серверный режим: мок на :8199 и два sshd-контейнера на :2222/:2223.
  - `server/test/security-audit.manual.ts` — live-прогон аудита против sshd на :2222 с `SUDO_ACCESS=true` (`npx tsx test/security-audit.manual.ts`).
  - `server/test/db.manual.mjs` — вкладка «Базы данных»: контейнеры `postgres:16-alpine` + `postgres:16` (dash) + `mysql:8`, подключения с явными креденшалами, test-connection (в т.ч. неверный пароль), query/dump, частичный update пароля.

## Безопасность (кратко)

Сервис однопользовательский: localhost-only, пароль из `APP_PASSWORD`, httpOnly-cookie, rate-limit логина. SSH-пароли лежат открытым текстом в `data/profiles.json`, пароли подключений БД — в `data/db-connections.json` — это осознанный компромисс локального инструмента (тот же trust domain), volume наружу не публиковать. Пароль БД не светится в argv/ps хоста: передаётся первой строкой stdin канала. Мутирующие действия агента никогда не выполняются без подтверждения; deny-лист read-only команд консервативен — лучше отказать, чем пропустить. SSH-туннели: локальный конец слушает на `127.0.0.1` внутри контейнера, доступен любому локальному процессу без авторизации (обходит `APP_PASSWORD`). Для однопользовательской машины приемлемо (как и терминал), но это ослабление модели безопасности — туннель даёт доступ к удалённым сервисам всем, кто может подключиться к `127.0.0.1:<порт>`.
