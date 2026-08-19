# План: мульти-серверный режим агента

Статус: реализовано. Задача — в одной сессии AI-агента работать с несколькими
SSH-профилями (целевой сценарий: «настроил zabbix на сервере A, подключаю к
нему серверы B и C»). Решения и обоснования — в
`docs/multi-server-agent-analysis.md` (развилки №1–№6), здесь только реализация.

## Идея

- Во все SSH-инструменты добавляется необязательный параметр `server` (имя
  профиля; по умолчанию — домашний профиль диалога). Stateless-адресация,
  fan-out достигается батчем tool_calls в одном шаге.
- Область видимости «3b-lite»: `list_servers` (новый read-only инструмент)
  видит все профили, но выполнение инструментов — только на серверах,
  подключённых к диалогу. Подключение: чип «+» в шапке панели или запрос
  агента через инструмент `connect_server` (мутирующий класс — карточка
  «Подключить <сервер> к диалогу?» на том же механизме approve/reject).
- Диалог навсегда привязан к домашнему профилю; дополнительные серверы —
  `extraProfileIds?: string[]` в схеме диалога (обратная совместимость без
  миграции). История фильтруется по домашнему профилю, в списке — бейдж
  «+N серверов».
- Панель агента на фронте — keep-alive на каждый посещённый профиль (образец —
  keep-alive вкладок страниц): переключение профиля не рвёт WS, агент работает
  в фоне. В сайдбаре — индикатор активности агента у профиля (работает / ждёт
  подтверждения), по образцу `status-dot`.
- Подтверждения: карточка на каждый вызов с бейджем сервера; протокол
  approve/reject по callId не меняется.

## Сервер

### 1. `server/src/ai/dialogues.ts` — extraProfileIds

- zod-схема диалога (сейчас `dialogues.ts:48`): добавить
  `extraProfileIds: z.array(z.string()).optional()`.
- Новые функции: `attachProfileToDialogue(dialogueId, profileId)` /
  `detachProfileFromDialogue(dialogueId, profileId)` — обновление записи через
  существующий persist (tmp+rename, corrupt-guard). Домашний `profileId`
  отцепить нельзя (ошибка).
- `listDialogues(profileId)` (108-120) без изменений — фильтр по домашнему.

### 2. `server/src/ai/tools.ts` — схемы инструментов

- Всем SSH-инструментам (`exec_readonly, exec, read_file, list_dir, write_file,
  docker_ps, docker_logs, docker_inspect, docker_action, security_audit`) —
  необязательный параметр `server: string` («имя профиля из list_servers; без
  параметра — домашний сервер диалога»).
- Инструментам памяти (`read_memory`, `write_memory`) — тот же параметр
  `server` (по умолчанию домашний). `memory.ts` уже параметризован profileId —
  меняются только вызовы.
- Новый `list_servers` (без параметров, read-only — добавить в
  `READ_ONLY_TOOLS`): возвращает `[{name, host, port, username, note,
  connected}]` по всем профилям, секреты не отдаёт.
- Новый `connect_server` (параметр `server`, мутирующий класс — в
  `READ_ONLY_TOOLS` НЕ добавлять): семантика «подключить сервер к диалогу»,
  выполняется через стандартный approve.
- `guard.ts` не трогаем: фильтрует команды, а не серверы.

### 3. `server/src/ai/agent.ts` — мульти-профильная сессия

- Вместо `private profile: Profile` (61-65): `homeProfile` +
  `attached: Map<profileId, Profile>` (домашний добавлен всегда).
- `resolveServer(name?: string): Profile | ToolError`:
  - без имени → домашний;
  - точное (потом case-insensitive) совпадение имени среди подключённых;
  - неизвестное имя → ошибка «неизвестный сервер, доступные: …»;
  - известный из `listProfiles()`, но не подключён → ошибка «сервер не
    подключён к диалогу — вызовите connect_server или попросите пользователя».
