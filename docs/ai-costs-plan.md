# План эпика: учёт расходов AI — стоимость диалогов, страница «ИИ-расходы»

> **Статус: реализовано 2026-08-21** (эпик 12 roadmap). Захват usage —
> `client.ts`/`web-search.ts`, тарификация — `pricing.ts` (дефолты +
> `data/ai-prices.json`), журнал — `usage.ts` (`data/ai-usage.json`), запись
> и WS-событие — `agent.ts`, API и enrichment — `routes/ai.ts`, UI — бейдж
> в AgentPage + `AiCostsPage` в сайдбаре. Тесты: `pricing.test.ts`,
> `ai-usage.test.ts`, `client.test.ts`, расширение `web-search.test.ts`;
> ручной сценарий — `agent.manual.mjs`. Открытые риски (прерванный стрим,
> актуальность дефолтных цен, часовой пояс дней) — в разделе «Риски».

> Исходный статус (до реализации): план эпика, результат обсуждения с
> автором; развилки закрыты в «Принятых решениях». Ответ на исходный
> вопрос — **да, реализуемо**: оба API (чат и веб-поиск) уже возвращают
> `usage` с токенами, но код его отбрасывает. Форма — существующие паттерны
> проекта: JSON-стор в `data/` (как `db-connections`), enrichment списков на
> уровне роута (как bulk-обзор), глобальная страница (как «Серверы»).

## Зачем

Агент гоняет десятки запросов к платному API за диалог, но инструмент не
показывает, сколько диалог стоил. Хочется видеть стоимость прямо в окне
диалога и иметь отчёт по дням и проектам: сколько на какой сервер ушло.
«База данных проекта» — это JSON-стор в `data/` (SQL-БД в проекте нет);
привязка затрат — домашний профиль диалога + дата вызова.

## Текущее состояние (кратко)

- `server/src/ai/client.ts` — единственный путь чат-запросов
  (`streamChatCompletion`). Стриминг идёт **без**
  `stream_options.include_usage`, а финальный usage-чанк (у него
  `choices: []`) пропускается строкой `if (!delta) continue`
  (`client.ts:121`). Non-stream fallback (`normalizeMessage`, `client.ts:39`)
  читает только `choices[0].message` и теряет верхнеуровневый `usage`.
  Возвращается голый `ChatMessage` — usage каналом наружу не идёт.
- `server/src/ai/web-search.ts` — Anthropic-совместимый ответ уже содержит
  `usage: { input_tokens, output_tokens, server_tool_use:
  { web_search_requests } }` (см. фикстуру `web-search.test.ts:69`), но
  `parseSearchResponse` читает только контент.
- Вызовы: `runLoop` (`agent.ts:474`) и `runPlan` (`agent.ts:422`) — один и
  тот же `streamChatCompletion`; веб-поиск — `runTool('web_search')`
  (`agent.ts:678`).
- Диалог (`ai/dialogues.ts`): `profileId`, `createdAt`/`updatedAt` есть,
  метаданных стоимости нет; сообщения — голые OpenAI-сообщения, без
  таймстемпов.

## Цели и не-цели v1

**Не делаем (осознанно):**

- Редактор цен в UI — цены правкой `data/ai-prices.json` (решение 2);
  UI-модалка — кандидат в v2.
- Ретро-учёт: история до внедрения не восстановима (usage не сохранялся) —
  старые диалоги покажут «—».
- Атрибуция токенов по extra-серверам мульти-серверного диалога — токены
  не делятся по серверам, всё на домашний профиль (решение 6).
- Графики/экспорт CSV — v2; v1 — таблица-матрица с итогами.
- Учёт стоимости туннелей/exec — не AI-расходы, вне темы.

## Принятые решения

1. **Захват usage в `client.ts`, составной возврат.** В тело запроса
   добавляем `stream_options: { include_usage: true }`; в SSE-цикле читаем
   `json.usage` независимо от `choices`; в non-stream fallback —
   верхнеуровневый `usage`. `streamChatCompletion` возвращает
   `{ message: ChatMessage; usage?: TokenUsage }` — usage **не** кладём в
   сам ChatMessage, иначе он попадёт в `this.messages` и в
   persisted-диалог (`agent.ts:490`). Числа — только конечные ≥ 0, иначе
   поле опускается.
