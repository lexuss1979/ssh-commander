# План: эпик 16 — «Что съело диск» — навигатор по `du`

> Эпик 16 из `docs/roadmap.md` (Tier 2 — «регулярно, но не каждый день»):
> замыкает сценарий «Обзор показывает диск на 92% и не даёт следующего шага» —
> проваливание по каталогам с размерами и топ крупнейших файлов.
> Статус: реализовано (2026-08-23), правки по ревью внесены. Дата плана: 2026-08-23.
> Сервер + фронтенд + инструмент агента. Новых зависимостей нет.

## Контекст: что уже есть

- «Обзор» (`web/src/pages/OverviewPage.tsx`) рисует карточку «Диски» по
  `ServerMetrics.disks` (`mount, filesystem, totalBytes, usedBytes,
  usedPercent`) из `services/metrics.ts` (`df -P -k`). Строки диска —
  `.disk-row` с `Meter` (экспортирован из OverviewPage, классы
  `.meter`/`.meter-fill` на CSS-переменных). Дальше — тупик: кликать некуда.
- `exec` (`ssh/manager.ts`): таймаут по умолчанию 60 c (у `du` по большому
  дереву — тот же, передаём явно), лимит вывода 2 МБ на stdout и stderr
  **раздельно**, `ExecResult {code, stdout, stderr}` без флага обрезки —
  парсеры обязаны терпимо переживать обрезанный хвост.
- `shq` (`util/shell.ts`) для всех аргументов; `assertSafePath`
  (`util/path.ts`) запрещает `/` (parts.length === 0) — для du корень
  **законный** корень навигации, нужен свой вариант валидации.
- Эталонные паттерны: кэш 2 с на профиль (`metrics.ts`, `ports.ts`), zod-
  схема query с `z.coerce.number()` (`routes/files.ts` `/search`, `/tail`),
  предпроверка stat до тяжёлой команды (`/download-dir`), маршрут
  `requireProfile` → 404 / ошибки команды → 400 / транспорт → 502
  (`routes/metrics.ts`).
- Инструменты агента (`src/ai/tools.ts` + `READ_ONLY_TOOLS` + кейс в
  `runTool` агент.ts). Прецедент «детерминированная read-only команда,
  собранная сервером, минуя deny-лист exec_readonly» — `security_audit`.
  Параметр `server` (мульти-серверный режим) резолвится через
  `resolveServer`. Вывод инструментов обрезается `truncate` до 12000
  символов. **Deny-лист `guard.ts` запрещает конвейеры/редиректы — команды
  du/find собирает сервис, инструмент не должен идти через exec_readonly.**
- Кросс-вкладковая навигация — готовый паттерн «состояние в App + проп +
  потребление»: `terminalContainer` (Docker → Терминал), `sqlInsert`
  (агент → SQL-консоль). Для «Открыть в файлах» заводим то же:
  `filesOpenPath` в App → проп FilesPage → `setPath(openPath)`.
- Хлебные крошки — готовый CSS `.breadcrumbs`/`.crumb` (FilesPage);
  модалки — `web/src/components/Modal.tsx`.

## Решение

### 1. Сервис `server/src/services/disk-usage.ts`

Константы: `DU_TIMEOUT_MS = 60000` (как дефолт exec), `DU_MAX_LIMIT = 500`
(файлов в ответе), `DU_DEFAULT_LIMIT = 100`, `AGENT_DEFAULT_LIMIT = 10`,
`AGENT_MAX_LIMIT = 50`, кэш `DISK_USAGE_CACHE_TTL_MS = 2000` (только для
тяжёлого du-снимка).

**Валидация пути** — локальные чистые функции (assertSafePath не годится:
он запрещает `/`, а точка монтирования может быть корнем):

- `normalizeDiskPath(p)` — trim, схлопывание `//`, снятие хвостового `/`
  (кроме корня) — по образцу локального `normalizePath` в `routes/files.ts`.
- `assertNavigablePath(p)` — абсолютный путь (`/` — можно), сегментов `..`
  нет; иначе Error с понятным текстом. Пользовательский ввод в shell не
  попадает — только в `shq(path)`.

