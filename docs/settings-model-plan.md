# План: единая модель настроек и секретов (эпики 21–24)

> **Статус: согласовано, готово к реализации.** Продолжение onboarding
> (`docs/onboarding-plan.md`, реализован). Заменяет `docs/settings-plan.md`
> (тот план считать устаревшим — экран «Настройки» здесь, эпик 23).
>
> Решения, из которых вырос план:
> 1. **Один источник правды в рантайме — `data/settings.json`.** Env не
>    мержится на каждый запрос, а используется **один раз как seed при
>    первом старте**: если `settings.json` нет, а env задан — значения
>    копируются в settings (пароль хешируется). Дальше env не читается
>    никогда; изменение `.env` после первого старта ни на что не влияет.
>    Seed — это и есть «скрытая миграция» для существующих установок:
>    при обновлении контейнер перезапускается, settings.json у них нет,
>    env задан → файл создаётся сам.
> 2. **Модель и провайдер AI — тоже в settings** (не env): пресет провайдера
>    без модели не работает (дефолт `AI_MODEL=gpt-4.1-mini` не существует
>    у DeepSeek), поэтому пресет несёт `{apiBase, модель, есть ли поиск}`.
> 3. **DeepSeek — основной путь v1** (чат + веб-поиск по одному ключу).
>    OpenAI/свой URL остаются, но с явной подписью «веб-поиск недоступен».
>    Мульти-провайдерный поиск — отдельная история будущего (roadmap,
>    backlog).
> 4. **Язык агента = язык интерфейса.** `AI_LANG` умирает: язык приходит
>    от клиента по WS-подключению агента.
> 5. Управление после первого старта — только через страницу «Настройки»
>    (эпик 23) или правкой `data/settings.json` + рестарт.

Эпики выполняются строго по порядку: 21 чинит баги уже реализованного
onboarding, 22 меняет модель хранения, 23 строится поверх неё, 24 —
независимый, но дешевле делать последним (трогает те же файлы конфига).

---

## Эпик 21. Доработка onboarding (фиксы ревью)

Маленький эпик, только исправления. Ничего не ломает, тесты дополняются.

### Баг 1: onboarding молча перекрывает env-конфиг AI

**Проблема.** `web/src/pages/OnboardingPage.tsx`: `aiApiBase` отправляется
всегда (пресет DeepSeek — дефолт селекта), даже когда поле ключа пустое.
Пользователь, у которого AI настроен в env, а `APP_PASSWORD=admin`,
проходит onboarding, задаёт только пароль → в `settings.json` записывается
`aiApiBase: https://api.deepseek.com/v1`, и мерж «settings поверх env»
начинает перекрывать его env-базу.

**Фикс.** В `submit()` отправлять `aiApiBase` только вместе с непустым
`aiApiKey`:

```ts
const key = apiKey.trim();
await submitSetup({
  password,
  aiApiKey: key || undefined,
  aiApiBase: key ? base || undefined : undefined,
});
```

### Баг 2: ложное предупреждение про дефолтный пароль

**Проблема.** `server/src/index.ts` (блок `server.listen`): условие
`config.appPassword === 'admin' && !onboardingRequired()` срабатывает
ровно тогда, когда хеш в settings **есть** (env-пароль уже не
используется) — warning «using default password» стал чистым ложным
срабатыванием. Единственный честный случай (env-дефолт, настроек нет)
покрывается onboarding'ом.

**Фикс.** Удалить весь блок warning про дефолтный пароль (4 строки).
Warning про отсутствие AI-ключа оставить.

### Мелочи

- `server/src/ai/client.ts`: в `streamChatCompletion` переменная `apiKey`
  деструктурирована из `getAiConfig()`, но не используется — в headers
  повторно вызывается `getAiConfig().apiKey`. Использовать деструктурированное
  значение (`authorization: \`Bearer ${apiKey}\``), второй вызов убрать.
- `web/src/api.ts`: хелпер `fetchSetupStatus()` экспортирован, но не
  используется — `App.tsx` дёргает `api<{required}>('/api/setup/status')`
  напрямую. Перевести `App.tsx` на `fetchSetupStatus()`.
