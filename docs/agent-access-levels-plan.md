# Уровни доступа AI-агента (Ask Always / Ask When Needed / Never Ask) — план

Статус: v1 реализован (2026-10-08); **v2 (per-dialogue режим) реализован** (2026-10-08, см. «Ревизия v2» внизу — она заменяет разделы про глобальную настройку; детали — `AGENTS.md` и `docs/architecture.md`).

## Зачем

Сейчас **каждый** мутирующий инструмент агента останавливает цикл и ждёт approve/reject в UI (`agent.ts:638-678`). На длинных сценариях («почини nginx, перезапусти контейнеры») это десятки кликов. Даём пользователю выбор уровня доступа:

- **Ask Always** (`always`) — текущее поведение, дефолт. Каждый мутирующий инструмент — через подтверждение.
- **Ask When Needed** (`needed`) — низкорискованные мутации выполняются автоматически, высокорискованные — через подтверждение.
- **Never Ask** (`never`, Full Access) — всё выполняется без подтверждений. Включается **только через явное подтверждение** в UI; если подключённый профиль — root или имеет sudo, показывается усиленное предупреждение с обязательным чекбоксом «Я осознаю возможные риски».

## Текущее состояние (кратко, по коду)

- Точка решения «approve или авто» — ровно одна: `server/src/ai/agent.ts:615` (`isAutoRunnable(name, args)` из `tools.ts:427-432`) + ветка `tool_pending`/`waitDecision` (`agent.ts:638-678`). `runTool` сам approve не проверяет (инвариант зафиксирован в `test/multi-server.test.ts:64-65`) — **решение остаётся только в `runLoop`**.
- `READ_ONLY_TOOLS` — `tools.ts:404-416`; мутирующие: `exec, write_file, write_memory, docker_action, connect_server`. `isAutoRunnable` дополнительно уводит на approve чтение sensitive-путей (`isSensitivePath`/`sensitivePathsIn` из `ai/redact.ts`).
- WS-протокол агента нетипизирован (`Record<string, unknown>`, `agent.ts:76`) — новые поля/события не требуют смены типов, только договорённости. Клиент слушает события в `web/src/pages/AgentPage.tsx:449-542`; бар подтверждения — `PendingBar` (`AgentPage.tsx:1465-1537`), решение — `decide()` (`AgentPage.tsx:264-274`).
- Настройки: `server/src/services/settings.ts` (`AppSettings` `:31-43`, zod `settingsSchema` `:45-51`, `updateSettings` `:238-250` — мерж-патч); REST — `server/src/routes/settings.ts` (`settingsStatus()` `:25-37`, `putBodySchema` `:43-152` с superRefine-правилами, PUT `:154-195`). Фронт — `web/src/components/SettingsModal.tsx` (разделы `SECTIONS` `:27-33`, секция AI — `AiSection` `:226-433`, GET при маунте раздела).
- Про sudo/root сервер знает только `Profile.username` (`server/src/types.ts:1-15`); персистентного знания «есть sudo» нет — `probeSudo` (`services/sudo.ts`) работает только по паролю из конкретного запроса.
- Описания мутирующих инструментов содержат замороженные ru-литералы «Требует подтверждения пользователя.» (`buildToolDefs`, байт-в-байт проверяются `test/agent-lang.test.ts:39-47`) — **их не трогаем**.
- Тест, фиксирующий текущий инвариант: «a mutating tool waits for the user decision and honors reject» (`test/agent-session-headers.test.ts:134-149`) — при дефолте `always` должен остаться зелёным без правок.

## Цели и не-цели v1

Цели:
- Глобальная настройка уровня доступа в `settings.json` + UI в модалке «Настройки» (раздел «AI-агент»).
- Детерминированная классификация риска инструментов для режима `needed`.
- Включение `never` — только с подтверждением; при root/sudo-профиле — с чекбоксом осознания рисков; сервер валидирует факт подтверждения.
- Редакция секретов (`redactSecrets`), allow-лист `exec_readonly` (`guard.ts`), таймауты и лимиты вывода — без изменений во всех режимах.

Не-цели v1:
- Per-profile / per-dialog уровни (настройка глобальная, как весь AI-конфиг).
- Изменение состава или описаний инструментов для модели под режим.
- История/журнал авто-выполненных действий (действия и так видны в ленте диалога как `tool_start`/`tool_result`).
- Изменение planMode: `approve_plan` остаётся как есть.