**Сборка команд** (чистые билдеры под unit-тесты; команды собирает сервис,
поэтому конвейеры и `2>/dev/null` здесь допустимы — guard их не видит):

- `buildDuCommand(path)` →
  `du -x -d 1 -k -- <shq(path)>`.
  **Отклонение от текста roadmap (`-B1`): `-k`, а не `-B1`.** BusyBox `du`
  не понимает `-B`; `-k` (кибибайты) портируем на GNU/BusyBox так же, как
  `df -P -k` в `metrics.ts`. Стабильность парсинга не теряется: размер —
  целое число KiB, парсер умножает на 1024. `-x` — не выходить за пределы
  одной ФС (тот же смысл, что в roadmap); `-d 1` — сам каталог (последней
  строкой, post-order) плюс прямые подкаталоги, глубже не спускается в
  вывод — парсер разбирает обе части, см. ниже.
  **Отклонение от roadmap (`2>/dev/null`): stderr не глушим, а ловим и
  считаем строки отказа доступа** — иначе «доступно не всё» из секции
  «Риски» roadmap невозможно отличить от честной картины. См.
  `countUnreadable` ниже.
- `buildTopFilesCommand(path, limit)` →
  `find <shq(path)> -xdev -type f -printf '%s\t%p\n' | sort -rn | head -n <limit>`.
  `limit` — уже провалидированное целое, интерполяция безопасна.
- `buildTopFilesStatCommand(path, limit)` — фолбэк без `-printf` (BusyBox):
  `find <shq(path)> -xdev -type f -exec stat -c '%s\t%n' {} + | sort -rn | head -n <limit>`,
  где `\t` в исходнике — **литеральный символ табуляции (0x09)** внутри
  одинарных кавычек, а не два символа `\` + `t`: GNU stat escape-
  последовательность разворачивает, BusyBox stat — нет, и парсер получил
  бы строки без разделителя. (У `find -printf` выше — наоборот: там `\t`
  пишется escape-последовательностью, её разворачивает сам find.) Если
  `-exec … +` не поддержан (старые BusyBox) — тот же признак в stderr, что
  и у `-printf`: режим «Файлы» деградирует с пояснением, каталоги
  остаются (третий вариант команды не заводим — экзотика).
- `needsStatFallback(stderr)` — чистая:
  `/unrecognized|unknown (primary|predicate|option)|invalid option|not supported/i`
  → true. Формулировки расходятся сильнее, чем кажется: BusyBox —
  `find: unrecognized: -printf`, GNU — ``find: unknown predicate `-printf'``,
  BSD — `find: -printf: unknown primary or operator`. Узкая маска
  `unknown primary|invalid option` промахнулась бы ровно по BusyBox, ради
  которого фолбэк и заводится. Второй признак того же отказа: пустой
  stdout при непустом stderr — код возврата пайплайна принадлежит `head`
  (всегда 0), по коду провал `find` не виден вообще.
  Стратегия исполнения: пробуем `-printf`-вариант; при `needsStatFallback`
  по stderr — повторяем stat-вариантом (один лишний exec только на
  BusyBox-серверах, решение не кэшируем — запрос ручной и редкий).

**Парсеры** (чистые, терпимые к обрезанному выводу 2 МБ):

- `parseDuKb(text, basePath)` → `{totalKb: number | null, children:
  {path, kb}[]}`. Строки `^\s*(\d+)\t(.+)$` (разделитель — **первый** таб;
  путь с пробелами/табами — хвост строки). Запись с `path === basePath` —
  сумма поддерева; ищем её **по совпадению пути, а не по позиции**: и GNU,
  и BusyBox `du` обходят дерево в post-order и печатают сам каталог
  последней строкой, после детей (в первой строке он не бывает никогда).
  Записи нет → `totalKb: null` — это не ошибка, а признак обрезанного
  вывода (см. `diskUsageSnapshot`: суммарная строка идёт последней и
  теряется первой при упоре в кап 2 МБ). Children — записи с путём,
  начинающимся с `basePath + '/'`. Прочее (мусор, обрезанный хвост без
  таба) — пропуск.
