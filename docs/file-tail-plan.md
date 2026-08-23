# План: эпик 14 — живой просмотр логов (`tail -F`)

> Эпик 14 из `docs/roadmap.md` (Tier 1, идёт первым среди 13–20: компонент
> просмотрщика переиспользуют эпик 13 — журнал unit'а — и эпик 19 — вывод
> обновления пакетов). Статус: спланирован, ожидает реализации. Дата плана:
> 2026-08-23, правка после ревью в тот же день (шаг 0 — баг `execStream`,
> backpressure, бюджет SSH-каналов, «В чат» через `mode: 'send'`);
> правка 2 — лимитер follow-стримов вынесен в отдельный модуль
> `services/stream-limits.ts` (его переиспользует эпик 13 для журнала
> unit'а; внутри `file-tail.ts` он был бы чужим импортом в
> `routes/services.ts`).
> Сервер + фронтенд, новых зависимостей нет.

## Контекст: что уже есть

- `execStream` (`server/src/ssh/manager.ts:161`) — стрим stdout/stderr-чанков
  команды, возвращает `{code, close()}`. **Содержит баг — см. шаг 0**:
  follow-транспорт на нём currently сломан.
- Маршрут `/api/docker/containers/:id/logs` (`server/src/routes/docker.ts:83`)
  — эталон формы ответа: `follow` → chunked `text/plain` +
  `flushHeaders` + `req.on('close') → handle.close()`; без follow →
  разовый `exec` и обычный ответ. Новый маршрут наследует форму, но не
  букву — чтение `handle.code` до починки шага 0 воспроизводит баг.
- Фронтенд-паттерн потребления — `LogsModal` (`web/src/pages/DockerPage.tsx:660`):
  `fetch` + `res.body.getReader()`, кольцевая обрезка буфера по границе
  строки, пауза по `visible`, рестарт с чистым буфером при смене follow.
- `FilesPage` — единственная контентная страница без пропа `visible`
  (`App.tsx:427` его не передаёт) и без `onAskAgent`.
- Профили (`server/src/profiles.ts`): zod-схема, атомарный persist
  tmp+rename, частичное обновление секретов в `updateProfile` (непереданное
  сохраняется из существующего) — тот же механизм применим к `logPaths`.
- «В чат» — `agentRequest`/`handleAskAgent` в `App.tsx:222`: раскрывает
  панель агента. Режим `'send'` (`types.ts:6`, `AgentPage.tsx:530`) —
  «текст уже собран отправителем и не оборачивается»; появился для
  SQL-консоли, идеально подходит и для логов.
- `normalizePath` — **локальный** хелпер `routes/files.ts:32`, не общий
  util. Маршрут `/tail` живёт в том же файле и пользуется им там же;
  сервис `file-tail.ts` его не импортирует.

## Шаг 0. Починка `execStream` (блокер, отдельный коммит)

**Баг.** `execStream` возвращает хэндл с заглушкой `code:
Promise.resolve(null)`, а настоящий промис присваивается свойству позже —
внутри асинхронного колбэка `client.exec` (`manager.ts:202`). Потребитель
(`routes/docker.ts:114`) читает `handle.code` синхронно и вешает `.then`
на **уже зарезолвленную заглушку**: `res.end()` срабатывает на ближайшем
микротаске, до первого чанка (сетевой round-trip до `client.exec`
гарантированно дольше). Follow-режим docker-логов отдаёт пустое тело; 
далее живой канал пишет в закрытый `res` (write after end) — это и есть
источник «известного бага с утечкой канала `docker logs -f`» из roadmap.

**Правка** (`manager.ts`, формат хэндла не меняется):

```ts
let resolveCode!: (v: number | null) => void;
const handle: ExecStreamHandle = {
  code: new Promise<number | null>((r) => { resolveCode = r; }),
  close: () => { /* как сейчас */ },
};
```

`resolveCode` вызывается на **всех** терминальных путях, не только
`ch.on('close')`:

- ветка `if (err)` у `client.exec` (сейчас только `onChunk(ошибкой)`,
  промис остаётся заглушкой… после починки — висит вечно): `resolveCode(null)`;
- ветка `if (closed)` (close() до открытия канала): `resolveCode(null)`
  явно, не полагаясь на события закрытого канала;
