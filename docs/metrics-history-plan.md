# План: история нагрузки (CPU/RAM) с графиками на «Серверах» и «Обзоре»

Статус: реализовано (`/api/metrics-history`, графики `LoadChart`/`Sparkline` — см. `docs/architecture.md`). Задача — «оживить» общий экран «Серверы» и главную вкладку сервера «Обзор» графиками нагрузки за период связи с сервером.

## Идея

Копить историю метрик **на сервере в памяти** (in-memory ring buffer на профиль, без записи на диск — по образцу реестра туннелей) и кормить её «бесплатно» из уже идущих опросов:

- сайдбар опрашивает `/api/overview` каждые 10 с, пока открыт интерфейс;
- вкладка «Обзор» — `/api/metrics` каждые 3 с;
- вкладка «Серверы» — `/api/overview` каждые 5 с.

Все пути сходятся в `collectMetrics` (`server/src/services/metrics.ts`) — туда и встраиваем снятие сэмпла. Ни одной лишней SSH-команды; история накапливается ровно «за период связи с сервером» и начинается заново после рестарта контейнера.

Графики — **свой SVG-компонент без новых зависимостей** (в проекте нет chart-библиотек, тянуть recharts/uPlot ради двух спарклайнов не хочется): компактные спарклайны в карточках «Серверы», покрупнее charts в карточках «Процессор»/«Память» на «Обзоре». Проценты CPU и RAM (шкала 0–100), разрывы данных (null) — разрывы линии.

## Сервер

### 1. Новый `server/src/services/metrics-history.ts`

По образцу существующих in-memory реестров (`services/tunnels.ts`, `services/external-ip.ts`):

- Тип сэмпла — лёгкий срез `ServerMetrics` (процессы и диски не храним):

  ```ts
  export interface HistorySample {
    t: number;            // мс, серверное время ssh-commander (= ServerMetrics.timestamp)
    cpu: number | null;   // cpu.percent
    memPct: number | null;        // memory.usedPercent
    memUsedBytes: number | null;  // memory.usedBytes
    memTotalBytes: number | null; // memory.totalBytes
    load1: number | null;         // loadAverage[0]
  }
  ```

- Хранилище: module-level `Map<profileId, HistorySample[]>`.
- `appendSample(profileId, metrics: ServerMetrics)`:
  - дедуп по timestamp — кэш `collectMetrics` (TTL 2 с) возвращает тот же промис → тот же timestamp, повторно не пишем; минимальный гэп между сэмплами 2 с;
  - лимиты: 4320 сэмплов на профиль (~12 ч при 10-с опросе, ~3,5 ч при плотном 3-с) и максимальный возраст 24 ч.
- `getHistory(profileId)` / `getAllHistory()` — отдача копий с децимацией (см. ниже).
- `clearHistory(profileId)` — вызывается при удалении профиля.
- Чистые функции экспортируются отдельно для тестов: `toSample`, `shouldAppend`, `trimSamples`, `decimate` (равномерный шаг выбора точек, последняя точка сохраняется всегда).

### 2. Хук в `server/src/services/metrics.ts`

В `collectMetrics` после успешного `parseMetricsOutput(result.stdout)` → `appendSample(profile.id, snapshot)`. Автоматически покрывает оба источника: `/api/metrics` и `/api/overview` (probeProfile).

### 3. Новый `server/src/routes/metrics-history.ts` + регистрация в `index.ts`

- `GET /api/metrics-history?profileId=` → `{ timestamp, samples }` — сэмплы одного профиля, децимация до ≤360 точек (для «Обзора»).
- `GET /api/metrics-history` (без profileId) → `{ timestamp, profiles: [{ id, samples }] }` — по всем профилям из реестра, ≤120 точек на профиль (для «Серверов»).
- Регистрация: `app.use('/api/metrics-history', requireAuth, metricsHistoryRouter)` в `server/src/index.ts`.

### 4. `server/src/routes/profiles.ts`