- `toDuSnapshot(path, totalKb, children)` → `{totalBytes, directBytes,
  children: [{name, path, bytes, pctOfParent}]}` — дети отсортированы по
  убыванию, `pctOfParent` — доля от `totalBytes` (1 знак, как `formatPct`),
  `directBytes = max(0, totalBytes − Σ children)` — размер файлов прямо в
  каталоге (du их в `-d 1` не печатает; UI показывает их отдельной
  строкой «файлы в этом каталоге»).
- `parseFindOutput(text)` → `{path, bytes}[]` по той же маске `%s\t%p`,
  отсортировано по убыванию (sort уже отсортировал — сортируем и в парсере
  оборонительно), неполная хвостовая строка без таба отбрасывается.
- `countUnreadable(stderr)` → число строк
  `/cannot (read|access)|Permission denied|Operation not permitted/i` — для
  честной пометки «доступно не всё» (см. отклонение выше).

**Исполнение:**

- `diskUsageSnapshot(profile, path)` — предпроверка SFTP stat (`withSftp`
  + `sftpStat`, паттерн `/download-dir`): путь существует (иначе ошибка
  stat) и это директория (иначе «Это не директория» — JSON-ошибка до
  exec). Затем `exec(profile, buildDuCommand(path), {timeoutMs:
  DU_TIMEOUT_MS})`; `code !== 0` → Error со stderr (нет прав на сам путь,
  путь пропал между stat и du); `totalKb === null` (обрезанный вывод) →
  **деградация, а не ошибка**: `totalBytes = Σ children`,
  `directBytes = 0`, `truncated: true` — доли подкаталогов остаются
  осмысленными, UI ставит пометку «вывод обрезан — сумма неполная».
  Ошибку отдаём только когда и детей нет (`children.length === 0` при
  `totalKb === null`) — тогда парсить действительно нечего. Ответ —
  `{path, totalBytes, directBytes, children, incomplete, truncated}`
  (`incomplete: {unreadable: n} | null`). Кэш
  `Map<"<profileId>\0<path>", {at, promise}>`, TTL 2 с (du — самая тяжёлая
  команда приложения; повторный клик по тому же каталогу не должен гонять
  её снова; ошибочный промис из кэша удаляется — паттерн `collectMetrics`).
- `topFiles(profile, path, limit)` — та же предпроверка stat (без кэша:
  find дешевле, навигация ручная). Стратегия `-printf` → фолбэк stat по
  `needsStatFallback`. Ответ — `{path, files, incomplete}`.

### 2. Маршруты `server/src/routes/disk-usage.ts`

Монтирование: `app.use('/api/disk-usage', requireAuth, diskUsageRouter)` в
`src/index.ts`.

- `GET /api/disk-usage?profileId=&path=` — zod
  (`profileId` min 1, `path` min 1, default `/`): `requireProfile` → 404;
  `assertNavigablePath(normalizeDiskPath(path))` → 400; предпроверка/du
  ошибки → 400 с текстом; транспорт (exec reject — SSH недоступен) → 502
  «Сервер недоступен: …» (разделение как в `routes/metrics.ts`). Ответ:
  `{timestamp, path, totalBytes, directBytes, children:
  [{name, path, bytes, pctOfParent}], incomplete?}`.
- `GET /api/disk-usage/files?profileId=&path=&limit=` — zod
  (`limit: z.coerce.number().int().min(1).max(500).default(100)`), та же
  валидация. Ответ: `{timestamp, path, files: [{path, bytes}], incomplete?,
  truncated: files.length === limit}`.

Оба роута — простые JSON-ответы, сервисная логика покрыта unit-тестами;
отдельный route-тест не заводим (тот же выбор, что у `/api/metrics` и
`/api/files/search`).

### 3. Инструмент агента `disk_usage` (read-only)

Правила расширения набора (AGENTS.md): определение в `tools.ts` + имя в
`READ_ONLY_TOOLS` + кейс в `runTool`.

- `tools.ts`: `disk_usage {path?, limit?, server?}` — описание:
  «Что занимает место на диске: размер каталога, крупнейшие подкаталоги и
  файлы (du/find, read-only, выполняется автоматически). path — абсолютный
  путь, по умолчанию /; limit — число записей, по умолчанию 10. Типовой
  сценарий „почему кончился диск“: начни с /, затем спускайся по
  крупнейшим подкаталогам». `READ_ONLY_TOOLS.add('disk_usage')`.