## Принятые решения

1. **Настройка глобальная**, поле `agentApprovalMode?: 'always' | 'needed' | 'never'` в `settings.json`, дефолт `always` (отсутствие поля = `always`). Однопользовательский локальный инструмент — per-profile гранулярность не нужна; диалог и так мульти-серверный, а сессия одна на профиль.
2. **Решение принимает сервер на каждый вызов инструмента**, читая режим из `getSettings()` (in-memory кэш, дёшево) — смена режима действует на лету, без переподключения WS.
3. **Режим `never` не отключает остальные защиты**: `redactSecrets` в `AgentSession.truncate()`, allow-лист guard для `exec_readonly`, таймауты (60/120 с), лимит 2 МБ — всё остаётся. Отключается только пауза на подтверждение.
4. **Sensitive-чтения** (`read_file`/`exec_readonly` по sensitive-путям): в `always`/`needed` — по-прежнему уходят на approve; в `never` — выполняются (в этом и смысл Full Access; вывод всё равно проходит редакцию секретов перед уходом модели/UI/персисту).
5. **Подтверждение `never` проверяется сервером**: PUT `/api/settings` с `agentApprovalMode: 'never'` обязан нести `riskAcknowledged: true` (одноразовое поле запроса, не персистится), иначе 400. Каждое включение `never` требует нового подтверждения (переключение `never → always → never` — заново).
6. **Проверка root/sudo — отдельный read-only эндпоинт** `GET /api/profiles/:id/privileges`, дёргается лениво фронтом в момент включения `never` для **текущего активного профиля**. При недоступности сервера (ошибка probe) фронт показывает усиленное предупреждение с чекбоксом всегда (fail-closed UX).
7. **UI-контрол — в `SettingsModal`, раздел «AI-агент»** (там же ключ/модель). SettingsModal получает новый prop `activeProfileId` из `App.tsx` для probe.
8. **Описания инструментов (`buildToolDefs`) не меняем** — ru-литералы заморожены тестами. Информацию о режиме модели не сообщаем (v1): промпт и без того требует завершать работу и спрашивать через диалог.

## Классификация риска (режим `needed`)

Новый чистый модуль `server/src/ai/approval.ts`:

```ts
export type AgentApprovalMode = 'always' | 'needed' | 'never';

// Точный список action'ов docker_action сверить со схемой в tools.ts;
// destructive = remove/rm/prune/kill (по факту схемы).
const LOW_RISK_DOCKER_ACTIONS = new Set(['start', 'stop', 'restart' /* + что есть в схеме, кроме удаляющих */]);

const SYSTEM_PATH_PREFIXES = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/root', '/var/lib', '/var/log'];

export function needsApproval(mode: AgentApprovalMode, name: string, args: Record<string, unknown>): boolean {
  if (isAutoRunnable(name, args)) return false;          // read-only и не sensitive — авто во всех режимах
  if (mode === 'never') return false;                     // Full Access
  if (mode === 'always') return true;                     // всё мутирующее — approve
  // mode === 'needed': авто только низкорискованные мутации
  if (name === 'write_memory') return false;
  if (name === 'docker_action') return LOW_RISK_DOCKER_ACTIONS.has(String(args.action));
  if (name === 'write_file') {
    const p = String(args.path ?? '');
    return isSensitivePath(p) || SYSTEM_PATH_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));
  }
  return true; // exec, connect_server, деструктивный docker_action — всегда approve
}
```

Инварианты классификации:
- `exec` (произвольный shell) и `connect_server` — **approve в любом режиме, кроме `never`**.
- Неизвестный инструмент → `true` (approve) — fail-closed.
- В `needed` авто-выполняются: `write_memory` (проходит `redactSecrets` на записи), неразрушающий `docker_action`, `write_file` вне системных и sensitive путей.

## Сервер

### 1. `services/settings.ts`
- `AppSettings`: + `agentApprovalMode?: 'always' | 'needed' | 'never'`.
- `settingsSchema`: + `z.enum(['always', 'needed', 'never']).optional()`.
- Экспорт `getAgentApprovalMode(): AgentApprovalMode` — `getSettings().agentApprovalMode ?? 'always'`.
- `SettingsPatch` (`:228`) — расширить тип.
- `seedSettingsFromEnv` не трогаем (env для режима не вводим).