В DELETE-хендлере (`profilesRouter.delete('/:id')`) вызвать `clearHistory(id)` — история удалённого профиля не висит в памяти.

## Фронтенд

### 5. Новый `web/src/components/Sparkline.tsx`

Чистый SVG: viewBox `0 0 100 100`, `preserveAspectRatio="none"` (растягивается по контейнеру), `vector-effect="non-scaling-stroke"` (толщина линии не искажается). Линия + заливка с прозрачностью; `null` — разрыв линии; пустое состояние (меньше 2 сэмплов) — приглушённый текст «История собирается…».

Два вида:

- `Sparkline` — компактный (~28 px высотой) для карточек «Серверов»;
- `LoadChart` — для «Обзора»: шапка со статистикой (мин / сред / макс за период), период по размаху `t` («за последний час», «за 46 мин»), подписи времени начала/конца (`toLocaleTimeString('ru-RU')`), высота ~96–120 px.

Цвета — существующие CSS-переменные из `styles.css` (CPU — `--accent`, память — `--ok`), тёмная/светлая темы работают автоматически.

### 6. `web/src/api.ts`

Типы `HistorySample` и двух ответов + `fetchMetricsHistory(profileId)` / `fetchBulkHistory()`.

### 7. `web/src/pages/OverviewPage.tsx`

- В существующем poll-тике — второй запрос истории (`fetchMetricsHistory`); ошибки истории обрабатываются тихо (графики декоративные, последний график остаётся на экране).
- `LoadChart` CPU — в карточку «Процессор», RAM — в карточку «Память» (под текущими `Meter`, которые остаются).

### 8. `web/src/pages/ServersPage.tsx`

- В poll-тике — bulk-запрос истории (`fetchBulkHistory`), тихие ошибки.
- В `ServerCard` — спарклайны под `Meter` в блоках CPU и Память; данные выбираются из bulk-ответа по `entry.id`.

### 9. `web/src/styles.css`

Стили: `.sparkline`, `.load-chart`, шапка/статистика/подписи времени, пустое состояние — всё на CSS-переменных, без хардкода цветов.

## Тесты и проверка

- Новый `server/test/metrics-history.test.ts` (по образцу `overview.test.ts` — только чистые функции):
  - маппинг `toSample`;
  - `shouldAppend` — дедуп по timestamp, минимальный гэп;
  - `trimSamples` — обрезка по количеству и по возрасту;
  - `decimate` — равномерность, сохранение последней точки, n ≤ max без изменений, пустой массив;
  - roundtrip append/get с очисткой состояния между тестами.
- Перед сдачей: `cd server && npm run build && npm test`, `cd web && npm run build` — зелёные.
- Обновить `AGENTS.md` (новый сервис, маршруты, тест — в принятом формате разделов «Архитектура сервера», «REST и WebSocket API», «Тестирование»).

## Намеренно выброшенное (можно добавить потом)

- Персистентность истории на диск (сейчас после рестарта контейнера история копится заново — как у туннелей).
- Tooltip / hover по графикам.
- Графики load average и диска (load1 уже сохраняется в сэмпл — на будущее).

## Затронутые файлы

| Файл | Изменение |
|---|---|
| `server/src/services/metrics-history.ts` | новый — реестр истории |
| `server/src/services/metrics.ts` | хук `appendSample` в `collectMetrics` |
| `server/src/routes/metrics-history.ts` | новый — роут |
| `server/src/index.ts` | регистрация роута |
| `server/src/routes/profiles.ts` | `clearHistory` при удалении профиля |
| `server/test/metrics-history.test.ts` | новый — unit-тесты |
| `web/src/components/Sparkline.tsx` | новый — SVG-графики |
| `web/src/api.ts` | типы + fetch-функции |
| `web/src/pages/OverviewPage.tsx` | LoadChart в карточки CPU/RAM |
| `web/src/pages/ServersPage.tsx` | спарклайны в карточках серверов |
| `web/src/styles.css` | стили графиков |
| `AGENTS.md` | документация фичи |