2. **Цены: дефолты в коде + оверрайд-файл.** Новый `server/src/ai/pricing.ts`
   с таблицей популярных моделей (USD за 1М токенов: `input`,
   `cachedInput?`, `output`, опционально `webSearchPerRequestUsd`) —
   gpt-4.1-mini, gpt-4.1, gpt-4.1-nano, gpt-4o-mini, gpt-4o, deepseek-chat,
   deepseek-reasoner, deepseek-v4-flash (0.22/0.007/0.66) и deepseek-v4-pro
   (0.66/0.022/1.98) — цены DeepSeek V4 сверены с официальным прайсом при
   реализации (off-peak; пиковые часы 01:00–04:00 и 06:00–10:00 UTC в 2
   раза дороже); при сомнении в цене модели дефолт не выдумывать — модель
   без цены (`null` → unpriced) честнее неверной цифры. Оверрайд/дополнение —
   `data/ai-prices.json`, мерж поверх дефолтов по имени модели. Файла нет —
   дефолты; битый — warn + дефолты (без corrupt-блокировки: это справочник,
   не пользовательские данные). `computeCostUsd(model, usage): number |
   null` — null, если модели нет в таблице.
   **Формула (зафиксирована, покрывается тестами):**
   `cost = (promptTokens − cachedTokens) · input + cachedTokens · cachedInput
   + completionTokens · output + searchRequests · webSearchPerRequestUsd`
   (всё в USD за 1М токенов / за запрос). Инварианты usage:
   `cached_tokens` — **подмножество** `prompt_tokens`,
   `reasoning_tokens` — **подмножество** `completion_tokens`; поэтому
   reasoning в формулу НЕ входит (уже посчитан в output) и хранится
   только информационно; без `cachedInput` у модели кэш-токены считаются
   по обычной цене `input` (т.е. вычитание — только при наличии
   `cachedInput`). Слагаемое поиска добавляется только при заданном
   `webSearchPerRequestUsd` (поштучный тариф, как у Anthropic); без него
   поиск считается по токенам — у DeepSeek серверный web_search
   оплачивается токенами модели поиска, отдельной цены за запрос нет
   (сверено с прайсом при реализации).
3. **Стоимость фиксируется в момент вызова.** В журнал пишем и токены, и
   посчитанный `costUsd` — смена цен (или оверрайд) не переписывает
   историю; токены в записи позволяют пересчитать потом, если захочется.
4. **Журнал — отдельный стор `data/ai-usage.json`**, а не поля диалога:
   удаление диалога не должно стирать финансовую историю. Канонический
   паттерн (zod + tmp/rename + corrupt-guard, образец —
   `db-connections.ts`), запись на один вызов API.
5. **Веб-поиск учитывается** (решение автора): отдельный `kind:
   'web_search'` с токенами и числом поисковых запросов — полная картина.
6. **Привязка: домашний профиль диалога + дата вызова** (локальное время
   сервера приложения, `YYYY-MM-DD`; в Docker это обычно UTC — при
   необходимости задать `TZ` в compose).
7. **Страница «ИИ-расходы» — глобальная**, кнопка в сайдбаре под
   «Серверы» (данные кросс-профильные; прецедент — `ServersPage` вне
   таббара профиля).
8. **Живой бейдж:** после каждой записи usage сессия шлёт WS-событие
   `{type:'usage', totals}` с кумулятивными итогами диалога — бейдж в
   тулбаре агента двигается во время длинных прогонов, не только по
   `done`. Ошибки записи usage не роняют цикл агента (try/catch + warn,
   как у `save()`).

## Архитектура сервера

### `server/src/ai/client.ts` — захват usage (решение 1)

- Тело запроса: + `stream_options: { include_usage: true }`.
- SSE-цикл: `json.usage` читается до проверки `choices` (финальный
  usage-чанк приходит с пустым `choices`).
- Non-stream fallback: `data.usage` → тот же `TokenUsage`.
- `TokenUsage = { promptTokens, cachedTokens, completionTokens,
  reasoningTokens }` (все optional-числа; маппинг:
  `usage.prompt_tokens` / `prompt_tokens_details.cached_tokens` /
  `completion_tokens` / `completion_tokens_details.reasoning_tokens`).
- Возврат `{ message, usage? }`; оба call-сайта (`runLoop`, `runPlan`)
  деструктурируют.

### `server/src/ai/web-search.ts` — usage поиска

- `searchWeb` дополнительно возвращает usage:
  `input_tokens` → promptTokens, `output_tokens` → completionTokens,
  `server_tool_use.web_search_requests` → searchRequests.

### `server/src/ai/pricing.ts` — новый, чистый + чтение оверрайдов

- `DEFAULT_PRICES` (см. решение 2), `loadPrices()` — дефолты + мерж
  `data/ai-prices.json` (`{ "models": { "<model>": { input, cachedInput?,
  output, webSearchPerRequestUsd? } } }`, суммы в USD за 1М токенов).
- `computeCostUsd(model, usage & searchRequests): number | null`.
  Кэширование чтения файла не нужно — чтение синхронное, дешёвое,
  вызывается только при записи в журнал.

### `server/src/ai/usage.ts` — новый стор (решение 4)