- `.catch` у `getClient` (SSH не подключился): `resolveCode(null)`;
- `ch.on('close')` — exit code, как сейчас;
- `channel.on('error')` — `resolveCode(null)` (идемпотентно, повторный
  resolve безвреден; ssh2 обычно шлёт close после error, но не полагаемся).

Ошибочные пути резолвят `null` (код неизвестен), не делают reject —
функция никогда не бросает и промис всегда settle'ится.

**Регресс-тест** (`server/test/exec-stream.test.ts`): `vi.mock('ssh2')`
фальшивым `Client` (EventEmitter: `connect` → async `ready`, `exec(cmd,
cb)` → фейковый канал-EventEmitter с `close()`), т.к. `execStream`
зависит от реального `getClient`:

1. гонка: `code` не settle'ится до эмуляции `close` канала (проверка
   флагом после микротасков/таймеров) — падает на старом коде;
2. ошибка `client.exec` → `code` резолвится в `null`;
3. `getClient` reject (client эмитит `error`) → `code` резолвится в
   `null`, не висит.

**Побочный эффект — чинит follow docker-логов**: записать в коммит-месседж
и в `docs/architecture.md` явно, иначе изменение поведения соседней
вкладки выглядит неожиданным. После правки нормальный порядок: req close →
`handle.close()` → `ch.close()` → `code` settle → `res.end()`.

## Решение

### 1. Сервис `server/src/services/file-tail.ts`

Константы: `TAIL_DEFAULT_LINES = 500`, `TAIL_MAX_LINES = 5000`,
`TAIL_ONCE_TIMEOUT_MS = 30000`, `BINARY_SNIFF_LEN = 512`,
`GATE_LIMIT_BYTES = 1 МБ` (backpressure). Лимит follow-стримов живёт не
здесь, а в `services/stream-limits.ts` (см. 1a).

Чистые функции (все — под unit-тесты):

- `clampTailLines(n: number): number` — целое, 1..5000.
- `buildTailOnceCommand(path, lines)` → `tail -n N -- <shq(path)>`;
  `buildTailFollowCommand(path, lines)` → `tail -n N -F -- <shq(path)>`.
  Именно `-F`, не `-f`: следит за именем и переживает ротацию
  (logrotate «mv + create»). `--` защищает от имён с ведущим дефисом,
  `shq` экранирует остальное.
- `assertNotDirectory(mode: number)` — бросает «Это директория» для
  `0o040000` (тот же расчёт битов, что в `/api/files/read`).
- `looksBinary(head: Buffer)` — NUL-байт в первых байтах → бинарный;
  аргумент именно `Buffer`, без рассуждений о кодировке.
- `createChunkGate(limitBytes)` — backpressure-гейт для follow-ветки:
  `push(chunk): string | null` — пока потребитель успевает, возвращает
  чанк как есть; когда просрочено — копит пропущенные байты и после
  возврата в норму отдаёт маркер `\n… [пропущено N байт — читатель не
  успевает] …\n`. Чистый класс в сервисе, под юнит-тест.

Предпроверка перед стартом (сервисная `precheckTailable(profile, path)`):
`withSftp(stat)` → `assertNotDirectory`; `readRange(sftp, path, 0, 512)` →
`looksBinary` → ошибка «Файл бинарный — просмотр логов недоступен». Обе
проверки — **до** `flushHeaders`, чтобы отказ шёл обычной JSON-ошибкой.
Обязательно ещё и потому, что `tail -F` на отсутствующем файле не падает,
а молча ждёт его появления — вечный пустой стрим вместо ошибки; stat это
закрывает (несуществующий путь → ошибка SFTP «stat failed»/No such file).

Для снифа бинарности — новый промис-враппер `readRange(sftp, path, start,
end)` в `ssh/sftp.ts` поверх `createReadStream({start, end})`: инвариант
«SFTP — только обёртки из sftp.ts», и не тащим мегабайты через `readFile`.

### 1a. Модуль `server/src/services/stream-limits.ts` — слоты follow-стримов

Отдельный модуль, а не часть `file-tail.ts`: ресурс общий (SSH-каналы
одного соединения на профиль), и эпик 13 берёт тот же счётчик для
`journalctl -f`, а `routes/services.ts` не должен импортировать что-либо
из файловой подсистемы.

