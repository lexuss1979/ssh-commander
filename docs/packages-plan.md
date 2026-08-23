# План: эпик 19 — обновления пакетов

> Эпик 19 из `docs/roadmap.md` (Tier 3): видеть, что на сервере есть
> обновления и нужен ли рестарт, не заходя в терминал; применение — с
> подтверждением и живым выводом.
> Статус: план, ожидает согласования. Дата плана: 2026-08-23.
> Сервер + фронтенд. Новых зависимостей нет. **Read-only часть и применение —
> отдельными коммитами** (решение roadmap: read-only полезна сама по себе,
> применение несёт риск).

## Контекст: что уже есть

- `exec` (`ssh/manager.ts`): таймаут 60 c по умолчанию, лимит 2 МБ
  раздельно на stdout/stderr. `execStream(profile, command, onChunk)` —
  стрим для follow-транспорта (docker-логи, tail, journalctl), **stdin не
  принимает** — для подачи sudo-пароля в `sudo -S` нужен опциональный
  `stdin` (расширение, см. шаг 0).
- Стримовый транспорт эталонно сделан в эпике 14/13: слоты
  `services/stream-limits.ts` (3 на профиль суммарно, 429),
  backpressure `createChunkGate` (`services/chunk-gate.ts`, маркер
  «пропущено N байт», `finish()`), `req.on('close')` → `handle.close()`,
  слот снимается идемпотентно на любом пути завершения (роут `/tail` в
  `routes/files.ts:291` — эталон формы).
- Sudo-паттерн (эпик 13): прямая форма `sudo -S -p '' -- <cmd>` без
  `sh -c`, пароль первой строкой stdin канала; зонд `sudo -S -p '' -- true`
  с классификацией `classifySudoProbe` (неверный пароль / не в sudoers /
  sudo не установлен) — живёт в `services/systemd.ts:359-420`; в
  `security-audit.ts:330` — упрощённый вариант (код 0). Для пакетов нужна
  классификация из systemd — **третий потребитель паттерна → вынести в
  общий модуль** (прецедент выноса `stream-limits` в эпике 14).
- Просмотрщик живого вывода — `web/src/components/LogViewer.tsx`:
  `buildUrl(follow)` (GET fetch + reader), кольцевой буфер 5000 строк,
  фильтр, «В чат» (`mode: 'send'`), «Переподключиться» на
  error/stopped. **Для применения нужен POST-стрим + защита от случайного
  перезапуска мутации** — расширение `buildRequest`/`oneShot` (шаг 3).
- Кэш-паттерн 2 с (`metrics.ts`) — для пакетов TTL 60 с (список меняется
  редко, команда не мгновенная, roadmap); инвалидация после применения как
  `invalidateServicesCache` у systemd.
- `OverviewPage` — polling раз в 3 c (`fetchMetrics` + `fetchMetricsHistory`
  одним тиком, `Promise.allSettled`, тихие ошибки истории) — туда же
  встанет `fetchPackages`; бейдж/карточка и раздел списка.
- Deny-лист `guard.ts` запрещает агенту `apt`/`dnf` и пр. — инструмент
  агента для пакетов НЕ заводим (roadmap не просит; у агента обновления
  уже покрыты секцией `updates` аудита `security_audit`).

## Шаг 0. Две маленькие инфраструктурные правки (отдельные коммиты, без изменения поведения)

**0a. `execStream`: опциональный `stdin`** (`manager.ts:168`).

Сигнатура: `execStream(profile, command, onChunk, opts: { stdin?: string } = {})`.
В колбэке `client.exec` после прикрепления data-обработчиков (и проверки
`closed`):

```ts
if (opts.stdin !== undefined) {
  ch.write(opts.stdin);
  ch.end(); // EOF — sudo прочитал строку, команда получает stdin-EOF
}
```

Паттерн `exec` (`manager.ts:110`): пароль — только stdin канала, не в argv.
`apt-get -y`/`dnf -y`/`apk` stdin не читают — EOF безопасен. Расширить
`server/test/exec-stream.test.ts`: мок-канал записывает переданный stdin и
зовёт `end()`; чанки stdout доходят как раньше.

**0b. Общий модуль `server/src/services/sudo.ts`.**

Перенести из `systemd.ts` зонд и классификацию: `sudoProbeCommand()` +
`classifySudoProbe` (и типы `SudoProbeResult`) + новая обёртка
`probeSudo(profile, password): Promise<SudoProbeResult>` (exec
`sudo -S -p '' -- true` со `stdin: ${password}\n`). `systemd.ts`
переключается на импорт из `sudo.ts` — поведение не меняется, тесты
`systemd.test.ts` остаются зелёными (они уже покрывают классификацию).
`security-audit.ts` не трогаем: ему нужен только код 0 (мягкая деградация).
Обоснование выноса — как у `stream-limits` в эпике 14: третьему потребителю
(пакеты) не импортировать чужую подсистему (`routes/packages.ts` не должен
знать про systemd).

