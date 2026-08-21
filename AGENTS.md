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
cd web && npm run lint                    # eslint (react-hooks/rules-of-hooks)

# Хуки git (после clone — каталог .git/hooks не версионируется)
bash scripts/install-hooks.sh             # ставит pre-commit
```

Фронтенд собирается внутри Dockerfile автоматически — вручную собирать его для контейнера не нужно.

## Карта проекта

- `server/` — Node.js + TypeScript (ESM, strict). Express + `ws` + `ssh2`. Вход `src/index.ts`; HTTP-маршруты — `src/routes/`, бизнес-логика — `src/services/`, SSH-слой — `src/ssh/`, AI-агент — `src/ai/`, WebSocket — `src/ws/`.
- `web/` — React 18 + Vite + xterm.js. Вход `src/main.tsx`, корневой компонент `src/App.tsx`. Layout в стиле VS Code: верхний таббар разделов профиля, левый сайдбар, постоянная панель AI-агента справа. Вкладки и панель агента — keep-alive: скрываются `display:none`, не размонтируются, WS не рвётся; страницы получают prop `visible` и ставят фоновый polling на паузу при скрытии. Страницы — `src/pages/` (в т.ч. `NginxPage.tsx` — вкладка «Nginx»), переиспользуемое — `src/components/`.
- `Dockerfile` — multi-stage (`web-builder` → `server-builder` → `server-deps` → runtime `node:20-alpine`).
- `docker-compose.yml` — публикация `127.0.0.1:8080:8080`, volumes `./data:/data` и `./keys:/keys`. `docker-compose.dev.yml` + `scripts/docker-dev.sh` — dev-режим с hot-reload; изменение зависимостей (package.json/lock) требует пересборки dev-стадии через `scripts/docker-dev.sh up`.
- `docs/roadmap.md` — план развития (эпики); перед каждым эпиком — детальное планирование. `docs/architecture.md` — детали реализации.
- `data/` — volume: `profiles.json` (профили, пароли открытым текстом), `db-connections.json` (подключения БД, пароли открытым текстом), `snippets.json` (сохранённые команды), `ai-dialogues.json` (диалоги агента), `ai-usage.json` (журнал расходов AI: токены и стоимость каждого вызова), `ai-prices.json` (опциональный оверрайд цен моделей — справочник, битый файл не блокирует запись), `memory/<profileId>/MEMORY.md` (память агента).
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
- Read-only (выполняются автоматически): `exec_readonly, read_file, read_memory, list_dir, docker_ps, docker_logs, docker_inspect, security_audit, disk_usage, web_search, list_servers` (`web_search` — только при настроенном `AI_SEARCH_API_BASE`; запрос уходит во внешний поисковый API — приватный нюанс, отключается env целиком).
- Мутирующие (никогда не выполняются без approve/reject в UI): `exec, write_file, write_memory, docker_action, connect_server`.

Если расширяешь набор инструментов — обязательно:
1. добавь определение в `src/ai/tools.ts`,
2. добавь имя в `READ_ONLY_TOOLS` (если read-only) и обработчик в `runTool` в `src/ai/agent.ts`,
3. если инструмент исполняет произвольный shell — проверь, что он не попал в read-only класс без проверок guard.

- `exec_readonly` фильтруется deny-листом в `src/ai/guard.ts` (запрещены конвейеры/редиректы/подстановки, мутирующие команды и флаги, интерпретаторы). Deny-лист консервативен — лучше отказать, чем пропустить. Результат `exec`/`exec_readonly` всегда содержит exit code; ненулевой код возвращается модели как ошибка.
- Мульти-серверный режим: диалог привязан к домашнему профилю, остальные серверы подключаются (`attach_server` от пользователя или `connect_server` через approve, хранятся в `extraProfileIds`). Инструменты выполняются только на подключённых серверах (`resolveServer` в `agent.ts`); память и sudo-пароли — per-profile. Подробности — `docs/architecture.md`.
- `security_audit` — детерминированный белый список read-only команд (`src/services/security-audit.ts`), произвольный shell не принимает. Sudo-пароль приходит через WS `sudo_credentials`, хранится только в памяти сессии, не логируется, не сохраняется и не передаётся модели.
- Режим планирования (`planMode`, `src/ai/plan.ts`): запрос к API идёт без tools, модель возвращает текст плана (`plan_ready`), `approve_plan` запускает обычный цикл с инструментами; шаги планирования не расходуют `AI_MAX_STEPS`.
- Учёт расходов: каждый платный вызов (`chat`/`plan`/`web_search`) с usage пишется в журнал `data/ai-usage.json` (`src/ai/usage.ts`); привязка — домашний профиль диалога + дата вызова. После каждой записи сессия шлёт WS-событие `{type:'usage', totals}`. Ошибки журнала не роняют цикл агента (try/catch + warn, как у `save()`). Цены — `src/ai/pricing.ts` (дефолты + оверрайд `data/ai-prices.json`). Подробности — `docs/architecture.md` (раздел «Учёт расходов AI»).

### Память агента (MEMORY.md)

- Для каждого профиля память хранится в `DATA_DIR/memory/<profileId>/MEMORY.md` (`src/ai/memory.ts`). Это локальная память приложения, к удалённому серверу отношения не имеет; имя файла — санитизированный `profileId`, выход за `memory/` невозможен.
- Содержимое подгружается в системный промпт в начале каждой сессии.
- `read_memory` — read-only, автоматически; `write_memory` — мутирующий, требует подтверждения и принимает полный новый текст файла (агент обязан сохранять прежние записи). Инструменты памяти нельзя заменять на `exec`/`write_file`.
- Запись атомарная (tmp+rename), чтение для контекста ограничено 64 КБ.

## Неочевидные инварианты

- Хранилища JSON (`profiles.ts`, `db-connections.ts`, `ai/dialogues.ts`): zod-валидация, атомарная запись tmp+rename. Битый JSON переименовывается в `*.corrupt-<timestamp>`, persist отказывается перезаписывать файл до рестарта — молчаливого затирания нет. То же у журнала расходов (`ai/usage.ts`), но НЕ у цен (`ai/pricing.ts`): `ai-prices.json` — справочник, битый файл → warn + дефолты.
- Учёт расходов AI: стоимость фиксируется в момент вызова (смена цен не переписывает историю, токены в записи позволяют пересчитать); цены — дефолты в `src/ai/pricing.ts` + оверрайд `data/ai-prices.json` (мерж по имени модели); `usage` НЕ кладётся в `ChatMessage` (иначе попадёт в persisted-диалог) — составной возврат `{message, usage?}`; привязка затрат — домашний профиль диалога + локальная дата сервера; WS-событие `usage` шлётся после каждой записи; прерванный стрим (без финального usage-чанка) не учитывается — итоги занижены на прерванные вызовы.
- SFTP — только promise-обёртки из `src/ssh/sftp.ts`, не сырые callback-методы ssh2.
- `src/ssh/manager.ts` — постоянные SSH-подключения на профиль с авто-переподключением; параллельные `getClient` делят один connect. `exec`: timeout 60 c, лимит вывода 2 МБ, опциональный `stdin` (подача пароля в `sudo -S`). `execStream`: `handle.code` резолвится на всех терминальных путях (ошибка exec, close до открытия канала, отказ подключения, close/error канала) — потребитель может безопасно вешать `.then` сразу (до правки follow docker-логов отдавал пустое тело); опциональный `stdin` — пишется в канал с EOF (тот же инвариант пароля, что у `exec`).
- Docker по SSH (`src/services/docker.ts`): команда собирается из `dockerCommand` профиля + `shq`-экранирование аргументов; команда контейнера в `run` оборачивается в `sh -c` (многословная команда = shell-строка). Compose — только v2 (`docker compose`), standalone v1 отклоняется.
- Update профиля: непереданный секрет (`password`/`keyPath`/`keyPassphrase`) сохраняется из существующего профиля; при смене `authType` новый секрет обязателен. То же у подключений БД (`db-connections.ts`): непереданный пароль сохраняется из существующей записи. `logPaths` обновляется так же частично; замена списка — `PUT /api/profiles/:id/log-paths` без разрыва SSH-подключения (полный update оборвал бы открытый tail-стрим).
- Подключения БД (вкладка «Базы данных», эпик 12): пароль пользователя передаётся **первой строкой stdin** канала (`IFS= read -r PGPASSWORD/MYSQL_PWD` в `sh -c` внутри контейнера) — не в argv, не в env хоста, не из env контейнера (может протухнуть). `\n`/`\r` в пароле отклоняются валидацией. Тумблер «только чтение» — серверный SET перед запросом, защита от случайности, не от намеренного. Подробности — `docs/architecture.md`.
- Живой просмотр логов (эпик 14, `GET /api/files/tail`): follow-стримы ограничены `services/stream-limits.ts` — 3 слота на профиль **суммарно по всем подсистемам**, включая follow docker-логов (`routes/docker.ts` тоже занимает слот); слот снимается на любом пути завершения (req close и settle `handle.code`), идемпотентно. Предпроверка (stat + сниф бинарности по SFTP) — до `flushHeaders`, отказ идёт JSON-ошибкой. Backpressure follow-веток — `createChunkGate` из `services/chunk-gate.ts` (дроп чанков с маркером, `finish()` на settle), не пауза SSH-канала. Разовый `tail` при упоре в лимит вывода получает хвостовую пометку об обрезке. `normalizeLogPaths` прогоняется на всех входах схемы профиля (create/update/PUT/импорт).
- Метрики/порты/cron/nginx — кэш 2 с на профиль. История нагрузки (`metrics-history.ts`) — in-memory, пишется хуком внутри `collectMetrics`: собственный опрос не нужен, историю кормят запросы `/api/metrics` и `/api/overview`.
- Алерты по порогам (эпик 20): правила (недоступность/диск/память/load на ядро) считает сервер чистой функцией поверх кэша overview (`services/alerts.ts`, `GET /api/alerts?disk=&mem=&load=` — новых SSH-вызовов не добавляет); ответ — состояния **всех** правил с `value`/`threshold`, а не только сработавшие — гистерезис живёт на клиенте (`web/src/alerts.ts`, снятие при `value ≤ порога − дельта`: 5% диск/память, 0.5 load, 0 недоступность). Настройки — localStorage `sc-alerts` (настройка клиента, на сервере не персистятся); первая синхронизация и смена настроек — тихий re-baseline; в скрытой вкладке общий с сайдбаром опрос идёт только при включённых и алертах, и браузерных уведомлениях (единственный сценарий, где фоновый опрос что-то даёт; троттлинг браузера ~1/мин), уведомления — только при неактивной вкладке, разрешение запрашивается по клику; клиентский merge (`web/src/alerts.ts`, чистый модуль) покрыт тестами раннером сервера (`test/alerts-merge.test.ts`). Не превращать в систему мониторинга: пороги простые, истории алертов нет.
- Вкладка «Nginx» (план — `docs/nginx-plan.md`): источник данных — только `nginx -T` (маркеры `# configuration file <путь>:` приписывают server-блоки файлам; fallback на пофайловое чтение не делаем); discovery native первым, контейнеры — белый список репозиториев (`nginx`, `nginxproxy/nginx-proxy`, `jc21/nginx-proxy-manager`, `openresty/openresty`) + подстрока `nginx` в образе/имени. Сертификаты: PEM читается батчем с маркерами `=== <путь>` и парсится локально через `crypto.X509Certificate` — удалённый `openssl` не нужен; кэш 10 мин на (профиль, источник), инвалидация по изменению набора путей. Reload — только после зелёного `nginx -t` (`nginx -s reload` / `docker exec <id> nginx -s reload`; systemctl не используем; красный тест — 409 с выводом). `nginx -t`/`-v` пишут в stderr — вывод читаем оттуда. `nginx -T` вызывается с `maxOutput` 8 МБ.
- SSH-туннели — in-memory реестр без персистентности; локальный конец слушает на `127.0.0.1`, диапазон `TUNNEL_PORT_MIN`–`TUNNEL_PORT_MAX`.
- Мутации crontab — только пользовательского (`crontab -`), с защитой от гонки через `expectedRaw` (409 при расхождении); системные файлы read-only.
- Службы systemd (вкладка «Службы», `/api/services`, эпик 13): снимок — один exec с маркерами и `LC_ALL=C`, детект systemd по тексту (не по коду); имя unit'а валидируется regex `^[A-Za-z0-9@._:\-]+$` (плюс запрет `.`/`..`) до всего остального. Sudo для действий — **прямая форма `sudo -S -p '' -- systemctl <action> -- <unit>` без `sh -c`**, пароль первой строкой stdin канала (не в argv/логах, живёт в памяти одного запроса, в UI может удерживаться в стейте вкладки без persist); ретрай по access-denied безопасен (мутация не началась), зонд `sudo -S -p '' -- true` даёт явный 400 («Неверный sudo-пароль» / «нет прав sudo» / «sudo не установлен»). Ошибки действий: 400 — пользовательские причины (нужен пароль, masked/not-found/job-failed — с текстом systemd как есть), 502 — только транспорт. Follow-журналы (`follow=1`) — через общий лимитер на профиль (`services/stream-limits.ts`, сверх лимита 429) и `createChunkGate` (дроп чанков при `res.writableLength > 1 МБ` с маркером «пропущено N байт»); отказ `journalctl` без прав выглядит как пустой вывод с кодом 0, а не ошибка — UI показывает подсказку про группы `adm`/`systemd-journal`. Sudo для журнала в v1 не делается.
- Терминальные вкладки (эпик 15): сессий на профиль несколько, ключ `profileId::<container|host>::<tabId>` в `ws/terminal.ts`; `tabId` — стабильный id вкладки из WS-query (0..9999, отсутствие → дефолт 0 для старых клиентов, невалидный → `close(1008)`). Лимит — `MAX_TERMINAL_SESSIONS_PER_PROFILE = 4` живых сессий на профиль (бюджет SSH `MaxSessions 10`: SFTP + follow-стримы + транзитные exec'и); сверх лимита — error-фрейм + `close(1013)`. `GET /api/terminal/sessions?profileId=` отдаёт живые сессии `{tabId, container, containerName}` + лимит — UI восстанавливает вкладки после F5/чистки localStorage. Запись сессии удаляется из реестра при выходе из shell (`close` канала → `sessions.delete`) — иначе ключ по вкладке копит записи-призраки. На фронте `close`-фрейм серверу шлётся **только по явному закрытию вкладки пользователем** (✕, ref-флаг): смена профиля размонтирует TerminalPage (`key={profile.id}`), и безусловный close убивал бы все терминалы вместо grace 60 с.
- «Что занимает» (эпик 16, `GET /api/disk-usage` + `/api/disk-usage/files`): команды du/find собирает сервис (`services/disk-usage.ts`) — конвейеры и `2>/dev/null` там допустимы, deny-лист `exec_readonly` их не видит (инструмент агента `disk_usage` — тот же класс, что `security_audit`). `du -x -d 1 -k` (`-k`, а не `-B1` — BusyBox не знает `-B`; парсер умножает на 1024), stderr не глушится — строки отказа доступа дают `incomplete: {unreadable}`, чтобы цифры не выглядели враньём; `-x` не выпускает обход за пределы ФС (вложенные монтирования видны в карточке «Диски» отдельной строкой). Топ файлов: `find -printf` с фолбэком `stat -c '%s<таб>%n'` при незнакомой опции (BusyBox; `needsStatFallback` по stderr — формулировки GNU/BusyBox/BSD разные; эвристика «пустой stdout» не срабатывает при отказах доступа — иначе лишний обход дерева вхолостую). Кэш 2 с на (профиль, путь) только для тяжёлого du, find не кэшируется. Валидация пути — свои `normalizeDiskPath`/`assertNavigablePath` (`assertSafePath` запрещает `/`, а точка монтирования — законный корень навигации). Ошибки: 400 — пользовательские причины, 502 — только транспорт (как в `routes/metrics.ts`); предпроверка пути: `getSftp` вне try (обрыв соединения → 502), `stat` в try (нет пути/прав → 400); таймаут du/find → 400 «Превышено время ожидания (60 с)…», а не 502 (сервер в порядке). Исполнители принимают `deps {execFn?, precheckFn?, skipPrecheck?}` (паттерн systemd.ts) — агент делает одну предпроверку на оба вызова (`skipPrecheck`), тесты мокают exec.
- Действия над процессами (вкладка «Обзор», `/api/processes`, эпик 17): `POST /api/processes/:pid/signal` `{signal: TERM|KILL|HUP, sudoPassword?}` и `POST /api/processes/:pid/renice` `{nice: −20..19, sudoPassword?}`. pid — каноничное целое 2..4194304 (`parsePid`; запрет `0`/`1`/отрицательных обязателен: `kill -TERM -1` кладёт всё, до чего дотянется), сигнал — whitelist-enum, произвольная строка не принимается. Команда `kill -<sig> <pid>` **без `--`** (builtin login-shell по-разному понимает `--`, pid после валидации опцией быть не может); sudo — по схеме эпика 13 через общий зонд `services/sudo.ts` (вынесен из systemd.ts, его же ждёт эпик 19; пароль первой строкой stdin, память одного запроса); категория «утилиты нет на сервере» (BusyBox без `renice`, образ без `/bin/kill` под `sudo --`) → 400, а не 502; после мутации — `invalidateMetricsCache` — refetch «Обзора» и сайдбара сразу свежий. Инструмент агента не заводится (`kill`/`pkill`/`killall` в deny-листе `guard.ts` осознанно).
- Сохранённые команды (эпик 18, раздел «Команды» на странице «Серверы»; `services/snippets.ts` + `routes/snippets.ts`): стор `data/snippets.json` по образцу `db-connections.ts` (zod, tmp+rename, corrupt-guard). `POST /api/snippets/run` — параллельный exec на 1..10 профилях, guard-таймаут 120 с на профиль (`withTimeout` из `util/async.ts`), вывод обрезается до 100 КБ на поток с пометкой `truncated`. **Команда передаётся в exec как есть — без deny-листа и без `shq`**: это ручной инструмент уровня терминала, защита — подтверждение в UI со списком целей, а не фильтрация. Все цели валидируются до первого exec (400 со списком отсутствующих). Секрет в команде сниппета — осознанный риск уровня терминала.
- Службы systemd (вкладка «Службы», `/api/services`, эпик 13): снимок — один exec с маркерами и `LC_ALL=C`, детект systemd по тексту (не по коду); имя unit'а валидируется regex `^[A-Za-z0-9@._:\-]+$` (плюс запрет `.`/`..`) до всего остального. Sudo для действий — **прямая форма `sudo -S -p '' -- systemctl <action> -- <unit>` без `sh -c`**, пароль первой строкой stdin канала (не в argv/логах, живёт в памяти одного запроса, в UI может удерживаться в стейте вкладки без persist); ретрай по access-denied безопасен (мутация не началась), зонд `sudo -S -p '' -- true` даёт явный 400 («Неверный sudo-пароль» / «нет прав sudo» / «sudo не установлен»; зонд и классификация — общий модуль `services/sudo.ts`). Ошибки действий: 400 — пользовательские причины (нужен пароль, masked/not-found/job-failed — с текстом systemd как есть), 502 — только транспорт. Follow-журналы (`follow=1`) — через общий лимитер на профиль (`services/stream-limits.ts`, сверх лимита 429) и `createChunkGate` (дроп чанков при `res.writableLength > 1 МБ` с маркером «пропущено N байт»); отказ `journalctl` без прав выглядит как пустой вывод с кодом 0, а не ошибка — UI показывает подсказку про группы `adm`/`systemd-journal`. Sudo для журнала в v1 не делается.
- Обновления пакетов (эпик 19, `/api/packages`): снимок — детект менеджера (`command -v apt-get||dnf||yum||apk`) + один exec с маркерами (код списка — `@@LIST_CODE@@`, не `result.code`: код всей строки принадлежит последней части; у dnf/yum код 100 = есть обновления, не ошибка; таймаут снимка 30 с); признаки рестарта — apt: наличие `/var/run/reboot-required` (+ `.pkgs`), dnf/yum: `needs-restarting -r` код 1; возраст индекса apt — SFTP-stat (ошибка stat → тихий null); кэш 60 с на профиль + инвалидация после применения. `apt-get update` не запускается (мутация индексов). Применение (`POST /api/packages/apply`) — **только стримом с подтверждением**: зонд `probeSudo` до открытия канала (400 при неверном пароле/правах), команда — прямая sudo-форма без `sh -c` (`env DEBIAN_FRONTEND=noninteractive` для apt), пароль первой строкой stdin, слот общего лимитера follow-стримов (429), на settle — инвалидация кэша. Стрим применения (`LogViewer` `kind='request'`) НЕ завязан на `visible` и не рвётся переключением вкладок — прерывание только по явному закрытию просмотрщика (с подтверждением, пока выполняется) или завершению команды; закрытие «В чат» не прерывает. Инструмента агента для пакетов нет (обновления покрыты секцией `updates` аудита); guard «один запуск на монтирование» защищает от повторной мутации (StrictMode).
- Bootstrap «Новый сервер (root + пароль)» (`services/bootstrap.ts`, план — `docs/bootstrap-plan.md`): жёсткий порядок «сначала ключ — потом sshd» — sshd не трогается, пока вход ключом не доказан отдельным новым подключением; reload только после зелёного `sshd -t`; hardening — drop-in `/etc/ssh/sshd_config.d/00-ssh-commander.conf` (пишем только директивы, которые данный sshd понимает — детект по `sshd -T` до правок; для < 8.7 — `ChallengeResponseAuthentication`), fallback без `sshd_config.d` — бэкап + правка основного конфига; провал после правки → откат через живую password-сессию (обрыв — через key-сессию); «hardening ок, а профиль не создался» — ключ сохраняется с подсказкой, откат не делается; пароль живёт только в памяти запроса — не persist'ится, не логируется, в ошибки не подставляется; ключ — отдельный ed25519 на сервер (`keys/<slug>.ed25519`, 0600, свой энкодер OpenSSH-формата — node:crypto PKCS#8 ssh2 не читает).
- Перед сдачей изменений: `npm run build` в обоих каталогах и `npm test` — зелёные, `npm audit` без уязвимостей.
- Эти проверки автоматизированы хуком `pre-commit` (`scripts/pre-commit.sh`, ставится `bash scripts/install-hooks.sh`): параллельно гоняет `eslint src` в web, `tsc --noEmit` в server, `vitest run` в server и `npm run build` в web (сборка web включает свой `tsc`, поэтому отдельного typecheck web нет). Падает только на ошибках — `exhaustive-deps` остаются предупреждениями. Пропустить разово: `git commit --no-verify`. Проверяется рабочее дерево, а не индекс.

## Тестирование

- `cd server && npm test` — unit-тесты vitest, примерно по одному `*.test.ts` на подсистему (полный состав — `docs/architecture.md`).
- `cd web && npm run lint` — eslint во фронтенде. Заведён ради `react-hooks/rules-of-hooks`: хук, вызванный после раннего `return`, даёт React #310 («Rendered more hooks than during the previous render») уже в браузере — ни `tsc`, ни тесты сервера этот класс не видят (реальный случай: эпик 20, `profileAlerts` в `App.tsx` ниже guard'ов `if (authed === null)`). Тестов у фронтенда нет, линтер — единственная автоматическая защита.
- Ручные сценарии (требуют инфраструктуры, команды запуска — в `docs/architecture.md` и самих файлах):
  - `server/test/integration.manual.mjs` — нужен запущенный сервер (`APP_PASSWORD=test123`) и тестовый sshd (linuxserver/openssh-server на `127.0.0.1:2222`, user `test`).
  - `server/test/agent.manual.mjs` — цикл агента против мокового OpenAI-совместимого endpoint'а.
  - `server/test/multi-server.manual.mjs` + `server/test/mock-openai-manual.mjs` — мульти-серверный режим: мок на :8199 и два sshd-контейнера на :2222/:2223.
  - `server/test/security-audit.manual.ts` — live-прогон аудита против sshd на :2222 с `SUDO_ACCESS=true` (`npx tsx test/security-audit.manual.ts`).
  - `server/test/db.manual.mjs` — вкладка «Базы данных»: контейнеры `postgres:16-alpine` + `postgres:16` (dash) + `mysql:8`, подключения с явными креденшалами, test-connection (в т.ч. неверный пароль), query/dump, частичный update пароля.
  - `server/test/nginx.manual.mjs` — вкладка «Nginx»: SSH-хост с реальным docker (sshd-контейнер с docker.sock или VPS), поднимает `nginx:alpine` с самоподписанным сертификатом; discovery находит контейнер, снапшот содержит сайт, срок сертификата посчитан, `nginx -t` и reload работают.
  - `server/test/bootstrap.manual.mjs` — «Новый сервер (root + пароль)»: сам поднимает sshd-контейнер с root-входом по паролю (docker, команды в шапке); сценарии: откат (Match-блок перекрывает hardening → конфиг восстановлен, пароль снова работает), happy path дважды без hardening (идемпотентность authorized_keys, кросс-чек `ssh-keygen -y` — энкодер ключа совместим с OpenSSH-инструментами), hardening поверх (пароль отклонён, ключ работает).

## Безопасность (кратко)

Сервис однопользовательский: localhost-only, пароль из `APP_PASSWORD`, httpOnly-cookie, rate-limit логина. SSH-пароли лежат открытым текстом в `data/profiles.json`, пароли подключений БД — в `data/db-connections.json` — это осознанный компромисс локального инструмента (тот же trust domain), volume наружу не публиковать. Пароль БД не светится в argv/ps хоста: передаётся первой строкой stdin канала. Мутирующие действия агента никогда не выполняются без подтверждения; deny-лист read-only команд консервативен — лучше отказать, чем пропустить. SSH-туннели: локальный конец слушает на `127.0.0.1` внутри контейнера, доступен любому локальному процессу без авторизации (обходит `APP_PASSWORD`). Для однопользовательской машины приемлемо (как и терминал), но это ослабление модели безопасности — туннель даёт доступ к удалённым сервисам всем, кто может подключиться к `127.0.0.1:<порт>`.