- `FOLLOW_STREAM_LIMIT = 3` — одновременных follow-стримов **на профиль**,
  суммарно по всем подсистемам (tail файлов, журнал unit'а из эпика 13,
  далее — вывод обновлений из эпика 19). Обоснование числа — «Бюджет
  SSH-каналов» ниже.
- `createFollowLimiter(max: number)` — фабрика реестра
  `Map<profileId, count>` с `acquire(key): boolean` / `release(key)` /
  `count(key)`; `release` удаляет ключ при нуле. Фабрика — для тестов.
- Инстанс уровня модуля + тонкие обёртки `acquireFollowSlot(profileId)`
  / `releaseFollowSlot(profileId)` — то, чем пользуются роуты.
- Сообщение отказа общее для подсистем: «Слишком много открытых стримов
  логов (максимум 3) — закройте другие просмотрщики».

### 2. Маршрут `GET /api/files/tail` (`server/src/routes/files.ts`)

`?profileId=&path=&lines=&follow=1`, query — zod-схемой по образцу
`/search` (`z.coerce.number()` для lines). Путь — локальная
`normalizePath` + `assertSafePath` (паттерн `download-dir`). Монтирование
не меняется — роутер `/api/files` уже висит с `requireAuth`.

- **follow=0** (разовый снимок): precheck → `exec` разовой команды,
  таймаут 30 с; `code !== 0` → 400 `{error: stderr}` (нет прав, путь
  пропал между stat и tail); иначе `text/plain; charset=utf-8`,
  `stdout || '(логов нет)'`. Предел `exec` — 2 МБ: если `stdout`
  упёрся в лимит (длинные JSON-строки, 5000 строк могут весить больше),
  дописать хвостовую пометку `… (вывод обрезан по лимиту 2 МБ)` —
  молчаливая обрезка хуже честной.
- **follow=1**: precheck → `acquireFollowSlot(profileId)` (1a), при отказе —
  429 `{error: 'Слишком много открытых стримов логов (максимум 3) — закройте другие просмотрщики'}` →
  заголовки `text/plain` + `Cache-Control: no-cache` + `flushHeaders` →
  `execStream(buildTailFollowCommand(…))`; чанки — через
  `createChunkGate` (backpressure, см. ниже); `handle.code` settle
  (любой путь — гарантия шага 0) → `res.end()`; `req.on('close')` →
  `handle.close()`. `releaseFollowSlot(profileId)` вызывается в **обоих**
  местах, идемпотентно через локальный флаг — инвариант: слот снимается на
  любом пути завершения, включая ошибку до открытия канала (иначе 3
  неудачных коннекта запирают стримы до рестарта).

**Backpressure.** `res.write()` без проверки `drain` и без паузы
SSH-канала: `tail -F` на быстро растущем файле при медленном читателе
распухит буфером Node. Пауза канала потребовала бы расширения API
`execStream` наружу — отклонено; вместо этого `createChunkGate`: при
`res.writableLength > 1 МБ` чанки дропаются с подсчётом, при возврате в
норму пишется маркер «пропущено N байт». Для просмотрщика с кольцевым
буфером 5000 строк потеря ретранслируемой середины — честная цена.

**Служебные сообщения в теле — сознательно.** Ошибки открытия канала
(например, исчерпан `MaxSessions` сервера: «Channel open failure» /
«administratively prohibited») `execStream` доставляет через `onChunk`
stderr уже после `flushHeaders` — в теле ответа со статусом 200, как
строка лога. С выбранным транспортом иначе никак; статус 'stopped' в UI
после settle `code` показывает, что стрим закончился. Для MaxSessions
дополнительно не маппить — лимитер шага 1 плюс заметка ниже покрывают
осознанную часть бюджета.

**Бюджет SSH-каналов (общий на профиль).** `manager.ts` держит одно
соединение; каналы на нём делят все подсистемы: постоянный SFTP
(`conn.sftpPromise`), shell терминала, follow docker-логов, разовые
exec'и (метрики). OpenSSH `MaxSessions` по умолчанию 10. Отсюда
`FOLLOW_STREAM_LIMIT = 3` (`services/stream-limits.ts`): SFTP + терминал +
docker-follow + 3 стрима = 6 постоянных, запас на транзитные exec'ы.
Лимит **общий на профиль по всем подсистемам** — журнал unit'а из эпика 13
и вывод обновлений из эпика 19 расходуют те же три слота, а не заводят
свои. **Заметка для эпика 15** (8
терминалов на профиль): его лимит обязан учитывать тот же бюджет — при
взятии 15 в работу пересчитать сумму и, возможно, ограничить терминалы
сильнее; переполнение сегодня вылезает невнятным «Channel open failure».