## Решение

### 1. Сервис `server/src/services/packages.ts` (read-only часть)

Константы: `PACKAGES_CACHE_TTL_MS = 60000`, `PROBE_TIMEOUT_MS = 15000`.

Чистые функции (все под unit-тесты):

- `detectPmCommand()` — статическая строка
  `command -v apt-get || command -v dnf || command -v yum || command -v apk`.
  `parsePmDetection(text)` — первая непустая строка → basename пути →
  `'apt' | 'dnf' | 'yum' | 'apk' | null`.
- `listUpdatesCommand(pm)`:
  - apt: `apt list --upgradable`;
  - dnf/yum: `dnf -q check-update` / `yum -q check-update`;
  - apk: `apk version -l '<'` (кавычки — статическая строка, shell их
    съест; apk принимает литерал `<`).
- `isUpdatesExitCode(pm, code)` — **код 100 у dnf/yum = есть обновления,
  не ошибка** (roadmap): `pm === 'dnf' || pm === 'yum'` → `code === 0 ||
  code === 100`; apt/apk → `code === 0`.
- Парсеры:
  - `parseAptList(text)` — строки `name/suite version arch [upgradable
    from: current]`: name — до первого `/` (имена могут содержать `+`, `-`,
    цифры; suite — `stable-security`, `jammy-updates`, без `/`), version =
    token[1] (доступная), current — из скобки `/from:\s*(.*)]/` (нет скобки
    → null). Строки-заголовки/мусор (`Listing…`, без `/`) пропускаются.
    **WARNING apt про нестабильный CLI приходит в stderr — парсер stdout
    его не видит** (фикстура в тесте: stderr игнорируется на уровне сервиса).
  - `parseDnfCheckUpdate(text)` — `name.arch version repo` (3 токена;
    name.arch оставляем как есть, не расщепляем — колонка «Пакет» и так
    читается); current = null (check-update не показывает установленную —
    отклонение от строки roadmap «текущая → доступная», см. «Отклонённые»);
    строки короче 3 токенов пропускаются.
  - `parseApkVersionLt(text)` — строки `name-version < name-version`
    (справа может быть только версия — фикстура с реального вывода):
    `^(.+)-(\d[^-]*)\s*<\s*(.+)$` — имя до последнего дефиса с цифровым
    хвостом (`alpine-baselayout-3.4.3-r1` → name `alpine-baselayout`,
    current `3.4.3-r1`), available — правая часть. **Многострочные записи**
    (roadmap): строка без `<` — продолжение имени предыдущей записи
    (аппендим). Строки без совпадения и без предыдущей записи — пропуск.
- Признаки рестарта (в том же exec, маркером — паттерн `metrics.ts`):
  - `rebootCheckSuffix(pm)`:
    - apt: `echo '@@REBOOT@@'; if [ -f /var/run/reboot-required ]; then cat /var/run/reboot-required.pkgs 2>/dev/null; fi` — маркер печатается **только** при существующем файле;
    - dnf/yum: `echo '@@REBOOT@@'; if command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r; echo "@@RESTART_CODE@@$?"; fi` — код 1 = нужен рестарт (0 = нет; иное — считаем «нет», вывод остаётся информационным);
    - apk: без суффикса (конвенции нет, `rebootRequired: false`).
  - Полная команда снимка: `listUpdatesCommand(pm) + rebootCheckSuffix(pm)`
    (одним exec — детект менеджера отдельным, см. ниже).
  - `parseRebootSection(text)` — раздел после `@@REBOOT@@`: `{code: number |
    null, packages: string[]}`; код из `@@RESTART_CODE@@N`; `rebootRequired`
    считается в сборке снимка (apt: раздел есть; dnf/yum: code === 1).
- Возраст индекса apt — **через SFTP stat** (не exec): mtime
  `/var/lib/apt/periodic/update-success-stamp` → `indexAgeMs =
  Date.now() - mtime*1000`; файла нет (ENOENT) → `null` («индекс не
  обновлялся»). Только для apt; для dnf/yum/apk — `null` (нет конвенции).

Сборка снимка `collectPackagesSnapshot(profile)`:

1. `exec(detectPmCommand())` → PM; не определён → снимок
   `{pm: null, error: 'Менеджер пакетов не найден (apt/dnf/yum/apk)',
   updates: [], rebootRequired: false, ...}` — не ошибка (заглушка в UI).