- `agent.ts` кейс в `runTool` (после `resolveServer`, как `security_audit`):
  `path = String(args.path ?? '/')` → `assertNavigablePath` (ошибка — текстом
  tool_result, цикл не падает); `limit = clampAgentLimit(args.limit)`
  (целое 1..50, дефолт 10). Каталоги и файлы — параллельно
  (`Promise.allSettled`, паттерн `overview.ts`): основной результат —
  каталоги; файлы при отказе (нет find/stat) деградируют в строку
  «крупнейшие файлы недоступны: <причина>», не роняя инструмент целиком.
  Формат вывода:
  ```
  Размер <path>: <bytes> Б (<human>)
  Крупнейшие подкаталоги:
    1. <name> — <bytes> Б (<pct>%)
  ...
  Крупнейшие файлы:
    1. <path> — <bytes> Б
  ...
  (недоступно: N каталогов — нужны права доступа)
  ```
  через существующий `this.truncate` (12000 символов).
- Класс read-only безопасен: команду собирает сервис из провалидированного
  пути (shq), пользовательский shell в инструмент не попадает — как у
  `security_audit`; deny-лист `exec_readonly` не участвует.
- Системный промпт (`agent.ts` конструктор): добавить `disk_usage` в строку
  перечисления read-only инструментов и одну фразу о сценарии «почему
  кончился диск».

### 4. Фронтенд: `web/src/components/DiskUsageModal.tsx` + OverviewPage

- Пропсы: `{profile, initialPath, onClose, onOpenInFiles(path)}` (ошибки —
  через `showError` OverviewPage).
- Состояние: `path` (старт — `initialPath`, точка монтирования),
  `mode: 'dirs' | 'files'`, `data: DiskUsageSnapshot | null`,
  `files: DiskUsageFile[] | null`, `loading`, `error`.
- Загрузка по `[path, mode, open]` с AbortController (закрытие модалки —
  abort); при смене пути/режима — свежий fetch. «Повторить» при ошибке.
- Шапка: хлебные крошки (переиспользовать `.breadcrumbs`/`.crumb`;
  сегменты пути, клик — переход на префикс; корень — `/`), кнопка
  «Открыть в файлах» (текущий путь), переключатель «Каталоги / Файлы»,
  закрытие.
- Режим «Каталоги»: строки-подкаталоги — имя (basename), размер
  (`formatSize`), `Meter` с долей от текущего поддерева, клик по строке —
  углубление (`path = child.path`). Последняя строка — «файлы в этом
  каталоге» (`directBytes`, muted, некликабельна) — du их не печатает, без
  неё сумма строк не сходится с размером каталога.
- Режим «Файлы»: строки файлов — путь (относительно текущего), размер,
  кнопка «В файлы» (открывает родителя файла в FilesPage), пометка
  «показаны первые N» при `truncated`.
- Чип-предупреждение при `incomplete`: «Часть каталогов недоступна (нет
  прав) — цифры неполные».
- OverviewPage: у каждой строки диска (`.disk-row-head`) — кнопка
  «Что занимает» → `duTarget = d.mount`; модалка рендерится при
  `duTarget !== null`, `initialPath = duTarget`. Новый проп
  `onOpenInFiles` пробрасывается в модалку.

### 5. «Открыть в файлах» — связка App ↔ FilesPage

Паттерн `sqlInsert` (`App.tsx:238`):

- App: `const [filesOpenPath, setFilesOpenPath] = useState<string | null>(null)`;
  `handleOpenInFiles = (path) => { setFilesOpenPath(path); setTab('files'); }`
  (профиль уже активный — «Обзор» рендерится только для `activeProfile`).
  Передать `onOpenInFiles={handleOpenInFiles}` в OverviewPage и
  `openPath={filesOpenPath}` + `onFilesPathConsumed={() =>
  setFilesOpenPath(null)}` в FilesPage.