- Гонка при завершении onboarding: в bootstrap-эффекте `App.tsx` ветка
  `required` ставит `setAuthed(true)` — из-за этого стартует сайдбар-опрос
  (`useEffect` по `authed`), который делает неавторизованный
  `/api/overview` → 401 → глобальный обработчик `setAuthed(false)`. Если
  этот 401 придёт после успешного `POST /api/setup`, пользователя выкинет
  на логин сразу после настройки. **Фикс:** в ветке `required` ставить
  `setAuthed(false)` вместо `true` (guard `if (onboarding)` в рендере
  стоит раньше `if (!authed)`, экран не изменится; опрос по `authed` не
  стартует).
- Права на файл: в `services/settings.ts` `saveSettings` писать tmp-файл
  с `mode: 0o600` (`fs.writeFileSync(tmp, data, { mode: 0o600 })` — при
  rename права переезжают с tmp). Файлы, записанные до этой правки,
  сохранят старые права до следующей записи — принимаем, ручную миграцию
  прав не делаем.
- `docs/onboarding-plan.md`: пометить статус «реализован».

### Тесты эпика 21

- `server/test/settings.test.ts`: права созданного файла —
  `(fs.statSync(path).mode & 0o777) === 0o600`.
- Остальное покрыто существующими; прогон `npm run build` + `npm test`
  (server), `npm run build` + `npm run lint` (web).

---

## Эпик 22. Единое хранилище: seed из env, провайдер и модель в settings.json

Самый объёмный эпик. Меняет модель конфигурации; обратная совместимость —
через seed.

### Модель данных (`server/src/services/settings.ts`)

`AppSettings` расширяется:

```ts
export type AiProvider = 'deepseek' | 'openai' | 'custom';

export interface AppSettings {
  passwordHash?: string;   // теперь опционален: seed может записать только AI-поля
  aiProvider?: AiProvider; // какой пресет выбран (нужен для статуса поиска и UI)
  aiApiKey?: string;
  aiApiBase?: string;
  aiModel?: string;
}
```

Zod-схема — соответственно (`aiProvider: z.enum(['deepseek','openai','custom']).optional()`,
`aiModel: z.string().optional()`). Поле `passwordHash` делаем опциональным:
seed при заданном только `AI_API_KEY` пишет AI-поля без пароля, и onboarding
должен остаться доступным.

**Важно:** старые файлы `settings.json` (только `passwordHash`/`aiApiKey`/
`aiApiBase`) остаются валидными — новые поля опциональны.

### Seed (`services/settings.ts`)

Новая функция, вызывается из `index.ts` при старте (после `ensureDirs`,
до `server.listen`):

```ts
export function seedSettingsFromEnv(): void {
  if (getSettings() !== null) return;        // settings есть → env игнорируем
  if (corrupt-флаг поднят) return;           // corrupt-guard: не трогаем битый файл
  const hasPassword = Boolean(config.appPassword);
  const hasAi = Boolean(config.ai.apiKey);
  if (!hasPassword && !hasAi) return;        // сеять нечего → onboarding
  saveSettings({
    passwordHash: hasPassword ? hashPassword(config.appPassword) : undefined,
    aiProvider: hasAi ? providerFromBase(config.ai.apiBase) : undefined,
    aiApiKey: config.ai.apiKey || undefined,
    aiApiBase: config.ai.apiKey ? config.ai.apiBase : undefined,
    aiModel: config.ai.apiKey ? config.ai.model : undefined,
  });
  console.log('settings.json seeded from environment');
}
```

- `providerFromBase(base)`: подстрока `api.deepseek.com` → `'deepseek'`,
  `api.openai.com` → `'openai'`, иначе `'custom'`. Эвристика только для
  seed'а и UI-подписи, на логику не влияет.
- Corrupt-guard: при битом файле seed не должен ни перезаписывать его
  (saveSettings сам бросит — ловим и warn), ни блокировать старт сервера.

### Триггер onboarding

`onboardingRequired()` упрощается до `!load()?.passwordHash`. Env-пароль
больше не участвует: если он задан, seed уже записал хеш. Это честнее
старого правила «env = admin считаем неконфигурацией».