- Схема записи:
  ```ts
  { id, ts: number,                    // epoch ms вызова
    profileId, dialogueId,
    kind: 'chat' | 'plan' | 'web_search',
    model,
    promptTokens, cachedTokens, completionTokens, reasoningTokens,
    searchRequests?,                   // только web_search
    costUsd: number | null }           // null = цена не задана
  ```
- API модуля:
  - `recordUsage(rec)` — append + persist (каждая запись перезаписывает
    файл целиком через tmp+rename — см. риск «перезапись на вызов»);
  - `usageTotalsByDialogue(): Map<dialogueId, { calls, promptTokens,
    completionTokens, costUsd, unpricedCalls }>` — для enrichment списков
    и WS-бейджа; `unpricedCalls` нужен, чтобы бейдж честно показывал
    неполную сумму, когда часть вызовов без цены;
  - `usageReport(days: number | 'all')` — агрегация in-memory: группы
    по (дата, profileId) + итоги, счётчик `unpricedCalls` (costUsd ===
    null).
- Объём: десятки тысяч записей ≈ единицы МБ JSON — компакция не нужна.

### `server/src/ai/agent.ts` — запись (решения 5, 6, 8)

- Сессия хранит `profileId` домашнего профиля диалога.
- `runLoop`: после каждого успешного `streamChatCompletion`, при наличии
  `usage` → `recordUsage({ kind: 'chat', model: config.ai.model, ... })`.
- `runPlan`: то же, `kind: 'plan'`.
- `runTool('web_search')`: после `searchWeb` → `recordUsage({ kind:
  'web_search', model: config.ai.searchModel, searchRequests, ... })`.
- После каждой записи — `send({ type: 'usage', totals })` (итоги диалога
  из `usageTotalsByDialogue`). Всё в try/catch: журнал не должен ломать
  агент.

### `server/src/routes/ai.ts` — без новых монтирований

- `GET /api/ai/dialogues?profileId=` и `GET /api/ai/dialogues/:id`: в
  каждый summary/dialogue добавляется `usage: { calls, promptTokens,
  completionTokens, costUsd, unpricedCalls } | null` (join с
  `usageTotalsByDialogue()` на уровне роута — сторы друг о друге не
  знают).
- `GET /api/ai/usage?days=30` (дефолт 30; `days=all` — всё; zod-валидация):
  ```json
  { "profiles": [{ "id", "name" }],
    "days": [{ "date": "2026-08-21",
               "byProfile": { "<profileId>": Agg }, "total": Agg }],
    "totals": { "...Agg": 0, "unpricedCalls": 0 } }
  ```
  где `Agg = { calls, promptTokens, completionTokens, costUsd }`. Имена
  профилей — join с `profiles.ts`; удалённый профиль — `<id> (удалён)`.
  Дни — desc, пустые дни не включаются.

## Web

- `web/src/types.ts`: `DialogueSummary.usage?`, WS-событие `usage`
  (`{ totals }`), типы отчёта (`AiUsageReport` и Agg).
- **Бейдж диалога** — `web/src/pages/AgentPage.tsx`:
  - в тулбаре рядом со `status-text` (~строка 728): `≈ $0.0423`, в
    `title`-подсказке — вызовы и токены (вход/выход/кэш); при
    `unpricedCalls > 0` — пометка «неполная сумма» (часть вызовов без
    цены) в том же tooltip;
  - обновление: из summary (`refreshDialogues` уже зовётся на
    `done`/`error`) + живое по WS `usage`;
  - в выпадающем «История» — стоимость у каждого диалога
    (в `.dialogue-item-meta` рядом с датой).
- `formatUsd` в `api.ts`: < $1 → 4 знака, иначе 2.
- **Страница «ИИ-расходы»** — новый `web/src/pages/AiCostsPage.tsx` по
  образцу ServersPage/CronPage (props `{ visible }`; страница read-only —
  ошибки загрузки показываются через empty-state, `showError` не нужен):
  - toolbar: статус («Обновлено …»), select периода 7/30/90/всё, кнопка
    «Обновить»;
  - карточки итогов: всего за период, среднее в день, запросов;
  - матрица `data-table`: строки — дни (новые сверху), колонки — профили
    + «Итого»; в ячейке `$` (запросы и токены в tooltip), пусто — `—`;
    sticky thead; футер с итогами по колонкам;
  - загрузка при `visible` + polling 60 с; ошибка — `empty-state` с
    повтором.
- `web/src/api.ts`: `fetchAiUsage(days)`.
- `web/src/App.tsx`: `'ai-costs'` в union `Tab` (вне `TABS`), рендер
  `tab-page` вне блока `activeProfile` рядом с `ServersPage` (строки
  398–407), кнопка в сайдбаре под «Серверы»: «ИИ-расходы» / muted
  «Расходы по проектам».