- FilesPage: новые пропсы `openPath?: string | null`,
  `onFilesPathConsumed?: () => void`; эффект — при непустом `openPath`:
  `setPath(openPath)` (по желанию сбросить `searchResults`/`selected`) и
  вызвать `onFilesPathConsumed`. FilesPage смонтирован keep-alive — эффект
  срабатывает при переключении вкладки.

### 6. CSS (`web/src/styles.css`)

`.du-*`-классы на CSS-переменных (строка/имя/размер/процент/чип-предупреждение,
muted-строка «файлы в этом каталоге»), скроллируемая область модалки —
`scrollbar-gutter: stable` (правило новых скролл-областей), `Meter` и
хлебные крошки — существующие.

## Отклонённые альтернативы

- **`du -B1` (как в roadmap)** — BusyBox `du` не понимает `-B`; `-k` +
  ×1024 в парсере даёт ту же стабильность целых чисел и портируемость
  (`df -P -k` уже так делает). См. раздел 1.
- **`2>/dev/null` (как в roadmap)** — глушит и сам факт недоступности;
  roadmap сам требует пометку «доступно не всё», но без stderr её не
  отличить. Ловим stderr и считаем строки отказа — `incomplete` честный.
- **Инструмент агента через `exec_readonly`** — deny-лист `guard.ts`
  запрещает конвейеры и редиректы (`CONTROL_CHARS`), команда du/find их
  содержит; собранный сервисом инструмент (прецедент `security_audit`) —
  единственный путь.
- **Один exec «всё дерево» + навигация без серверных запросов** — дерево
  произвольной глубины не влезает в 2 МБ и в 60 c; `du -d 1` + проваливание
  по клику — дешёвый запрос на уровень, кэш 2 с смягчает повторные клики.
- **Показ суммы по каждому файлу в режиме «Каталоги»** — du печатает
  только директории; файлы прямо в каталоге суммируются в `directBytes`
  (одна строка вместо тысяч строк вывода).
- **Одна вкладка вместо модалки** — навигатор — продолжение карточки
  «Диски» «Обзора», модалка поверх неё сохраняет контекст; отдельная
  вкладка раздула бы таббар ради сценария, который решается за минуту.

## Тесты

`server/test/disk-usage.test.ts` (новый):

- билдеры: `buildDuCommand` — `--` перед путём, shq-экранирование
  (пробелы, кавычки, ведущий дефис), флаги `-x -d 1 -k`; `buildTopFiles
  Command`/`buildTopFilesStatCommand` — интерполяция limit, пайплайн
  sort/head;
- валидация: `normalizeDiskPath` (схлопывание `//`, хвостовой `/`, корень),
  `assertNavigablePath` (не-абсолютный, `..`, `..` в середине, `/` — ок);
- `parseDuKb`: нормальный вывод (суммарная строка **последняя**, как у
  GNU/BusyBox), пути с пробелами, children-фильтр (чужой путь → пропуск),
  мусорные строки, отсутствие total → null, обрезанный хвост без таба,
  BusyBox-вариант (путь без `./`-префикса);
- `toDuSnapshot`: сортировка по убыванию, округление pct, `directBytes`
  = total − Σ children (и clamp ≥ 0 при расхождении — незакрытые удалённые
  файлы и т.п.), пустой список детей; `totalKb === null` при непустых
  детях → `totalBytes = Σ children`, `truncated: true`, `directBytes = 0`;
  `totalKb === null` без детей → ошибка;
- `countUnreadable`: строки `Permission denied`/`cannot read directory`
  считаются, посторонний stderr игнорируется;
- `parseFindOutput`: нормальный, пути с пробелами, неполная хвостовая
  строка, мусор, сортировка;
- `needsStatFallback`: `-printf: unknown primary` / `invalid option` →
  true, пустой stderr → false;
- `clampAgentLimit`: 0/отрицательное/NaN/51+/дефолт 10.

Ручной сценарий (стенд: сервер + тестовый sshd на :2222, user `test`,
паттерн `integration.manual.mjs`):

- du по `/` (или точке монтирования): строки подкаталогов с долями,
  проваливание кликом, хлебные крошки назад;
- каталог с частично недоступными подкаталогами (например `/root` от
  пользователя `test`) → чип «доступно не всё», суммы не выглядят враньём;