### 3. `logPaths` в профиле

- `profileInputSchema`: `logPaths: z.array(z.string().min(1)).max(50).optional()`;
  поле `logPaths?: string[]` в `Profile` (`server/src/types.ts` и
  `web/src/types.ts`). Новый стор не заводим — пин живёт вместе с сервером
  (решение roadmap).
- `normalizeLogPaths(input: string[]): string[]` — чистая: trim, пустые
  отбрасываются, не-абсолютный путь или сегмент `..` → исключение с
  перечнем плохих строк, дедуп с сохранением порядка.
- `updateProfile`: `logPaths: data.logPaths ?? existing.logPaths` —
  частичное обновление как у секретов (ProfileModal про поле не знает и
  существующие пины не затирает).
- Для пиннинга из FilesPage — маленький маршрут вместо пересылки всей
  формы профиля: `PUT /api/profiles/:id/log-paths` `{paths: string[]}` →
  zod → `normalizeLogPaths` → новая функция `updateProfileLogPaths(id,
  paths)` в `profiles.ts` (заменяет поле, persist) → ответ — обновлённый
  `Profile`. Отдельный маршрут обязателен, а не `PUT /:id`: полный
  апдейт вызывает `closeProfileConnection` (`routes/profiles.ts:96`) и
  оборвал бы тот самый стрим, из которого пользователь жмёт «Закрепить».
  Экспорт/импорт бэкапов провозит поле автоматически (входит в объект
  профиля) — покрыть фикстурой в `profile-transfer.test.ts`.

### 4. Фронтенд: компонент `web/src/components/LogViewer.tsx`

Переиспользуемый просмотрщик: не знает про источник (файл, journalctl,
apt) и про пин — их задаёт вызывающий.

Пропы: `{ title, buildUrl: (follow: boolean) => string, visible,
onAskAgent?: (text: string) => void, toolbarExtra?: ReactNode }`
(`toolbarExtra` — слот для «★ Закрепить» из FilesPage; закрытие модалки —
тоже забота вызывающего).

Внутреннее:

- стейт: `follow=true`, `autoscroll=true`, `filter=''`,
  `status: 'loading' | 'live' | 'stopped' | 'error'`, `retry` (счётчик
  для «Переподключиться»);
- effect `[buildUrl, follow, visible, retry]`: при `!visible` не
  стартует (cleanup абортит прежний); fetch-стрим паттерном `LogsModal`
  (AbortController + reader); чаки копятся в ref, флеш в стейт
  интервалом ~250 мс — батчинг против ререндера на каждый чанк;
  `buildUrl` вызывающий стабилизирует `useCallback`, иначе identity
  пропа будет перезапускать стрим;
- буфер: чистый модуль `web/src/log-buffer.ts` — `appendChunk(lines,
  pending, chunk, maxLines) → {lines, pending}` (деление по `\n`,
  неполная хвостовая строка остаётся в `pending` до следующего чанка,
  кольцевая обрезка до 5000 строк) и `lastNChars(lines, n)`. Тест-раннера
  в `web/` нет (см. эпик 20) — модуль держим чистым ради будущих тестов,
  проверяется сборкой и ручным проходом; это осознанное отступление от
  строки roadmap «обрезка буфера — чистым хелпером» в части юнит-теста;
- фильтр-подстрока без учёта регистра, `useMemo` по `[lines, filter]`;
  «Скопировать» — `clipboard.writeText` отфильтрованного;
- **«В чат»**: сообщение собирает сам LogViewer —
  «Объясни этот вывод лога <путь> (сервер <имя>): ```<хвост отфильтрованного
  буфера до 4 КБ>```» — и шлёт `onAskAgent(text, 'send')`. Режим `'send'`
  уже существует (`AgentPage.tsx:530`, текст не оборачивается) — путь к
  файлу попадает в сообщение, агент знает, что смотрит пользователь.
  Использовать `'explain'` нельзя: шаблон `terminalContextMessage`
  жёстко говорит «вывод терминала» — для лога это враньё в промпте;
- автоскролл: при включённом — `scrollTop = scrollHeight` после флеша;
  ручной скролл вверх (>40 px от дна) выключает, чекбокс отражает;