### 2. `routes/settings.ts`
- `settingsStatus()`: + `agentApprovalMode` (в корень ответа рядом с `ai`, не внутрь `ai` — это не про провайдера).
- `putBodySchema`: + опциональные `agentApprovalMode` (enum) и `riskAcknowledged` (`z.literal(true).optional()`).
- superRefine-правила:
  - `{agentApprovalMode}` (без AI-полей и пароля) — валидный самостоятельный патч, как смена модели.
  - `agentApprovalMode: 'never'` без `riskAcknowledged: true` → 400 «Подтвердите осознание рисков».
  - `riskAcknowledged` без `agentApprovalMode: 'never'` → 400 (лишнее поле).
  - `agentApprovalMode` в комбинации с AI-полями/паролём → 400 (патчи не смешиваем, как сейчас).
  - Правило «пустое `{}` → 400» сохраняется.
- PUT-обработчик: при `agentApprovalMode` — `updateSettings({agentApprovalMode: mode})`, `riskAcknowledged` в settings **не писать**. Ответ — обновлённый `settingsStatus()`.

### 3. `ai/approval.ts` (новый) + `ai/agent.ts`
- `approval.ts` — `needsApproval()` по сигнатуре выше (импорты `isAutoRunnable` из `tools.js`, `isSensitivePath` из `redact.js`; если получится циклический импорт `tools ↔ approval` — `needsApproval` кладём в `tools.ts` рядом с `isAutoRunnable`, режим-параметр остаётся).
- `agent.ts:615`: заменить `const readOnly = isAutoRunnable(name, args)` на `const needsAsk = needsApproval(getAgentApprovalMode(), name, args)`; ветки read-only/pending остаются, условие — `needsAsk`.
- **События в авто-режиме не меняются**: мутирующий инструмент без approve идёт той же веткой `tool_start` → `runTool` → `tool_result` — фронт уже рендерит это карточкой. Новых WS-событий не вводим.
- Для прозрачности в `tool_start` для мутирующих инструментов, выполненных без approve (режим ≠ `always` и инструмент не read-only), добавлять поле `autoApproved: true` — фронт покажет пометку (см. ниже).

### 4. Probe привилегий: `services/privileges.ts` (новый) + `routes/profiles.ts`
- `GET /api/profiles/:id/privileges` (с `requireAuth`, рядом с остальными profile-маршрутами).
- Сервис `getProfilePrivileges(profile, deps?)`:
  - один `exec` по SSH: `sh -c 'echo "uid=$(id -u)"; echo "groups=$(id -nG)"; sudo -n true 2>/dev/null && echo "sudo_np=yes" || echo "sudo_np=no"'` — одна сессия, маркеры, `LC_ALL=C` не критичен, таймаут 15 с.
  - Парсинг: `isRoot = uid === '0'`; `sudo: true` если `sudo_np=yes` **или** groups содержит `sudo|wheel|admin`; иначе `sudo: false`.
  - Кэш 60 с на профиль (как `metricsCache`).
  - Ошибки: нет профиля → 404; транспорт/таймаут → 502 (как `routes/metrics.ts`).
  - Ответ: `{ isRoot: boolean, sudo: boolean }`.
- `deps {execFn?}` — для моков в тестах (паттерн `systemd.ts`).

## Web

### 1. `api.ts`
- `SettingsStatus`: + `agentApprovalMode: 'always' | 'needed' | 'never'`.
- `updateSettings` — тип патча расширить; + `fetchProfilePrivileges(profileId): Promise<{isRoot: boolean, sudo: boolean}>`.

### 2. `SettingsModal.tsx`, раздел «AI-агент» (`AiSection`)
- Проп `activeProfileId: string | null` пробросить из `App.tsx` (там модалка маунтится, `:857-867`).
- Под AI-полями — блок «Уровень доступа агента»: радиогруппа из трёх пунктов с подписями-пояснениями (i18n):
  - `always` — «Спрашивать всегда» — каждое изменяющее действие требует подтверждения (по умолчанию).
  - `needed` — «Спрашивать когда нужно» — безопасные действия автоматически, опасные (произвольные команды, системные файлы, удаление) — с подтверждением.
  - `never` — «Не спрашивать (полный доступ)» — все действия выполняются без подтверждения.