2. `exec(listUpdatesCommand(pm) + rebootCheckSuffix(pm))` — код по
   `isUpdatesExitCode`; иначе Error со stderr. Парсинг списка + reboot-секции.
   Дедуп пакетов по имени (первое вхождение).
3. apt → `withSftp` stat индекса (ошибка stat, кроме ENOENT, → тихий `null`).
4. Кэш 60 с на профиль (паттерн `collectMetrics`, ошибочный промис из кэша
   удаляется) + `invalidatePackagesCache(profileId)` для вызова после
   применения (как `invalidateServicesCache`).

Снимок:
```ts
interface PackagesSnapshot {
  timestamp: number;
  pm: 'apt' | 'dnf' | 'yum' | 'apk' | null;
  updates: { name: string; current: string | null; available: string; source: string | null }[];
  rebootRequired: boolean;
  rebootPackages: string[];
  indexAgeMs: number | null;
  error?: string;
}
```
(`source` — suite/repo для колонки «Источник».)

### 2. Маршруты `server/src/routes/packages.ts`

Монтирование: `app.use('/api/packages', requireAuth, packagesRouter)` в
`src/index.ts`.

- `GET /api/packages/updates?profileId=` — снимок (кэш 60 с): 404
  неизвестный профиль, 502 транспорт, 200 с `pm: null` при отсутствии
  менеджера.
- `POST /api/packages/apply?profileId=` — тело `{sudoPassword?: string}`
  (zod: `z.string().max(1024).optional()`, как в `routes/services.ts:49`):
  1. `requireProfile` → 404; детект PM заново (`detectPackageManager` —
    свежий, не из кэша); нет PM → 400.
  2. Сборка команды: `buildApplyCommand(pm, withSudo)` — прямая sudo-форма
    **без `sh -c`** (инвариант эпика 13):
    - apt: `sudo -S -p '' -- env DEBIAN_FRONTEND=noninteractive apt-get -y upgrade`
      / без sudo: `apt-get -y upgrade` (`env` — чтобы dpkg-промпты не
      зависли на EOF-stdin; статическая строка);
    - dnf: `… dnf -y upgrade`; yum: `… yum -y upgrade`;
    - apk: `… apk upgrade`.
  3. Передан пароль → **зонд до стрима**: `probeSudo(profile, password)`
    (шаг 0b) → `wrong-password` → 400 «Неверный sudo-пароль»,
    `not-in-sudoers` → 400 «нет прав sudo», `sudo-not-found` → 400 «sudo
    не установлен», `other` → 502; `ok` → далее. Зонд даёт явный 400 до
    открытия канала — как у systemd, а не поток sudo-ошибок в теле.
  4. `acquireFollowSlot(profileId)` → 429 (общий лимитер — применение
    долгоживущий канал, как follow-стрим); `flushHeaders` (`text/plain`,
    `Cache-Control: no-cache`); `execStream(profile, cmd, onChunk,
    {stdin: password ? `${password}\n` : undefined})` через
    `createChunkGate(res)` (оба потока — stdout и stderr — в одно тело,
    без префиксов: apt и так смешивает). Слот снимается идемпотентно на
    settle `handle.code` и `req.on('close')` → `handle.close()` (эталон
    `/tail`, `routes/files.ts:324-369`).
  5. На settle — `invalidatePackagesCache(profileId)` (список после
    применения устарел). Служебные ошибки канала после `flushHeaders` — в
    теле как строки (тот же транспорт, что у tail).
  - Пароль: только в памяти запроса и stdin канала — не логируется, не
    сохраняется, в argv не попадает.

### 3. Фронтенд: бейдж + раздел на «Обзоре», применение

**Расширение `LogViewer.tsx`** (минимальное, обратно совместимое):

- Новый проп `buildRequest?: (follow: boolean) => { url: string; init?:
  RequestInit }` — при наличии используется вместо `buildUrl` (fetch с
  `credentials: 'same-origin'` + `signal` + `init`). Нужен для POST-стрима
  применения (пароль — в теле, не в URL).
- Новый проп `oneShot?: boolean` — для мутирующих разовых стримов:
  чекбокс «Следовать» скрыт (follow принудительно false), кнопка
  «Переподключиться» скрыта (перезапуск = повторное выполнение мутации —
  опасно), текст статуса по завершении — «завершено» вместо «остановлено».
  Стрим стартует по `visible` (открытие модалки), закрытие модалки →
  abort → `req.close` → сервер закрывает канал (удалённый apt-get
  прерывается) — в подтверждении предупредить.