- статусы: «подключено…» / «остановлено» / текст ошибки + кнопка
  «Переподключиться» (`retry++`). Обрыв ответа после SSH-реконнекта
  менеджера — стрим не возрождается сам, переподключение ручное (то же
  честное поведение v1, что у туннелей);
- рестарт (смена follow, возврат `visible`, retry) — с чистым буфером,
  как `LogsModal`.

### 5. FilesPage и App

- `App.tsx`: `<FilesPage … visible={tab === 'files'} onAskAgent={handleAskAgent}
  onProfilesChanged={() => void loadProfiles()} />` — visible теперь у всех
  контентных страниц; `onProfilesChanged` обновляет профили после
  пиннинга (тот же `loadProfiles`, что у `ProfileModal.onSaved`).
- `FilesPage`:
  - в строках файлов (не директорий; симлинки можно — stat следует по
    ссылке) кнопка 👁 «Смотреть хвост (tail -F)» → стейт
    `tailTarget: string | null`;
  - модалка рендерится при `tailTarget !== null`: заголовок — полный
    путь, внутри `LogViewer` c `buildUrl={(follow) =>
    /api/files/tail?profileId&path&lines=500&follow}` и
    `visible={visible}` (модалки без `tailTarget` просто нет — второе
    условие в visible избыточно), `toolbarExtra` = «★ Закрепить /
    ☆ Открепить» (PUT log-paths, добавление текущего пути);
  - закреплённые логи — ряд чипов под тулбаром (видим при
    `profile.logPaths?.length > 0`): клик — открыть просмотрщик, ✕ —
    открепить (PUT без этого пути), «+» — prompt-модалка добавления
    пути (клиентская проверка «начинается с /», остальное нормализует
    сервер). Чипы, а не отдельная вкладка: пины — это быстрый доступ
    из файлового менеджера, где уже есть контекст пути.

### 6. CSS (`web/src/styles.css`)

`.log-chips` / `.log-chip` (+ hover/danger для ✕) на CSS-переменных;
инпут фильтра и статус — в существующей `.logs-toolbar`; `.logs-view`
дописать `scrollbar-gutter: stable` (правило новых скролл-областей).

## Отклонённые альтернативы

- **Отдельный стор `data/log-paths.json`** — поле в профиле проще и
  экспортируется бэкапом бесплатно (решение roadmap).
- **WebSocket вместо chunked HTTP** — авторизация/прокси уже решены для
  fetch, docker-логи идут тем же транспортом; WS ничего не добавляет.
- **xterm.js как просмотрщик** — тяжёлее для read-only текста, нет
  фильтра; `<pre>` + батчинг себя показали в LogsModal.
- **Детект бинарности по первому чанку стрима** — пришлось бы задерживать
  flushHeaders и обрывать стрим после старта; предпроверка 512 байт через
  SFTP даёт обычную JSON-ошибку до открытия канала.
- **Pause/resume SSH-канала для backpressure** — расширяет API
  `execStream` наружу ради редкого случая; дроп чанков с маркером проще и
  для кольцевого просмотрщика эквивалентен.
- **Кэш 2 с** (как у метрик/портов) — не нужен: запрос ручной и дешёвый,
  кэш только мешал бы свежести хвоста.

## Тесты

`server/test/exec-stream.test.ts` (новый, шаг 0): см. раздел «Шаг 0» —
гонка code-промиса, ошибка `client.exec`, отказ `getClient`.

`server/test/stream-limits.test.ts` (новый): `createFollowLimiter` —
acquire до максимума, отказ сверх, release освобождает слот, release при
нуле не уходит в минус, ключи (профили) независимы.

`server/test/file-tail.test.ts`:

- сборка команд: экранирование пути с пробелами/кавычками/ведущим
  дефисом, `--` перед путём, `-F` только у follow-варианта;
- `clampTailLines`: 0, дробное, 5001, дефолт;
- `assertNotDirectory`: режимы директории/файла/симлинка;
- `looksBinary(Buffer)`: NUL в начале/середине/отсутствует, пустой и
  короткий буфер;
- `createChunkGate`: пропуск в норме, дроп за лимитом, маркер с суммой
  пропущенного при возврате, сброс после маркера;