- Выбор `always`/`needed` → сразу `updateSettings({agentApprovalMode})`, ответ обновляет локальный статус.
- Выбор `never` → **модалка подтверждения** (новый компонент `AgentAccessConfirm` в том же файле или отдельным):
  1. При открытии — `fetchProfilePrivileges(activeProfileId)` (если профиля нет — пропускаем probe, `privileges = null`).
  2. `isRoot || sudo` **или probe упал** → красное предупреждение: «Этот сервер подключён под root / пользователь имеет sudo-права. Агент с полным доступом сможет выполнить любую команду, включая необратимое разрушение системы. Мы настоятельно рекомендуем не давать полный доступ.» + чекбокс **«Я осознаю возможные риски»**; кнопка «Включить» disabled, пока чекбокс не отмечен.
  3. Профиль без root/sudo → обычное предупреждение без чекбокса: «Агент сможет выполнять любые действия без подтверждения.» + кнопки «Включить»/«Отмена».
  4. «Включить» → `updateSettings({agentApprovalMode: 'never', riskAcknowledged: true})`; 400 от сервера → показать текст ошибки, радио вернуть на прежний режим.
- Отмена/закрытие модалки — радио остаётся на прежнем режиме.

### 3. `AgentPage.tsx`
- `ToolCard`: если у события `tool_start` был флаг `autoApproved` — маленькая пометка «авто» у лейбла инструмента (нужно прокинуть флаг из WS-события в стейт карточки; хранить `autoApprovedByCallId: Map` рядом с `decidedCalls`).
- Показ текущего режима в шапке панели — **не делаем** (v1), режим виден в настройках.

### 4. i18n
- `web/src/i18n/ru.ts` + `en.ts`: новые ключи `settings.accessLevel`, `settings.accessLevelAlways{,Desc}`, `…Needed…`, `…Never…`, `settings.accessLevelConfirmTitle`, `settings.accessLevelConfirmRoot` (предупреждение root/sudo), `settings.accessLevelConfirmGeneric`, `settings.accessLevelRiskAck` («Я осознаю возможные риски»), `settings.accessLevelEnable`, `agent.autoApproved` («авто»). Оба словаря сразу (паритет — типы + `server/test/i18n.test.ts`).
- Серверные `ai/strings.ts` не трогаем — новых сообщений модели/пользователю от агента нет; тексты ошибок PUT `/api/settings` остаются захардкоженными русскими, как существующие в `routes/settings.ts`.

## Тесты

Новые/изменения (все — `cd server && npm test`, vitest):

1. **`test/agent-approval-mode.test.ts`** (новый, по образцу `agent-session-headers.test.ts`: tmpdir `DATA_DIR`, динамический import, мок `fetch` + мок WS `send`):
   - `always` (дефолт, поле отсутствует): мутирующий `exec` → `tool_pending`, ждёт решения (контрольный, дублирует существующий инвариант под новой точкой решения).
   - `needed`: `write_memory` → авто (нет `tool_pending`, есть `tool_start`+`tool_result`, у `tool_start` `autoApproved: true`); `write_file` на `/home/user/x.txt` → авто; `write_file` на `/etc/nginx/nginx.conf` → `tool_pending`; `write_file` на `/home/user/.env` → `tool_pending` (sensitive); `exec` → `tool_pending`; деструктивный `docker_action` (remove) → `tool_pending`.
   - `never`: `exec` и `write_file` на `/etc/...` → авто, без `tool_pending`.
   - Смена режима «на лету»: между двумя вызовами инструментов `updateSettings({agentApprovalMode})` — второе решение идёт по новому режиму.
2. **`test/approval.test.ts`** (новый) — чистая `needsApproval()`: таблица (режим × инструмент × путь/action), включая fail-closed на неизвестном инструменте.
3. **`test/settings-route.test.ts`** — расширить: GET отдаёт `agentApprovalMode` (дефолт `always`); PUT `{agentApprovalMode:'needed'}` → 200 и GET отражает; PUT `{agentApprovalMode:'never'}` без `riskAcknowledged` → 400; с `riskAcknowledged:true` → 200 и в файле settings `riskAcknowledged` отсутствует; PUT `{riskAcknowledged:true}` без поля → 400; мусорное значение enum → 400; смешение с AI-полями → 400.
4. **`test/settings.test.ts`** — zod-схема принимает/отклоняет `agentApprovalMode`; `updateSettings` мержит.
5. **`test/privileges.test.ts`** (новый) — `getProfilePrivileges` с моком `execFn`: uid=0 → `{isRoot:true,sudo:true}`; uid=1000 + `sudo_np=yes` → sudo true; uid=1000 + группа `wheel` → sudo true; uid=1000 без групп и `sudo_np=no` → оба false; транспортная ошибка → проброс.
6. Существующие `agent-session-headers.test.ts`, `multi-server.test.ts`, `agent-lang.test.ts`, `plan.test.ts`, `i18n.test.ts`, `ai-strings.test.ts` — **должны остаться зелёными без правок** (дефолт `always` + неизменные литералы). Если `agent-session-headers` собирает сессию с реальным `settings.ts` — убедиться, что tmpdir `DATA_DIR` даёт пустой settings → дефолт `always`.