**`OverviewPage.tsx`:**

- В тик polling добавить `fetchPackages(profile.id)` (`Promise.allSettled`,
  ошибки тихие, как у истории).
- Карточка «Обновления» в `overview-grid`: счётчик («N обновлений»),
  менеджер, возраст индекса («индекс обновлён N дн назад» / «индекс не
  обновлялся»), предупреждение «нужен рестарт» (danger-стиль, список
  пакетов в title), кнопка «Обновить всё», кнопка «Список» (скролл к
  разделу). Нет менеджера/ошибка → muted «обновления не проверяются».
- Раздел «Доступные обновления» под гридом: таблица Пакет / Текущая →
  Доступная («— → версия» для dnf) / Источник; пусто — «обновлений нет».
- «Обновить всё»: confirm-модалка — предупреждение «Обновление может
  перезапустить службы и оборвать SSH-соединение (sshd/ядро); закрытие
  окна вывода прервёт обновление» + поле sudo-пароля (появляется всегда —
  применение требует root; пусто → команда без sudo, ошибка прав уйдёт в
  вывод) → «Запустить». После — модалка с `LogViewer`
  (`buildRequest` → POST `/api/packages/apply` c `sudoPassword`,
  `oneShot`, `logPath` = имя команды — «В чат» соберёт «Объясни этот вывод
  лога apt-get upgrade…», `serverName` = profile.name). По закрытии —
  refetch пакетов (серверный кэш уже сброшен инвалидацией).
- CSS: `.packages-*` (карточка, бейдж рестарта, строка таблицы) на
  переменных; `scrollbar-gutter: stable` в новых скролл-областях.

### 4. `src/api.ts`

Типы `PackagesSnapshot`/`PackageUpdate`, `fetchPackages(profileId)`,
`packagesApplyRequest(profileId, sudoPassword): {url, init}` (POST, JSON-тело).

## Отклонённые альтернативы

- **`apt-get update` перед проверкой** — мутация индексов и требует прав;
  roadmap прямо запрещает; вместо этого возраст индекса в UI («картина
  устаревшая — отсюда возраст индекса»).
- **`dnf list --upgrades` вместо `check-update`** — roadmap фиксирует
  `check-update` с кодом 100; у него нет установленной версии → для dnf
  колонка «текущая» пустая («— → версия»). Показать обе версии у dnf —
  отдельный шаг (лишний exec на установленные пакеты), отложен.
- **sudo-зонд в потоке (без предварительного)** — пришлось бы отдавать
  200 и поток sudo-ошибок в теле; зонд до стрима даёт явный 400 (паттерн
  systemd).
- **Отдельный просмотрщик применения вместо расширения LogViewer** —
  дублирует буфер/автоскролл/фильтр/«В чат»; `buildRequest` + `oneShot` —
  два маленьких пропа, обратно совместимых.
- **Инструмент агента для пакетов** — roadmap не просит; у агента
  обновления уже есть в секции `updates` аудита; `apt`/`dnf` в deny-листе
  `exec_readonly` не ослабляем.
- **Вывод применения в память/буфер** — долгий вывод только стрим
  (chunk-gate), не буфер (roadmap).

## Тесты

`server/test/packages.test.ts` (новый):

- `parseAptList`: нормальные строки (имя с `+`/`-`, suite с дефисом,
  i386), `[upgradable from:]`, отсутствие скобки → current null, пустой
  вывод («нет обновлений»), заголовок `Listing…` пропускается, WARNING
  apt (stderr-фикстура) не влияет на парсер stdout;
- `parseDnfCheckUpdate`: нормальные, пустой вывод, строки короче 3 токенов,
  имена с точками;
- `parseApkVersionLt`: однострочные, многострочный перенос (продолжение
  имени), имена с дефисами (`alpine-baselayout-3.4.3-r1`), версия без
  `-r`-суффикса;
- `isUpdatesExitCode`: dnf 100 → ок, dnf 0 → ок, dnf 1 → нет, apt 0 → ок,
  apt 100 → нет;
- `parseRebootSection`: маркер есть/нет, `@@RESTART_CODE@@1`, список
  пакетов `.pkgs`;
- `parsePmDetection`: apt-путь, пустой вывод → null;
- `buildApplyCommand`: sudo-прямая форма без `sh -c` для всех PM
  (`sudo -S -p '' -- env DEBIAN_FRONTEND=noninteractive apt-get -y
  upgrade` и т.д.), plain-варианты без пароля, статические строки без
  интерполяции пользовательского ввода;
- кэш: TTL 60 с, инвалидация, ошибочный промис удаляется.