- `runTool(name, args)`: каждый SSH-инструмент сначала `resolveServer(args.server)`,
  дальше существующие вызовы с найденным профилем (12 мест использования
  `this.profile`, 422-556). Ошибка резолва — обычный `tool_result` с текстом
  ошибки, цикл продолжается.
- `connect_server` в `runTool`: по approve — `attachProfileToDialogue` +
  запись в `attached`; `tool_result` содержит блок памяти подключаемого сервера
  (`memoryPromptBlock(profile.id)`) — так память попадает в контекст лениво, не
  раздувая системный промпт.
- sudo: `sudoPassword` (59) → `Map<profileId, string>`; WS `sudo_credentials`
  получает необязательный `profileId` (по умолчанию домашний). `security_audit`
  берёт пароль целевого сервера. Очистка — в `stop()`/`onWsClose()` как сейчас.
- Системный промпт (67-87): абзац про мульти-серверность — домашний сервер,
  список подключённых, правило «указывай `server` явно при работе не с
  домашним», правило «не путай факты между серверами, в отчётах подписывай
  сервер».
- Реестр сессий остаётся `Map<profileId, …>` (559-588): ключ — домашний
  профиль диалога, модель «одна сессия на профиль» сохраняется.
- `tool_pending` (332) и `tool_result` — новое поле `server` (имя сервера,
  резолвится до отправки; для `connect_server` — имя целевого сервера).
- Проверка диалога в `attachAgent` (572-577): домашний `profileId` совпал;
  `extraProfileIds` подгружаются в `attached` (несуществующие профили
  пропускаются с warning в лог).

### 4. WS-протокол (`server/src/ws/agent.ts` + `handleClientMessage`)

Клиент → сервер:
- `attach_server {profileId}` — ручное подключение чипом «+» (без approve,
  это действие самого пользователя);
- `detach_server {profileId}` — отключение (домашний → 400-ошибка клиенту);
- `sudo_credentials {password, profileId?}`.

Сервер → клиент:
- `servers {home: profileId, attached: [{id, name, host, username}]}` — при
  подключении WS и на каждое изменение (attach/detach/connect_server);
- `tool_pending`/`tool_result` — поле `server` (см. п.3).

### 5. `server/src/routes/ai.ts`

- `GET /api/ai/dialogues?profileId=` — в сводку добавить `extraProfileIds`
  (для бейджа «+N серверов»). Остальное без изменений.

## Фронтенд

### 6. `web/src/App.tsx` — keep-alive панели + индикатор

- Вместо одного `<AgentPage key={activeProfile.id}>` (417-423): панели всех
  посещённых в сессии профилей (`visitedProfileIds: string[]`), каждая
  `key={id}`, неактивные — `display:none` (образец — keep-alive вкладки).
  WS живёт, чат-стейт сохраняется.
- `AgentPage` получает колбэк `onActivity(profileId, state |
  null)`, state ∈ `running | pending`; App держит
  `Map<profileId, state>` и рисует в сайдбаре у `.profile-list-item` точку
  (зелёная пульсирующая — работает, жёлтая — ждёт подтверждения; стиль по
  образцу `status-dot`). `pending` важнее: без него агент молча встанет на
  approve в фоне.

### 7. `web/src/pages/AgentPage.tsx`

- Шапка: чипы подключённых серверов из события `servers` (домашний — первым,
  без крестика; остальные с крестиком → `detach_server`). Кнопка «+» —
  dropdown из `GET /api/profiles` минус подключённые → `attach_server`.
- `ToolCard` (650-737): бейдж сервера из поля `server` событий
  `tool_pending`/`tool_result` (в шапке карточки рядом с именем инструмента).
- Карточка `connect_server` рендерится как «Подключить <сервер> к диалогу?»
  с теми же Подтвердить/Отклонить.
- Модалка «Проверка безопасности» (547-585): селектор сервера из подключённых,
  `sudo_credentials` с `profileId` выбранного.
- История диалогов (405-450): бейдж «+N» у мульти-серверных (из
  `extraProfileIds` сводки).