## План реализации (итерации)

Каждая итерация — самостоятельно зелёная (`npm run build` в server и web, `npm test`, `npm run lint` в web).

1. **Сервер, ядро**: `ai/approval.ts` + `needsApproval` + подключение в `agent.ts:615` + `autoApproved` в `tool_start`; `getAgentApprovalMode` в `settings.ts` (схема+тип). Тесты: `approval.test.ts`, `agent-approval-mode.test.ts` (без PUT-части — режим сетить через `updateSettings` напрямую).
2. **Сервер, REST**: `routes/settings.ts` (status + putBodySchema + ack-валидация), тесты `settings-route.test.ts`/`settings.test.ts`.
3. **Сервер, privileges probe**: `services/privileges.ts` + маршрут, тест `privileges.test.ts`.
4. **Web**: `api.ts` типы/функции → `SettingsModal` радиогруппа + confirm-модалка с чекбоксом → `App.tsx` проп `activeProfileId` → i18n ru/en → `AgentPage` пометка «авто».
5. **Документация**: `AGENTS.md` — **обновить инвариант** в разделе «AI-агент: правила и инварианты» (сейчас: «Мутирующие … никогда не выполняются без approve/reject в UI» → переформулировать под режимы: дефолт `always`, `needed` — классификация риска, `never` — только через `riskAcknowledged`, guard/redact/таймауты неизменны) и пункт в разделе «Безопасность (кратко)»; `docs/architecture.md` — раздел агента (решение об approve, `needsApproval`, эндпоинт privileges, новые тесты в списке); `docs/roadmap.md` — пункт эпика отметить.

## Риски

- **Безопасность — главный риск фичи, а не баг**: `never` осознанно снимает последний барьер перед произвольным shell от имени модели. Смягчения, которые держим кодом: дефолт `always`; серверный ack-гейт; усиленное предупреждение при root/sudo; `redactSecrets`/guard/таймауты неизменны; fail-closed классификация. Компромисс зафиксировать в AGENTS.md.
- **Гонка «сменили режим посреди цикла»**: решение читается на каждый вызов — отключение `never` действует немедленно; уже исполняющийся инструмент не прерывается (как и сегодня с approve).
- **Классификация путей эвристична**: `write_file` по symlink в `/etc` из `/home` не отследить. Формулировка в UI — «опасные действия — с подтверждением», без обещания полноты; `exec` (обход любой классификации) в `needed` всегда на approve.
- **Probe sudo эвристичен**: `sudo -n true` без пароля ≠ «нет sudo» (может требовать пароль), группы — индикатор. Поэтому probe влияет только на силу предупреждения, а не на доступность режима; при сомнении (ошибка probe) — показываем сильное предупреждение.
- **`agent-lang.test.ts`**: любые правки ru-описаний инструментов уронят тест — в этой фиче `buildToolDefs` не трогаем.

---

# Ревизия v2 (2026-10-08): режим доступа — per-dialogue, селектор у поля ввода

v1 (глобальная настройка в `settings.json` + радиогруппа в модалке «Настройки») реализован и работает, но это ошибка дизайна: уровень доступа нужен **на конкретный диалог**, переключаемый из панели агента — дропдаун в левой части области ввода сообщения (по образцу селектора «Full access ⌄» в ai-чатах). Ревизия заменяет разделы «Принятые решения» п. 1, «Сервер» п. 2, «Web» п. 1–2 и тесты, касающиеся settings. Ядро (`ai/approval.ts`, `needsApproval`, privileges probe, confirm-модалка, бейдж «авто») **сохраняется без изменений логики**.

## Решения v2 (подтверждены пользователем)