- Стили — существующие классы (`data-table`, `toolbar`, `empty-state`,
  `dialogue-item-meta`); новые минимальные (карточки итогов).

## Тесты

- `server/test/pricing.test.ts`: расчёт по формуле из решения 2 —
  кэш-токены вычитаются из входных и считаются по `cachedInput`, без
  `cachedInput` — по цене `input`; reasoning НЕ добавляется к сумме
  (входит в `completion_tokens`); поисковые запросы — отдельным
  слагаемым; неизвестная модель → null; оверрайд из
  `ai-prices.json` (temp `DATA_DIR`, паттерн `db-connections.test.ts`);
  битый файл цен → warn + дефолты.
- `server/test/ai-usage.test.ts`: round-trip стора; corrupt-store
  (`*.corrupt-<ts>`, отказ persist); отчёт — группировка по дням и
  профилям, totals, `unpricedCalls`, `days='all'`;
  `usageTotalsByDialogue` — включая диалог со смесью priced/unpriced
  вызовов (сумма + `unpricedCalls > 0`).
- Тест парсинга usage в `client.ts` (новый/расширяемый, мок `fetch`):
  SSE-поток с финальным чанком `{choices: [], usage: {...}}` (usage
  читается несмотря на пустые choices); non-stream ответ с usage;
  отсутствие usage → `usage: undefined`; мусор в числах usage
  (строка/отрицательное/NaN) → поле опускается.
- `server/test/web-search.test.ts`: расширить — usage пробрасывается.
- `server/test/agent.manual.mjs`: мок-endpoint шлёт финальный usage-чанк;
  после прогона проверить `data/ai-usage.json` и enriched summaries.

## План реализации (итерации)

1. **Захват + цены**: `client.ts` (usage, составной возврат, оба
   call-сайта), `web-search.ts`, `pricing.ts` + тесты — зелёный `npm test`,
   поведение агента не меняется.
2. **Журнал + запись**: `usage.ts` (стор, отчёт), `agent.ts`
   (`recordUsage` + WS `usage`), тесты стора/отчёта.
3. **API**: enrichment summaries/dialogue, `GET /api/ai/usage`.
4. **Web**: types, бейдж в AgentPage (+«История»), `fetchAiUsage`,
   `AiCostsPage`, `App.tsx` (сайдбар + слот).
5. **Финал**: ручной сценарий (`agent.manual.mjs`), `npm run build` в
   обоих каталогах, `npm test`, `npm audit`; обновить `AGENTS.md` (data/:
   `ai-usage.json` + `ai-prices.json`; инвариант «стоимость фиксируется в
   момент вызова; цены — дефолты + data/ai-prices.json»; WS-событие),
   `docs/architecture.md` (раздел «Учёт расходов AI»), эпик в
   `docs/roadmap.md`.

Каждая итерация — самостоятельно зелёная (build + test).

## Оценка

Захват + прайсы ~0,5 дня; журнал + запись ~0,5; API ~0,25; web ~0,5–1;
финал ~0,25. Итого v1 ~2 дня. Редактор цен в UI, графики, экспорт —
итерации v2.

## Риски

- **Провайдер без `include_usage`** → usage нет, записи нет — диалог
  покажет «—». OpenAI/DeepSeek поддерживают; документируем в плане.
- **Прерванный стрим не учитывается.** При остановке пользователем,
  обрыве соединения или таймауте финальный usage-чанк не приходит —
  уже потраченные токены уходят мимо журнала. Итоги поэтому «не
  меньше реального биллинга, а занижены на прерванные вызовы»;
  сверка с биллингом провайдера — вне темы.
- **Строгий прокси отвергает `stream_options`** (400) — редкий случай;
  если встретится, добавить retry без поля (не в v1).
- **Актуальность дефолтных цен** — цены меняются; оверрайд-файл закрывает,
  `unpricedCalls` в отчёте подсвечивает модели без цены. Тарификация
  серверного `web_search` у DeepSeek сверена при реализации: оплачивается
  токенами модели поиска, отдельной цены за запрос нет — вызовы поиска
  считаются по токенам (`webSearchPerRequestUsd` — только для провайдеров
  с поштучной оплатой, напр. Anthropic).
- **Часовой пояс дней** — локальное время контейнера (обычно UTC);
  «сегодня» в отчёте может не совпадать с календарным днём
  пользователя. При необходимости задать `TZ` в compose.
- **Рост `ai-usage.json`** — единицы МБ на тысячи диалогов, для
  локального инструмента приемлемо; компакция — если когда-нибудь станет
  проблемой.
- **Перезапись файла на каждый вызов API** — `recordUsage` пишет весь
  журнал (tmp+rename) на каждый шаг агента: десятки перезаписей за
  длинный диалог при файле в единицы МБ. Приемлемо для v1; следить за
  размером, при росте — батчить persist (по таймеру/на `done`).