- путь-файл → «Это не директория»; несуществующий путь → понятная ошибка;
- режим «Файлы»: топ по размеру, лимит соблюдается, `truncated`-пометка;
- повторный клик по тому же каталогу — не плодит exec (кэш 2 с);
- агент: «почему кончился диск» → `disk_usage` выполняется автоматически
  (без approve), формат результата, при необходимости агент углубляется
  повторными вызовами;
- «Открыть в файлах» из модалки → FilesPage на нужном пути (из строки
  файла — на родителя); закрытие модалки не ломает polling «Обзора».

## Риски

- **Долгий `du` по большому дереву** — минуты; спасают `-x` (одна ФС),
  старт от точки монтирования, таймаут 60 c (превышение — понятная ошибка
  «Превышено время ожидания»), кэш 2 с.
- **Цифры du ≠ df** — du считает занятые файлами блоки, df — использованное
  место ФС (метаданные, удалённые открытые файлы, резерв). Пропорции внутри
  каталога корректны, но сумму с карточкой «Диски» не сравнивать — планка
  «доступно не всё» и muted-подписи в UI снимают иллюзию точности.
- **Вложенные монтирования исключаются `-x`** — намеренно (иначе `/proc` и
  чужие ФС портят картину); крупные данные на отдельном диске видны в
  карточке «Диски» отдельной строкой — пользователь заходит с неё.
- **BusyBox** — `du -d 1 -k` поддерживается; `find -printf` нет — фолбэк
  через `stat -c`; если и stat-вариант не сработал (экзотика) — режим
  «Файлы» деградирует с пояснением, каталоги остаются.
- **Ограничение прав** — без sudo часть каталогов нечитаема: `incomplete`
  вместо молчаливо заниженных цифр; sudo-механику в v1 не заводим
  (read-only обзор, не аудит).
- **Не-ASCII имена файлов** — `exec` склеивает чанки как
  `d.toString()` без учёта границы UTF-8 (в отличие от стримов эпика 14),
  так что имя с кириллицей может изредка исказиться на стыке чанков.
  На цифры и навигацию это не влияет (путь для перехода берётся из той же
  строки), общий фикс `exec` — вне рамок эпика.
- **Вывод 2 МБ** — `du -d 1` на каталоге с тысячами детей и `find` с
  длинными путями могут упереться; парсеры отбрасывают неполный хвост,
  UI показывает то, что пришло (для «кто съел» первые по размеру и так
  в начале вывода после sort).

## Затрагиваемые файлы

- server: новый `src/services/disk-usage.ts`, новый
  `src/routes/disk-usage.ts`, `src/index.ts` (монтирование роутера),
  `src/ai/tools.ts` (определение `disk_usage` + `READ_ONLY_TOOLS`),
  `src/ai/agent.ts` (кейс в `runTool` + системный промпт);
- server/test: новый `disk-usage.test.ts`; расширить
  `integration.manual.mjs` (сценарий du);
- web: новый `src/components/DiskUsageModal.tsx`, `src/pages/OverviewPage.tsx`
  (кнопка + проп `onOpenInFiles` + модалка), `src/pages/FilesPage.tsx`
  (`openPath`/`onFilesPathConsumed`), `src/App.tsx` (`filesOpenPath`,
  `handleOpenInFiles`, проброс пропсов), `src/api.ts` (типы
  `DiskUsageSnapshot`/`DiskUsageFile` + fetch-функции), `src/styles.css`;
- docs по сдаче: `AGENTS.md` (маршруты, инструмент `disk_usage`),
  `docs/architecture.md` (раздел подсистемы + инструмент),
  `docs/roadmap.md` (пометка «Реализовано» после сдачи).

Без изменений: WS-протокол, хранилища, docker-compose/env, зависимости.

## Проверки

- `cd server && npm run build && npm test`, `cd web && npm run build`,
  `npm audit` в обоих — зелёные (правила «перед сдачей»);
- ручной сценарий из раздела «Тесты».

## Оценка

~1 день: бэкенд ~0.5 (сервис + роуты + инструмент агента), фронтенд ~0.5
(модалка + OverviewPage + связка App↔FilesPage). Совпадает с оценкой
roadmap.