- «Спросить агента» (`TerminalPage.tsx:179-192` → `App.tsx:68` →
  `AgentPage.tsx:319-332`): в текст авто-сообщения добавлять имя сервера —
  «Объясни этот вывод терминала (сервер <name>): …». Попадает в панель того же
  профиля — привязка сохраняется.

## Тесты и проверка

- `server/test/multi-server.test.ts` (vitest, по образцу `plan.test.ts`):
  `resolveServer` — домашний по умолчанию, точное/case-insensitive имя,
  ошибка с перечнем для неизвестного, ошибка «не подключён» для известного;
  attach/detach в диалоге (домашний не отцепляется); `connect_server` —
  approve подключает, reject нет; маршрутизация `read_memory`/`write_memory`
  по `server`; sudo Map — пароль одного сервера не течёт на другой.
- `dialogues.test.ts`: диалог с `extraProfileIds` валиден, старый JSON без
  поля читается (обратная совместимость), `saveDialogueMessages` поле не
  затирает.
- Ручной сценарий `server/test/multi-server.manual.mjs`: два sshd-контейнера
  (по образцу `integration.manual.mjs`), диалог на первом — `connect_server`
  второго через approve, `exec_readonly` на обоих, отчёт.
- Перед сдачей: `npm run build && npm test` в обоих пакетах, `npm audit`.
- Обновить `AGENTS.md` (мульти-серверность в разделах агента, WS API, UI).

## Дополнение после ребазы на main (эпик веб-поиска)

В main влит эпик 11 (`web_search`, событие `tool_start`). Уточнения к плану:

- `web_search` — сетевой инструмент, к SSH-профилям не привязан: параметр
  `server` ему НЕ добавляется; гейтинг `isSearchConfigured` и лимит
  `MAX_SEARCH_CALLS_PER_RUN` не меняются.
- Событие `tool_start` (`agent.ts:333`) получает поле `server` наравне с
  `tool_pending`/`tool_result` — карточка «выполняется…» тоже с бейджем
  сервера.
- `plan.ts` затронут веб-поиском (`toolsForRequest`) — мульти-серверность его
  по-прежнему не касается.

## Намеренно выброшенное (можно добавить потом)

- Серверный detach/reattach сессии (пережить перезагрузку вкладки: `ws close`
  ≠ `stop()`, снапшот состояния при переподключении, TTL на висящие
  подтверждения). Отдельный эпик по образцу терминальных сессий.
- Групповые карточки подтверждений («применить на всех серверах»).
- Показ мульти-серверного диалога в истории каждого задействованного профиля.
- Параллельное выполнение read-only батча (сейчас цикл последовательный).
- Fan-out синтаксис `server: "all"` (достигается батчем tool_calls).

## Затронутые файлы

| Файл | Изменение |
|---|---|
| `server/src/ai/dialogues.ts` | `extraProfileIds` в схеме, attach/detach-функции |
| `server/src/ai/tools.ts` | параметр `server` в 12 инструментах, `list_servers`, `connect_server` |
| `server/src/ai/agent.ts` | мульти-профильная сессия, `resolveServer`, sudo Map, промпт, `server` в событиях |
| `server/src/ws/agent.ts` | `attach_server`/`detach_server`, `profileId` в `sudo_credentials` |
| `server/src/routes/ai.ts` | `extraProfileIds` в сводке диалогов |
| `web/src/App.tsx` | keep-alive панели, индикатор активности в сайдбаре |
| `web/src/pages/AgentPage.tsx` | чипы серверов, бейджи в ToolCard, sudo-модалка, бейдж в истории |
| `web/src/pages/TerminalPage.tsx` | имя сервера в «Спросить агента» |
| `server/test/multi-server.test.ts` | новые unit-тесты |
| `server/test/dialogues.test.ts` | обратная совместимость схемы |
| `server/test/multi-server.manual.mjs` | ручной сценарий с двумя sshd |
| `AGENTS.md`, `docs/roadmap.md` | актуализация описаний |