**`docker-compose.yml`:** убрать дефолт у `APP_PASSWORD` —
`- APP_PASSWORD=${APP_PASSWORD:-}` (пусто = не задан; seed его пропустит,
покажется onboarding). `config.ts`: `appPassword: process.env.APP_PASSWORD || ''`.

### Чтение AI-конфига: мерж умирает

`getAiConfig()` заменяется на чтение только из settings:

```ts
const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1-mini';

export function getAiSettings(): {
  provider: AiProvider | null;
  apiKey: string;   // '' — агент недоступен
  apiBase: string;
  model: string;
} {
  const s = load();
  return {
    provider: s?.aiProvider ?? null,
    apiKey: s?.aiApiKey ?? '',
    apiBase: s?.aiApiBase ?? DEFAULT_API_BASE,
    model: s?.aiModel ?? DEFAULT_MODEL,
  };
}
```

Дефолты base/model — константы кода, **не env**: env значения уже посеяны
в settings при первом старте. `config.ai.apiBase/apiKey/model` остаются
только как вход для seed (комментарий в `config.ts` обновить).

Потребители:
- `server/src/ai/client.ts` — `streamChatCompletion`: `apiBase`, `apiKey`,
  `model` из `getAiSettings()` (сейчас `model: config.ai.model`).
- `server/src/ai/web-search.ts` — ключ из `getAiSettings().apiKey`.
- `server/src/index.ts` — warning про отсутствие ключа: `getAiSettings().apiKey`.

### Веб-поиск при провайдере DeepSeek — из коробки

`isSearchConfigured()` (`server/src/ai/web-search.ts`):

```ts
const DEEPSEEK_SEARCH_BASE = 'https://api.deepseek.com/anthropic';
// Константа, не настройка: только этот endpoint поддерживает серверный
// инструмент web_search у DeepSeek. Менять/выносить в UI нельзя.

export function isSearchConfigured(): boolean {
  const ai = getAiSettings();
  if (!ai.apiKey) return false;
  // DeepSeek-пресет: поиск включён автоматически (2 в 1, тот же ключ).
  if (ai.provider === 'deepseek') return true;
  // Остальные: поиск только при явно заданном env AI_SEARCH_API_BASE
  // (обратная совместимость; позволяет связку «чат OpenAI + поиск DeepSeek»).
  return Boolean(config.ai.searchApiBase);
}
```

`searchWeb()`: база поиска — `provider === 'deepseek' ? DEEPSEEK_SEARCH_BASE
: config.ai.searchApiBase`. `AI_SEARCH_API_BASE`/`AI_SEARCH_MODEL` остаются
env-only (оверрайд/выключение для не-DeepSeek). Модель поиска —
`config.ai.searchModel` как раньше.

### POST /api/setup — мерж, а не перезапись

Сейчас setup перезаписывает settings целиком. С seed'ом это затирало бы
посеянный ключ пустым полем формы. Новые правила (`routes/setup.ts`):

- `passwordHash` — записывается всегда (это суть onboarding).
- AI-поля — только если в форме введён ключ: тогда пишем
  `aiProvider`/`aiApiKey`/`aiApiBase`/`aiModel` из тела. Ключ не введён →
  существующие AI-поля (посеянные) сохраняются.
- Тело расширяется: `{ password, aiApiKey?, aiProvider?, aiApiBase?, aiModel? }`.
  `aiProvider` — enum, обязателен при переданном `aiApiKey` (zod
  `.superRefine` или ручная проверка → 400). `aiModel` — непустая строка
  без пробелов, обязателен при переданном `aiApiKey`.
- Реализация: `const prev = getSettings() ?? {}; saveSettings({ ...prev, passwordHash: hashPassword(password), ...(key ? { aiProvider, aiApiKey, aiApiBase, aiModel } : {}) })`.

### Фронтенд onboarding (`web/src/pages/OnboardingPage.tsx`)

- Пресеты несут base и модель:

```ts
const PROVIDERS: Record<Provider, { base: string; model: string }> = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  openai:   { base: 'https://api.openai.com/v1',   model: 'gpt-4.1-mini' },
  custom:   { base: '',                            model: '' },
};
```

- Новое поле «Модель» (текстовое, под селектом провайдера): при смене
  провайдера подставляется модель пресета, остаётся редактируемым. Для
  `custom` — пустое, обязательно к заполнению при введённом ключе.