`server/test/profiles.test.ts` (расширить): `normalizeLogPaths` (валидные,
дедуп, не-абсолютный, `..`, >50); `updateProfile` без `logPaths` сохраняет
существующие; `updateProfileLogPaths` заменяет список.

`server/test/profile-transfer.test.ts` (расширить): `logPaths` в
экспорт/импорт round-trip.

Ручной сценарий (стенд: сервер + тестовый sshd):

- **регресс docker-логов после шага 0**: follow-логи контейнера в Docker
  Explorer отдают тело и закрываются корректно (до правки — пустой ответ);
- генерируем лог (`while true; do date >> ~/test.log; sleep 1; done`),
  открываем просмотрщик: хвост 500 строк, новые строки приходят;
- ротация: `mv test.log test.log.1 && touch test.log` → `-F` подхватывает
  новый файл;
- переключение вкладки — стрим на паузе (обрыв в network), возврат —
  перезапущен с чистым буфером;
- обрыв SSH (перезапуск sshd-контейнера) → статус «остановлено»,
  «Переподключиться» поднимает стрим;
- четвёртый одновременный стрим → 429, сообщение в тосте; закрытие
  лишних освобождает слот; три неудачных подключения подряд (битый
  профиль) не запирают лимит — слот снимается и на ошибке;
- backpressure: `yes >> ~/test.log` в фоне — просмотрщик жив, память
  процесса не растёт, в буфере появляется маркер «пропущено N байт»;
- директория и бинарник (`head -c 512 /dev/urandom > bin.log`) → понятные
  ошибки до открытия стрима;
- фильтр, «Скопировать», «В чат» (панель агента раскрывается, сообщение
  начинается с «Объясни этот вывод лога <путь>…», контекст ≤4 КБ);
- пин/анпин чипов, «+ путь», F5 — чипы на месте (поле в `profiles.json`),
  редактирование профиля в ProfileModal пины не затирает.

## Риски

- **Ротация закреплённого пина**: если путь в момент открытия уехал в
  `.1` (ротация между сессиями), precheck через stat даст ошибку — при
  том что `-F` именно этот случай и пережил бы, окажись стрим открыт.
  Для v1 принято: ошибка понятная, пользователь переподключится вручную.
- Быстрорастущий лог — дроп середины с маркером (backpressure): для
  живого просмотра приемлемо, полный лог — в файлах/терминале.
- Общий бюджет SSH-каналов профиля (`MaxSessions`): см. раздел 2; для
  эпика 15 — пересчитать при планировании.

## Затрагиваемые файлы

- server: `src/ssh/manager.ts` (шаг 0 — починка `execStream`), новые
  `src/services/file-tail.ts` и `src/services/stream-limits.ts`,
  `src/routes/files.ts` (+`/tail`),
  `src/profiles.ts` (`logPaths`, `normalizeLogPaths`,
  `updateProfileLogPaths`), `src/routes/profiles.ts`
  (+`PUT /:id/log-paths`), `src/ssh/sftp.ts` (+`readRange`),
  `src/types.ts` (`Profile.logPaths`);
- server/test: `exec-stream.test.ts` (новый), `file-tail.test.ts`
  (новый), `stream-limits.test.ts` (новый), `profiles.test.ts`,
  `profile-transfer.test.ts`;
- web: `src/components/LogViewer.tsx` (новый), `src/log-buffer.ts`
  (новый), `src/pages/FilesPage.tsx`, `src/App.tsx`, `src/types.ts`,
  `src/styles.css`;
- docs по сдаче: `AGENTS.md` (маршрут, поле профиля, лимит стримов,
  починка execStream), `docs/architecture.md` (раздел подсистемы +
  заметка о docker-логах), `docs/roadmap.md` (пометка «Реализовано»).

Без изменений: WS-протокол, агент, Docker-роуты (но их follow-ветка
начинает работать после шага 0 — зафиксировать в коммит-месседже).

## Проверки

- `cd server && npm run build && npm test`, `cd web && npm run build`,
  `npm audit` в обоих — зелёные (правила «перед сдачей»);
- ручной сценарий из раздела «Тесты» (первый пункт — регресс
  docker-логов — сразу после шага 0).

## Оценка

~1.25 дня: шаг 0 ~0.25 (правка + тест с моком ssh2), бэкенд ~0.5 (сервис
+ маршрут + logPaths), фронтенд ~0.5 (LogViewer + FilesPage).
