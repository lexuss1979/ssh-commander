# План: onboarding при первом запуске — пароль и ключ API через интерфейс

> **Статус: план, ждёт согласования.** Цель — убрать обязательность `.env`
> для двух вещей: пароля веб-интерфейса и ключа AI-API. При первом старте
> (чистый `data/`) пользователь задаёт их в UI один раз; дальше приложение
> работает как раньше. `.env` остаётся фолбэком для существующих
> развёртываний и headless-запуска.

## Зачем

Сейчас «первое знакомство» с ssh-commander такое: `cp .env.example .env`,
редактирование `APP_PASSWORD`/`AI_API_KEY`, `docker compose up`. Для
self-hosted-аудитории это привычно, но это лишний шаг между «запустил» и
«пользуешься», а пароль по умолчанию `admin` — известная дыра, если кто-то
забыл его сменить (index.ts:151 уже предупреждает). Onboarding решает обе
проблемы разом: пароль задаётся до первого входа, ключ — там же, в UI.
Бонус: пароль перестаёт лежать открытым текстом в env (хранится хешем).

## Триггер (когда показывается onboarding)

```
onboardingRequired = !settings?.passwordHash && config.appPassword === 'admin'
```

- `settings` — `data/settings.json` (ниже); `config.appPassword === 'admin'` —
  значение env по умолчанию (compose интерполирует `APP_PASSWORD=${APP_PASSWORD:-admin}`,
  поэтому «env не задан» неотличим от «env = admin» — считаем default-значение
  неконфигурацией).
- Существующее развёртывание с кастомным `APP_PASSWORD` в env → onboarding
  **не** показывается, логин работает как раньше (обратная совместимость).
- После onboarding `settings.passwordHash` есть → onboarding больше не
  показывается никогда (даже если env позже вернётся к `admin`).
- Ключ API на триггер не влияет: поле в onboarding опционально, без ключа
  агент просто недоступен (текущее поведение).

## Хранилище `data/settings.json` (сервис `services/settings.ts`)

Паттерн `db-connections.ts`/`profiles.ts`: zod-валидация, атомарная запись
tmp+rename, corrupt-guard (битый файл → `*.corrupt-<timestamp>`, persist
отказывается перезаписывать до рестарта).

```ts
interface AppSettings {
  passwordHash: string; // 'scrypt$<saltHex>$<hashHex>'
  aiApiKey?: string;    // открытым текстом — тот же trust domain, что у
                        // паролей SSH в profiles.json (осознанный компромисс)
  aiApiBase?: string;   // опциональный оверрайд базового URL
}
```

- Хеш пароля — `node:crypto` `scryptSync` + `timingSafeEqual`, **без новых
  зависимостей** (проект избегает тяжёлых зависимостей). Формат
  `scrypt$<salt>$<hash>` — самодостаточный, допускает будущую смену KDF.
- API сервиса:
  - `getSettings(): AppSettings | null` — чтение с диска (файл крошечный,
    кэш не нужен, но чтение оборачиваем в try/catch → null при битом файле);
  - `saveSettings(s)` — атомарная запись;
  - `hashPassword(pw): string`, `verifyPassword(candidate): boolean` —
    хеш из settings, иначе сравнение с `config.appPassword` (фолбэк env);
  - `getAiConfig(): { apiKey, apiBase }` — мерж: settings поверх env
    (`settings.aiApiKey ?? config.ai.apiKey`, `settings.aiApiBase ?? config.ai.apiBase`).
- `data/settings.json` живёт в volume `./data` — onboarding переживает
  пересборки контейнера, повторно не показывается.

## Бэкенд

### Эндпоинты (`routes/setup.ts`, монтирование без `requireAuth`)

- `GET /api/setup/status` → `{ required: boolean }` — по правилу триггера.
  Безопасен: не раскрывает ничего, кроме факта «пароль не настроен».
- `POST /api/setup` — тело `{ password, aiApiKey?, aiApiBase? }`:
  - **409**, если onboarding не required (повторный вызов после успеха —
    защита от перезаписи настроек без авторизации);
  - rate-limit через существующий `isRateLimited` (10 попыток / 15 мин —
    защита от перебора пароля на этапе, когда сессий ещё нет);
  - валидация: `password` — непустая, длина ≥ 8 (согласовано), без `\n`/`\r`;
    `aiApiKey` — опциональная строка без пробелов/переводов строк;
    `aiApiBase` — опциональный URL (валидация протокола http/https, срез
    хвостового `/`, как в config.ts:50);
  - запись `saveSettings`, затем **авто-вход**: `createSession(password)` +
    установка `sc_session` cookie (тот же путь, что у login), сброс
    `resetLoginAttempts` — пользователь попадает в приложение без повторного
    ввода пароля.

### Auth (`src/auth.ts`)

`createSession(password)` переходит с `password !== config.appPassword` на
`verifyPassword(password)` из `services/settings.ts`. Логика: settings-хеш →
scrypt-проверка; настроек нет → сравнение с env (как сейчас). Ошибки
логина/429/401 не меняются.

### AI-клиент