`server/test/exec-stream.test.ts` (расширить, шаг 0a): stdin пишется в
канал + `end()` вызывается; чанки stdout после этого доходят.

`server/test/systemd.test.ts` (шаг 0b): остаётся зелёным после выноса
`sudoProbeCommand`/`classifySudoProbe` в `services/sudo.ts` (тесты уже
покрывают классификацию — перенос без изменения текстов).

Ручной сценарий (стенд: сервер + sshd; apt-контейнер и, если есть,
dnf/alpine):

- после `apt-get update` на стенде список обновлений в разделе, возраст
  индекса в карточке;
- бейдж/карточка на «Обзоре» приходят тем же тиком, что метрики;
- dnf-сервер (или мок вывода): код 100 не трактуется ошибкой, счётчик
  верный;
- `touch /var/run/reboot-required` → предупреждение «нужен рестарт» +
  список из `.pkgs`;
- «Обновить всё» с верным sudo-паролем → живой вывод в просмотрщике,
  после завершения список обновлений обновился (инвалидация кэша);
- неверный пароль → toast «Неверный sudo-пароль» (зонд до стрима);
- без пароля на сервере без passwordless-sudo → в выводе ошибка прав,
  статус завершён;
- закрытие просмотрщика посреди применения прерывает apt-get (канал
  закрыт), повторный запуск возможен;
- четвёртый одновременный follow-стрим (tail + journalctl + apply) → 429;
- сервер без менеджера пакетов → карточка «не проверяются», не ошибка.

## Риски

- **Устаревшая картина без `apt-get update`** — возраст индекса в UI
  (roadmap); список может быть пустым при свежем индексе — так и есть.
- **Обновление может утащить sshd/сеть/ядро** — предупреждение в
  подтверждении; `ssh/manager.ts` авто-переподключится после обрыва, но
  применение может прерваться — честный статус в выводе.
- **`needs-restarting -r` и коды** — семантика кода варьируется по
  версиям yum-utils/dnf-utils; трактуем 1 = рестарт нужен, иное — нет,
  вывод остаётся в логе как информация.
- **`DEBIAN_FRONTEND=noninteractive`** — конфиг-промпты dpkg примут
  дефолт (не зависнут на EOF-stdin); задокументировать в UI-подсказке
  подтверждения.
- **apt CLI нестабилен** (WARNING в stderr) — парсер не полагается на
  stderr; сбой проявится кодом возврата.
- **Долгий вывод применения** — chunk-gate дропает середину с маркером
  при медленном читателе (просмотрщик с кольцевым буфером это переживает);
  полный протокол — в терминале.
- **Применение не живёт без открытого просмотрщика** — закрыл модалку →
  канал закрыт → apt-get прерван; честное поведение v1, как у
  follow-стримов.

## Затрагиваемые файлы

- server: новый `src/services/packages.ts`, новый `src/services/sudo.ts`
  (шаг 0b), новый `src/routes/packages.ts`, `src/index.ts` (монтирование),
  `src/ssh/manager.ts` (шаг 0a — `execStream` stdin), `src/services/systemd.ts`
  (шаг 0b — импорт из `sudo.ts`);
- server/test: новый `packages.test.ts`; расширить `exec-stream.test.ts`;
  `integration.manual.mjs` (сценарий обновлений);
- web: `src/components/LogViewer.tsx` (`buildRequest`, `oneShot`),
  `src/pages/OverviewPage.tsx`, `src/api.ts`, `src/styles.css`;
- docs по сдаче: `AGENTS.md` (маршруты, `execStream` stdin, sudo.ts,
  инвариант «применение только стримом с подтверждением»),
  `docs/architecture.md` (раздел подсистемы), `docs/roadmap.md` (пометка
  «Реализовано»).

Без изменений: WS-протокол, агент, env, docker-compose, зависимости,
`security-audit.ts` (своя упрощённая проверка sudo остаётся).

## Проверки

- `cd server && npm run build && npm test`, `cd web && npm run build`,
  `npm audit` в обоих — зелёные (правила «перед сдачей»);
- шаг 0 — зелёный отдельно (правки транспорта без изменения поведения);
- ручной сценарий из раздела «Тесты».

## Оценка

~1.25 дня: шаг 0 ~0.25 (stdin execStream + вынос sudo.ts), read-only часть
~0.5 (детект, парсеры, снимок, кэш, карточка/раздел на «Обзоре» — коммит
1), применение ~0.5 (маршрут со зондом и стримом, расширение LogViewer,
модалка — коммит 2). Roadmap оценивает ~1 день (read-only ~0.5) — плюс
шаг 0 и интеграция применения, отсюда 1.25.