1. **Режим хранится на диалоге**: поле `approvalMode?` в `ai/dialogues.ts` (persisted `data/ai-dialogues.json`). Глобальное поле `agentApprovalMode` из `settings.json` **убирается полностью** (схема, `getAgentApprovalMode()`, GET/PUT `/api/settings`, радиогруппа в SettingsModal).
2. **Дефолт — `needed`**: новые диалоги и существующие без поля трактуются как `needed`. Это осознанное понижение барьера относительно v1 (там дефолт `always`) — зафиксировать в AGENTS.md.
3. **Переключение — через WS** `set_approval_mode` (диалог живёт в панели с активным WS; REST для смены режима не вводим). Сервер применяет к живой сессии и персистит в диалог. Для `never` обязателен `riskAcknowledged: true` в том же фрейме — иначе WS `error`, режим не меняется.
4. **Confirm-модалка `never` переезжает** из SettingsModal в панель агента (тот же UX: ленивый probe привилегий домашнего профиля диалога, `probePending`-блокировка, чекбокс «Я осознаю возможные риски», fail-closed). Probe — по домашнему профилю диалога (`GET /api/profiles/:id/privileges` без изменений); присоединённые серверы не пробятся (как и в v1 — зафиксировано в рисках).

## Сервер

### 1. `ai/dialogues.ts`
- Zod-схема диалога: + `approvalMode: z.enum(['always','needed','never']).optional()`.
- Хелпер `dialogueApprovalMode(d): AgentApprovalMode` → `d.approvalMode ?? 'needed'` (миграция чтением, файл не переписываем).
- Мутатор `setDialogueApprovalMode(id, mode)` — обновить запись, `save()` (tmp+rename, corrupt-guard — уже есть).

### 2. `ai/agent.ts`
- `AgentSession`: поле `approvalMode: AgentApprovalMode`. В `attachAgent` (`agent.ts:1038+`) — из загруженного диалога через `dialogueApprovalMode`; новый диалог → `needed`.
- Точка решения в `runLoop` (бывший `getAgentApprovalMode()`) → `this.approvalMode`, читается на каждый вызов — live-смена работает.
- `handleClientMessage`: новый кейс `set_approval_mode {mode, riskAcknowledged?}`:
  - валидация enum; мусор → `error`;
  - `mode === 'never'` и `riskAcknowledged !== true` → `error` (текст как в v1-роуте: «Подтвердите осознание рисков»), режим не меняем;
  - успех → `this.approvalMode = mode` + `setDialogueApprovalMode(dialogueId, mode)` + broadcast `{type:'approval_mode', mode}`.
- При attach слать `{type:'approval_mode', mode}` текущего режима (фронт рендерит селектор до первого действия).
- Смена режима влияет только на будущие решения; висящий `tool_pending` не трогаем.
- Ошибка записи диалога не роняет сессию (try/catch + warn, как у `save()`).

### 3. Откат v1 из настроек
- `services/settings.ts`: убрать `agentApprovalMode` из `AppSettings`/`settingsSchema`/`SettingsPatch`, убрать `getAgentApprovalMode()`. Старые `settings.json` с полем читаются без ошибок (zod strip) и поле затирается при следующем save — миграция бесплатная.
- `routes/settings.ts`: убрать `agentApprovalMode`/`riskAcknowledged` из `settingsStatus()`/`putBodySchema`/обработчика. Тип `AgentApprovalMode` остаётся жить в `ai/approval.ts` (импорты поправить).
- `ai/approval.ts`, `services/privileges.ts`, `routes/profiles.ts` (privileges-эндпоинт) — **без изменений**.

## Web

### 1. `components/AgentAccessConfirm.tsx` (переезд)
- Компонент confirm-модалки вынести из `SettingsModal.tsx` в отдельный файл без изменений логики (probePending, privileged, чекбокс, busy). Проп `onEnabled` меняет сигнатуру: вместо PUT настроек — колбэк подтверждения; PUT уходит из интерфейса компонента, сабмит делает родитель через WS (см. ниже). Тексты и стили (`access-level-*` в styles.css) сохраняются.

### 2. `pages/AgentPage.tsx` — селектор у поля ввода
- В футере области ввода (левый край, до кнопок отправки; рядом с `PendingBar` по вертикали не конфликтует — PendingBar над инпутом, селектор в строке контролов): кнопка-дропдаун `🛡 <лейбл режима> ⌄` (`agent.accessLevel{Always,Needed,Never}`).
- Меню из трёх пунктов; текущий помечен. Выбор:
  - `always`/`needed` → `sendWs({type:'set_approval_mode', mode})`;
  - `never` → открыть `AgentAccessConfirm` (probe по `profileId` диалога); подтверждение → `sendWs({type:'set_approval_mode', mode:'never', riskAcknowledged:true})`.