- Поле Base URL показывается при `custom` (как сейчас); для пресетов base
  берётся из таблицы.
- Подпись про поиск под селектом:
  - `deepseek` → `onboarding.searchAvailable`: «Веб-поиск включён
    автоматически — тот же ключ».
  - `openai`/`custom` → `onboarding.searchUnavailable`: «У этого провайдера
    веб-поиск недоступен (работает только с DeepSeek)».
- Submit отправляет `aiProvider`, `aiApiBase`, `aiModel` — только вместе
  с непустым ключом (правило бага 1 эпика 21 сохраняется).
- i18n: новые строки `onboarding.modelLabel`, `onboarding.modelPlaceholder`,
  `onboarding.searchAvailable`, `onboarding.searchUnavailable` — в оба
  словаря сразу.

### Тесты эпика 22

- `settings.test.ts` (переработка):
  - seed: env пароль+ключ → settings на диске (пароль хешем), повторный
    вызов не трогает файл; seed при существующем settings — no-op; seed
    только с `AI_API_KEY` (без пароля) → файл без `passwordHash`,
    `onboardingRequired() === true`; seed без env → файла нет;
  - `onboardingRequired()`: есть хеш → false, нет хеша → true (ветки
    «env-дефолт» больше нет — старый тест про кастомный env-пароль
    заменить на тест seed'а);
  - `verifyPassword` — только хеш; без настроек → false (старый тест
    env-фолбэка удалить);
  - `getAiSettings`: пусто → дефолты констант, частично заполненные
    settings → мерж с константами, `providerFromBase` — три ветки.
- `setup-route.test.ts`: перед тестами посеять AI-поля (saveSettings без
  пароля), успешный setup без ключа → посеянные AI-поля сохранились;
  setup с ключом → все четыре AI-поля из тела; ключ без `aiProvider`/
  `aiModel` → 400.
- `client.test.ts`, `web-search.test.ts`: env-моки AI_API_KEY/AI_API_BASE/
  AI_MODEL больше не работают — в `beforeAll` писать settings через
  `saveSettings({ aiApiKey: 'test-key', aiApiBase: 'http://mock-api',
  aiModel: 'test-model', aiProvider: 'custom' })`. Проверить, что
  `isSearchConfigured()` тесты переведены на provider-ветку (deepseek →
  true без env; custom + env-база → true; custom без env → false).

### Документация эпика 22

- `AGENTS.md`: таблица env — у `APP_PASSWORD`, `AI_API_KEY`, `AI_API_BASE`,
  `AI_MODEL` пометка «только seed при первом старте; дальше —
  `data/settings.json` и страница «Настройки»; изменение env после первого
  старта ни на что не влияет». Инвариант onboarding переписать под модель
  seed + merge в setup. `DATA_DIR` — добавить `settings.json` в перечень
  (уже есть, дополнить полями).
- `.env.example`: тот же смысл — комментарии «используется один раз при
  первом старте».
- `docs/architecture.md`: раздел onboarding переписать под seed-модель,
  состав `settings.json`, правила поиска по провайдеру.
- `README.md`/`README.ru.md`: блок про конфигурацию AI — «задаётся при
  первом старте в интерфейсе; env — для headless-первого-запуска».

---

## Эпик 23. Страница «Настройки» (замена settings-plan.md)

Поверх эпика 22. Глобальная страница в сайдбаре (вне таббара профиля,
как «Расходы AI»). Отличия от старого `docs/settings-plan.md`: env-фолбэка
больше нет (`passwordVia` не нужен), добавляются провайдер и модель,
очистка ключа = «агент недоступен» (возврата к env нет).

### Бэкенд

`routes/settings.ts` (новый), монтирование **с** `requireAuth` в `index.ts`:

- `GET /api/settings` →
  `{ ai: { provider: AiProvider | null, apiKeySet: boolean, apiBase: string,
  model: string, searchAvailable: boolean } }`.
  Ключ **никогда не возвращается** — только факт «задан». `searchAvailable`
  — результат `isSearchConfigured()` (чтобы UI показывал честный статус
  поиска, включая env-оверрайд для не-DeepSeek).
- `PUT /api/settings` — тело (все поля опциональны, zod):
  - `{ currentPassword, newPassword }` — смена пароля: `currentPassword`
    проверяется через `verifyPassword`, неверный → 400 «Неверный текущий
    пароль»; `newPassword` ≥ 8, без `\n`/`\r` (та же схема, что в setup).
    Поля пароля идут только парой.
  - `{ aiApiKey, aiProvider, aiApiBase, aiModel }` — замена AI-конфига:
    все четыре обязательны при наличии любого из них (zod); валидация как
    в setup (ключ без пробелов, base http/https со срезом `/`, модель без
    пробелов). `aiApiKey: null` — очистка ключа (AI-поля удаляются, агент
    недоступен — честный статус в UI).
  - Пустое `{}` → 400.
  - Успех → обновлённый GET-ответ.
  - Реализация: `updateSettings(patch)` в `services/settings.ts` — мерж
    поверх текущих (`saveSettings({ ...current, ...patch })`, `null`/
    `undefined` у AI-полей = удаление ключа из объекта).
- Сессии при смене пароля не инвалидируются (single-user, in-memory;
  как раньше). Rate-limit не нужен — страница за авторизацией.

### Фронтенд

`web/src/pages/SettingsPage.tsx` (новый), по образцу `AiCostsPage`
(глобальная страница без keep-alive; данные — `GET` при монтировании):

- Секция «Пароль»: текущий + новый + подтверждение, клиентская проверка
  длины/совпадения, кнопка «Сменить пароль» → `PUT` → toast «Пароль
  изменён» (сессия жива), поля очищаются.
- Секция «AI»: селект провайдера (те же пресеты, что в onboarding —
  вынести `PROVIDERS` в общий модуль, например `web/src/ai-providers.ts`,
  и импортировать из OnboardingPage), поле ключа (placeholder «Ключ задан»
  / «Ключ не задан — агент недоступен» по `apiKeySet`; ввод заменяет),
  поле Base URL (при `custom`), поле «Модель», кнопки «Сохранить» и
  «Очистить ключ» (с подтверждением через `confirm()`).
- Подпись статуса поиска: по `searchAvailable` — «Веб-поиск включён» /
  «Веб-поиск недоступен у этого провайдера (работает с DeepSeek)».
- Все действия через try/catch → toast (общий паттерн).
- `App.tsx`: пункт сайдбара «Настройки» рядом с «Серверы»/«Расходы AI»
  (labelKey `app.settings`), рендер как у `AiCostsPage`.
- `web/src/api.ts`: `fetchSettings()`, `updateSettings()`.
- i18n: все строки `settings.*` — в оба словаря (паритет типами +
  `server/test/i18n.test.ts`).

### Тесты эпика 23

- `server/test/settings-route.test.ts` (новый): GET не утекает ключ
  (в ответе нет значения ключа, только `apiKeySet`), `searchAvailable`
  обе ветки; PUT: смена пароля с верным/неверным текущим, длина нового;
  замена AI-конфига целиком; частичный AI-патч → 400; очистка ключа
  (`null`) → `apiKeySet: false`; пустое тело → 400; оба роута под
  `requireAuth` (401 без cookie).
- `settings.test.ts`: `updateSettings` — мерж, удаление AI-полей.
- Фронт: lint + ручной проход (смена пароля → старый не пускает, новый
  пускает; замена ключа → агент ходит новым ключом без рестарта; очистка
  → честный «агент недоступен»).

### Документация эпика 23

- `AGENTS.md`: роуты `/api/settings`; инвариант «смена секретов — только
  через «Настройки» или правкой файла + рестарт».
- `docs/architecture.md`: страница «Настройки», роуты, состав ответа GET.
- `docs/settings-plan.md`: пометить «заменён `docs/settings-model-plan.md`
  (эпик 23)».

---

## Эпик 24. Язык агента = язык интерфейса (`AI_LANG` умирает)

Язык агента больше не конфигурация развёртывания: он следует за
переключателем языка UI (`sc-lang`). Отдельный `AI_LANG` только рассинхронил
бы («UI русский, агент отвечает по-английски» выглядит багом).

### Протокол

Язык приходит от клиента параметром WS-подключения агента (как `dialogueId`):

- `web/src/pages/AgentPage.tsx` (строка подключения, сейчас ~356):
  `/ws/agent?profileId=…&dialogueId=…&lang=${lang}` — `lang` из `useT()`.
  Добавить `lang` в deps эффекта подключения: смена языка пересоздаёт WS
  (сессия переподключается, диалог тот же — `dialogueId` сохраняется;
  это редкое действие, обрыв стрима на середине приемлем — как при смене
  профиля).
- `server/src/index.ts` (upgrade-обработчик, ветка `/ws/agent`):
  `const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ru';`
  (мусор → `ru`, не валимся), передать в `handleAgentWs(ws, profile,
  dialogueId, lang)`.
- `server/src/ws/agent.ts`: `handleAgentWs` принимает `lang`, прокидывает
  в `attachAgent`.

### Сервер

- `server/src/ai/agent.ts`: `AgentSession` — новое поле `private readonly
  lang: PromptLang` (параметр конструктора, `attachAgent` пробрасывает).
  Три использования `config.ai.lang` заменить на `this.lang`:
  - сборка системного промпта (~строка 117),
  - `planApprovedMessage(config.ai.lang)` (~строка 307),
  - `memoryPromptBlock(target.id, config.ai.lang)` (~строка 757).
- `server/src/ai/plan.ts`: модульная константа `PLAN_MODE_INSTRUCTION`
  умирает — `buildPlanRequestMessages(messages, lang)` принимает язык
  параметром и вызывает `planModeInstruction(lang)`. Места вызова
  (runPlan в `agent.ts`) передают `this.lang`.
- `server/src/config.ts`: удалить `ai.lang` (и комментарий).
- `server/src/ai/prompts.ts`, `memory.ts`: сигнатуры уже параметризованы
  `lang` — без изменений, обновить только шапки комментариев
  («язык — параметр сессии, приходит от клиента по WS»).

### Конфигурация и документация

- `docker-compose.yml`: убрать строку `AI_LANG`.
- `.env.example`: убрать `AI_LANG` (комментарий: язык агента следует за
  языком интерфейса).
- `AGENTS.md`: строка `AI_LANG` из таблицы — удалить; в шапке «системный
  промпт агента — по `AI_LANG`» → «язык агента = язык интерфейса
  (передаётся параметром WS-подключения)». Инвариант про `prompts.ts`
  обновить.
- `docs/architecture.md`: абзац про слой 3 i18n — переписать (язык —
  параметр сессии агента из WS-query `lang`, дефолт `ru`).
- `README.md`/`README.ru.md`: строки про `AI_LANG` — заменить на «язык
  агента совпадает с языком интерфейса».

### Тесты эпика 24

- Существующие тесты выбора промпта (`AI_LANG=en` → английский промпт) —
  перевести с env на параметр: конструкция сессии/вызов
  `buildPlanRequestMessages(messages, 'en')`.
- Новый мелкий тест: парсинг `lang` в upgrade-ветке — `en` → en,
  `ru`/мусор/отсутствие → `ru` (вынести в чистую функцию
  `parseAgentLang(param: string | null): PromptLang` в `ws/agent.ts` или
  `ai/prompts.ts` — и тестировать её, не поднимая WS).
- Ручной проход: переключение языка UI → следующий ответ агента на новом
  языке, история диалога не ломается (старые сообщения остаются на своём
  языке — это данные, не переводятся).

---

## Общие правила для всех четырёх эпиков

- Перед сдачей каждого эпика: `cd server && npm run build && npm test`,
  `cd web && npm run build && npm run lint` — зелёные (pre-commit хук
  гоняет то же самое).
- Все новые UI-строки — сразу в `web/src/i18n/ru.ts` и `en.ts`.
- Комментарии в коде и документация — на русском.
- AGENTS.md и `docs/architecture.md` обновляются в том же коммите, что и
  изменение.

## Оценка

| Эпик | Содержание | Оценка |
|---|---|---|
| 21 | Фиксы onboarding | 0.5 д |
| 22 | Seed-модель, провайдер+модель в settings | 1–1.5 д |
| 23 | Страница «Настройки» | 0.5–1 д |
| 24 | Язык агента = язык UI | 0.5 д |

Итого ~2.5–3.5 рабочих дня.