`client.ts:113,145` и `web-search.ts:29,169` читают `config.ai.apiKey`/
`config.ai.apiBase` напрямую — меняем на `getAiConfig()` из settings-сервиса
(4 точки). `AI_SEARCH_API_BASE`/`AI_SEARCH_MODEL` остаются env-only: поиск
DeepSeek использует тот же ключ, что и chat, — заданный в onboarding ключ
включает поиск автоматически, если `AI_SEARCH_API_BASE` задан в env.

### Прочее

- `index.ts:151` — предупреждение про `admin`: при `onboardingRequired`
  не выводим (оно теперь не про «забыли сменить», а про «сейчас спросим»);
  при настроенном env-пароле — как раньше.

## Фронтенд

- `web/src/pages/OnboardingPage.tsx` — экран вместо LoginPage:
  - поле «Пароль» + «Подтверждение» (обязательные, проверка совпадения и
    длины на клиенте, ошибка — toast/инлайн);
  - «Ключ API» (опционально) + селект провайдера: **DeepSeek (по умолчанию) /
    OpenAI / свой URL** → поле «Base URL» при «свой URL»;
  - подпись: «Без ключа агент будет недоступен — его можно добавить только
    здесь или через .env» (честно про ограничение v1);
  - submit → `POST /api/setup` → успех → `setAuthed(true)` (cookie сессии
    уже стоит) — приложение открывается сразу.
- `App.tsx` — bootstrap: перед существующим `GET /api/profiles` сначала
  `GET /api/setup/status`; `required` → состояние `onboarding` → рендер
  OnboardingPage; иначе текущий путь (401 → LoginPage). Guard: пока статус
  не пришёл — прежний loading.
- i18n: все строки экрана — в оба словаря (`onboarding.*`), паритет
  гарантируют типы и `server/test/i18n.test.ts`. Эффект с фиксированными
  deps не затрагивается (onboarding — статичный экран, `t` напрямую).

## Тесты

- `server/test/settings.test.ts` — хранилище: round-trip, zod-отказ, атомарная
  запись, corrupt-guard; хеш: `hashPassword`→`verifyPassword` round-trip,
  неверный пароль, `timingSafeEqual`-путь; `getAiConfig` мерж (settings поверх env).
- `server/test/setup-route.test.ts` — триггер: env-дефолт → required, кастомный
  env-пароль → not required, settings с хешем → not required; POST: валидация
  (короткий пароль, плохой base URL), 409 при не-required, успех → settings
  записаны + сессия создана (cookie), rate-limit.
- Правка существующих auth-тестов под `verifyPassword` (мок settings).
- `server/test/i18n.test.ts` — паритет новых `onboarding.*` (автоматически).
- Фронт: `npm run lint` + ручной проход (onboarding на чистом `data/`,
  логин после, F5 — повторного onboarding нет).

## Совместимость и краевые случаи

- Чистый `data/` + compose default → onboarding; после него — обычный вход.
- Существующий кастомный `APP_PASSWORD` в env → ничего не меняется.
- `settings.json` битый → corrupt-guard + `getSettings() === null` → триггер
  может сработать снова (безопасное направление: пароль не потерян, если
  env-фолбэк не default; при default — честный повторный onboarding).
- Ключ/пароль **нельзя сменить или добавить позже через UI** в рамках этого
  эпика — осознанное ограничение, закрывается следующим эпиком «Настройки»
  (`docs/settings-plan.md`): смена пароля/ключа в UI; до него — только
  правка `data/settings.json` или env+restart.
- Восстановление «забыл пароль» (onboarding уже пройден): не в v1 — это
  локальный файл, владелец машины может удалить `settings.json`.

## Риски

- **Не тот триггер**: кому-то с `APP_PASSWORD=admin` намеренно onboarding
  покажется лишним — это же и есть целевая аудитория (пароль не задан).
- **Авто-вход после setup** расширяет поверхность атаки (пароль можно
  угадать перебором на `/api/setup`) — закрывается rate-limit'ом и тем, что
  endpoint доступен только до первого успешного setup.
- **Регрессия логина** — закрывается unit-тестами `verifyPassword` (обе
  ветки: settings и env).
- **Расхождение словарей** — новые `onboarding.*` в оба файла сразу (типы +
  i18n-тест).

## Документация

- `AGENTS.md` — endpoints `/api/setup/*`, приоритет «settings поверх env» для
  пароля и ключа, инвариант про `data/settings.json`.
- `docs/architecture.md` — сервис `settings.ts` (по образцу хранилищ),
  раздел про onboarding.
- `.env.example` — комментарий: пароль и ключ можно задать при первом
  старте в интерфейсе; env — фолбэк.

## Оценка

~1–1.5 дня (хранилище+хеш — 0.5, роуты+auth+AI-resolver — 0.5, фронт — 0.5).

## Решения (согласованы)

1. Провайдер в onboarding — селект **DeepSeek (по умолчанию) / OpenAI / свой
   URL** (поле Base URL при «свой URL»).
2. Минимальная длина пароля — **≥ 8 символов**.
3. Авто-вход сразу после setup — **да** (`POST /api/setup` создаёт сессию).
4. Эпик «Настройки» (смена пароля/ключа в UI) — **планируется сразу следом**,
   план — `docs/settings-plan.md`.