- Стейт режима: `approvalMode` в компоненте, источник правды — WS-событие `approval_mode` (обработать в `ws.onmessage` switch, `:449-542`); до первого события селектор показывает `needed`-дефолт не нужен — ждём событие (attach шлёт его сразу). Ошибка (`type:'error'`) → тост/текст как принято на странице, режим не двигаем.
- Селектор не дизейблится во время `running` — смена режима на лету поддержана сервером.

### 3. Откат v1 из настроек
- `SettingsModal.tsx`: удалить радиогруппу, `AgentAccessConfirm`, проп `activeProfileId`, стейт `accessConfirmOpen` (Escape-гейт тоже уходит вместе с ним); `App.tsx` — убрать проп.
- `api.ts`: убрать `agentApprovalMode` из `SettingsStatus`/patch-типа `updateSettings`; `riskAcknowledged` убрать. `fetchProfilePrivileges`, типы `AgentApprovalMode`/`ProfilePrivileges` — оставить.
- i18n: ключи `settings.accessLevel*` перенести в `agent.*` неймспейс (те же тексты; `accessLevelConfirmUnknown`, `accessLevelProbeFailed` тоже), старые ключи удалить из обоих словарей.

## Тесты

- `test/approval.test.ts` — без изменений (чистая функция).
- `test/agent-approval-mode.test.ts` — переработать: режим задаётся не `updateSettings`, а полем диалога при создании + фреймом `set_approval_mode`. Кейсы те же (needed-таблица, never-авто, live-смена) + новые: `set_approval_mode never` без `riskAcknowledged` → `error`, режим прежний, файл диалога не изменён; с `riskAcknowledged:true` → событие `approval_mode`, режим применяется к следующему вызову и персистится; мусорный mode → `error`; дефолт диалога без поля = `needed`.
- `test/settings-route.test.ts` / `settings.test.ts` — убрать кейсы `agentApprovalMode`/`riskAcknowledged`; добавить регрессионный: settings.json с легаси-полем `agentApprovalMode` читается без ошибок и поле исчезает после save.
- Тест диалогов (существующий файл для `ai/dialogues.ts`, если есть — иначе новый): `dialogueApprovalMode` дефолтит в `needed`; `setDialogueApprovalMode` персистит; битое значение в файле → corrupt-guard/отказ по zod (как принято в сторе).
- `i18n.test.ts` — паритет перенесённых ключей (автоматом).

## Документация

- `AGENTS.md`: пункт «Уровень доступа агента» переписать — режим per-dialogue (`approvalMode` в `ai-dialogues.json`, дефолт `needed` — **в т.ч. для существующих диалогов**), переключение WS `set_approval_mode` с серверным ack-гейтом для `never`, селектор в панели агента; из раздела «Настройки»/settings-инварианта убрать упоминания `agentApprovalMode`; в «Безопасность (кратко)» поправить дефолт (`always` → `needed`).
- `docs/architecture.md` — те же дельты (модель диалога, WS-протокол, состав тестов); `docs/roadmap.md` — запись эпика дополнить ревизией.

## Итерации v2

1. Сервер: dialogues (поле+хелпер+мутатор) → agent.ts (поле сессии, attach, `set_approval_mode`, событие `approval_mode`) → откат settings. Тесты сервера зелёные.
2. Web: переезд `AgentAccessConfirm` → селектор в `AgentPage` → откат SettingsModal/App/api → i18n-перенос. Lint + build зелёные.
3. Документация (AGENTS.md, architecture.md, roadmap.md) + статус этого плана.

## Риски v2 (дополнение)

- **Дефолт `needed` для всех существующих диалогов** — осознанное понижение барьера, подтверждено пользователем; фиксируем в AGENTS.md, чтобы будущие аудиты не приняли за регрессию.
- **Два клиента одного диалога** — attachAgent убивает прежнюю сессию профиля, гонки нет; последний `set_approval_mode` побеждает и персистится.
- **Смена режима посреди pending-подтверждения** — не влияет на висящий `tool_pending`; документировано, UX-путаницы не создаёт (бар доезжает своё решение).
