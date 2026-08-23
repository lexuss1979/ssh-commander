# План: эпик 17 — действия над процессами из «Обзора»

> Эпик 17 из «Продолжение: эпики 13–20» (Tier 2), `docs/roadmap.md`. Дата
> плана: 2026-08-23. Сервер + фронтенд, новых зависимостей нет.
>
> **Отклонения от формулировки roadmap** (все — с обоснованием ниже):
>
> 1. **`kill -<sig> <pid>` без `--`** (roadmap писал `kill -<sig> -- <pid>`).
>    Команда исполняется через login-shell пользователя (builtin `kill` в
>    bash/dash/busybox), поддержка `--` builtin'ами различается; pid после
>    валидации — каноничное положительное целое, опцией быть не может, так
>    что `--` ничего не защищает, но добавляет отказоустойчивый риск.
> 2. **Sudo-зонд выносится в общий модуль `services/sudo.ts`** — второй
>    потребитель сейчас (процессы), третий заведомо будет (эпик 19,
>    применение обновлений). Прецедент — вынос лимитера в
>    `services/stream-limits.ts` (ревизия 3 плана эпика 13).
> 3. **Вход в действия — кнопка «⋯» + модалка, а не выпадающее меню в
>    строке**: общего dropdown-компонента в проекте нет (dropdown'ы AgentPage
>    привязаны к её стилям), а модалка уже переиспользуется везде
>    (`components/Modal.tsx`).
> 4. **HUP показывается в UI** («Перечитать конфиг»): roadmap держал его в
>    whitelist API, но в списке меню не упоминал; для nginx/postgres это
>    самый частый безопасный сигнал после TERM.

## 0. Контекст: что уже есть

- Таблица топ-10 процессов по CPU — `web/src/pages/OverviewPage.tsx`
  (`metrics?.processes`, `ProcessInfo {user, pid, cpuPercent, memPercent,
  command}`), сортировка `useSortBy`, polling 3 с при видимой вкладке.
  Действий нет — цикл «нашёл пожирателя → убил» не замыкается.
- **Sudo-механика эпика 13** (`services/systemd.ts`) — брать готовой:
  1. пробуем без sudo;
  2. access-denied + передан пароль → зонд `sudo -S -p '' -- true` (пароль
     **первой строкой stdin** канала, не в argv/логах, живёт в памяти одного
     запроса), ошибки зонда — явные 400 («неверный пароль» / «нет прав sudo»
     / «sudo не установлен»), иное — 502;
  3. access-denied без пароля → 400 «укажите sudo-пароль»;
  4. состояние-причины (не права) → 400 с текстом утилиты как есть;
  5. транспорт/неизвестное → 502.
  Ретрай безопасен: EPERM означает, что сигнал не отправлен/приоритет не
  менялся.
- `classifySudoProbe` / `sudoProbeCommand` — сейчас в `systemd.ts`, экспор-
  тированы, покрыты тестами (`systemd.test.ts:408`).
- Кэш метрик 2 с на профиль — `services/metrics.ts` (`collectMetrics`);
  им же пользуются `/api/overview` (сайдбар) и история нагрузки. Инвалидации
  нет — после мутации процесса refetch в течение 2 с вернёт старый снимок.
- Роут-паттерн — `routes/services.ts`: `profileFrom` (404), валидация
  параметра из URL до всего остального (400), zod-body, ошибки действия
  400/502 по классификации. Mount — `index.ts:38-52`.
- UI-паттерн действия — `ServicesPage.tsx`: `ActionConfirmModal` с
  предупреждениями, поле sudo-пароля (удерживается в стейте страницы на
  время жизни вкладки, без persist), `confirmError` внутри модалки, `notice`
  на 5 с после успеха, немедленный `setReloadKey` после мутации.
- Агент: `kill`, `pkill`, `killall` в deny-листе `ai/guard.ts:12` —
  инструмент агента не добавляем, deny-лист не ослабляем (дорога через
  мутating `exec` с approve остаётся).

## 1. Backend

### 1.1 `server/src/services/sudo.ts` — общий sudo-зонд (вынос из systemd.ts)

Новый модуль, содержимое — перенос из `systemd.ts` без изменений логики:

- `sudoProbeCommand(): string` → `` `sudo -S -p '' -- true` ``;
- `type SudoProbeResult = 'ok' | 'wrong-password' | 'not-in-sudoers' | 'sudo-not-found' | 'other'`;
- `classifySudoProbe(result: ExecResult): SudoProbeResult`;
- `probeSudo(profile, password): Promise<SudoProbeResult>` — обёртка
  «exec зонда со `stdin: password + '\n'` + классификация». Нужна и здесь,
  и в эпике 19 (применение обновлений, шаг 0b его плана); заводим сразу,
  чтобы 19 модуль только импортировал.

**Пересечение с эпиком 19.** `docs/packages-plan.md` описывает тот же
вынос своим шагом 0b — модуль создаёт тот, кто идёт первым (по таблице
порядка это эпик 17). Если 17 сдан — 19 пропускает шаг 0b и просто
импортирует `probeSudo`; если порядок поменяется — наоборот, и тогда этот
шаг 1.1 сводится к импорту. Дважды переносить нечего: реэкспорт из
`systemd.ts` держит совместимость в обоих случаях.

`systemd.ts` импортирует их из `./sudo.js` и **реэкспортирует** — публичный
API модуля не меняется, `systemd.test.ts` и `routes/services.ts` не
трогаем. `processes.ts` импортирует уже напрямую из `./sudo.js` (без
зависимости подсистемы от подсистемы).

### 1.2 `server/src/services/processes.ts` — валидация, билдеры, действия

Типы и константы:

```ts
export const PROCESS_SIGNALS = ['TERM', 'KILL', 'HUP'] as const;
export type ProcessSignal = (typeof PROCESS_SIGNALS)[number];
export const NICE_MIN = -20;
export const NICE_MAX = 19;
export interface ProcessActionResult { ok: true; output: string; }
export class ProcessActionError extends Error { readonly status: number; /* 400 — пользовательские причины, 502 — транспорт */ }
```

Чистые функции (под unit-тесты):

- **`parsePid(raw: string): number | null`** — pid из URL-параметра:
  строка `/^\d+$/`, без ведущих нулей (`raw === String(Number(raw))`),
  значение **2..4194304** (pid_max по умолчанию). Запрещены `0`, `1`
  (`kill -1`/`-0` — процессные группы/широковещательные сигналы, `kill
  -TERM -1` кладёт всё, до чего дотянется), отрицательные, дробные, `1e3`,
  пробелы, нечисловое, мусор сверх 7 цифр. Возвращает валидированное число
  или null → роут отвечает 400.
- **`killCommand(signal, pid)`** → `kill -${signal} ${pid}`;
  **`sudoKillCommand`** → `sudo -S -p '' -- kill -${signal} ${pid}`.
  sudo-форма исполняет `/bin/kill` напрямую (без shell), plain-форма —
  builtin shell; обе формы идентичны по флагам. `shq` не нужен: сигнал —
  элемент whitelist-enum, pid — валидированное целое, строковых аргументов
  нет (unit-имя в эпике 13 требовал shq именно потому, что это строка).
- **`reniceCommand(nice, pid)`** → `renice -n ${nice} -p ${pid}`;
  **`sudoReniceCommand`** → `sudo -S -p '' -- renice -n ${nice} -p ${pid}`.
  Отрицательное nice — законное значение аргумента `-n` (getopt берёт
  следующий argv как значение опции). Повышение nice (замедление) доступно
  непривилегированному пользователю для своих процессов; понижение
  (ускорение) и чужие процессы — EPERM → sudo-ветка.
- **`classifyProcessActionFailure(result): 'ok' | 'sudo-needed' | 'gone' | 'no-tool' | 'transport'`**
  по тексту stderr/stdout и коду:

  | Категория | Признак |
  |---|---|
  | `ok` | code === 0 |
  | `sudo-needed` | `Operation not permitted`, `Permission denied` (EPERM — чужой процесс, понижение nice, kernel-thread) |
  | `gone` | `No such process` (ESRCH — процесс завершился между снимком и кликом) |
  | `no-tool` | `command not found` / `not found` / `No such file or directory` для самой утилиты (BusyBox без `renice`, минимальный образ без `/bin/kill` под `sudo --`) → 400 «Команда `renice` недоступна на этом сервере» |
  | `transport` | всё остальное |

  Категория `no-tool` заведена отдельно намеренно: без неё отсутствие
  `renice` (обычное дело на BusyBox) приезжало бы 502 «Сервер недоступен»
  — сервер-то в порядке, недоступна утилита, и пользователю нужен другой
  текст. `sudo`-форма зовёт `/bin/kill`/`/bin/renice` напрямую (без
  shell), так что промах по бинарнику здесь реален и без экзотики.

  Фикстуры обоих формулировок: util-linux `kill: (1234) - Operation not
  permitted` и builtin `bash: line 1: kill: (1234) - Operation not
  permitted`; renice — `renice: failed to set niceness for process 1234:
  Permission denied` / `… No such process`.

Исполнители (инъекция `execFn` для тестов, паттерн `systemd.ts`):

- **`runProcessSignal(profile, pid, signal, sudoPassword?)`** — алгоритм
  1.1 из контекста (проба → классификация → зонд → sudo-ретрай), с
  категорией `gone`: → 400 «Процесс больше не существует (уже завершился?)».
  Успех → `{ok: true, output: ''}` (kill молчит при успехе).
- **`runProcessRenice(profile, pid, nice, sudoPassword?)`** — та же схема.
  Успех → `{ok: true, output}` с выводом renice (`PID 1234 old nice level
  0, new nice level 5`) — показывается в notice. `nice` валидируется в zod
  роута (целое −20..19) и дополнительно clamp-веткой в исполнителе не
  обрабатывается — строгое значение, отказ вместо молчаливой правки.

Таймаут — дефолт `exec` 60 с (kill/renice мгновенны; отдельный
ACTION_TIMEOUT, как у systemctl stop, не нужен). Память пароля — только
stdin одного запроса, не логируется, не сохраняется (инвариант аудита и
эпика 13).

### 1.3 Роуты: `server/src/routes/processes.ts`

- `POST /api/processes/:pid/signal?profileId=` — body
  `{signal: z.enum(PROCESS_SIGNALS), sudoPassword?: string(≤1024)}`;
- `POST /api/processes/:pid/renice?profileId=` — body
  `{nice: z.number().int().min(NICE_MIN).max(NICE_MAX), sudoPassword?}`.

Порядок проверок (паттерн `routes/services.ts`): `profileId` → 404;
`parsePid(req.params.pid)` → 400 «Недопустимый pid»; zod → 400; действие →
`ProcessActionError.status` (400/502), прочее → 502 «Сервер недоступен».

После успешной мутации — **`invalidateMetricsCache(profile.id)`**: новый
экспорт в `services/metrics.ts` (одна строка `cache.delete(profileId)`,
паттерн `invalidateServicesCache`). Это гасит кэш 2 с и для `/api/metrics`
(немедленный refetch «Обзора» после действия), и для `/api/overview`
(сайдбар). Снимок метрик пишется в историю (`appendSample`) — дедупликация
по timestamp уже есть.

Mount: `app.use('/api/processes', requireAuth, processesRouter)` в
`index.ts` рядом с `/api/metrics`.

## 2. Frontend

### 2.1 `web/src/api.ts`

```ts
export type ProcessSignal = 'TERM' | 'KILL' | 'HUP';
export function processSignal(profileId, pid, signal, sudoPassword?): Promise<{ok, output}>;
export function processRenice(profileId, pid, nice, sudoPassword?): Promise<{ok, output}>;
```

Паттерн `serviceAction`: ошибки 400 показываются текстом как есть, 502 —
«Сервер недоступен: …».

### 2.2 `web/src/pages/OverviewPage.tsx` — действия в таблице процессов

- Новая колонка **«Действия»** (`col-actions`, как в ServicesPage): кнопка
  «⋯» (`btn btn-ghost btn-small`) в каждой строке. Заголовок `colSpan`
  пустой строки 5 → 6.
- **`ProcessActionModal`** (в файле страницы, паттерн
  `ActionConfirmModal`): сводка процесса (команда mono с `title`, pid,
  владелец, CPU/память), выбор действия:
  - «Завершить (TERM)» — primary;
  - «Убить (KILL)» — danger, с пояснением «без сохранения, если TERM не
    помог»;
  - «Перечитать конфиг (HUP)»;
  - «Понизить приоритет» — раскрывает поле `nice` (число, дефолт 5,
    подсказка «−20..19; обратное повышение приоритета требует root»).
  - превью команды mono: `kill -TERM 1234` / `renice -n 5 -p 1234`;
  - **предупреждения** (по roadmap): владелец ≠ `profile.username` →
    «Процесс другого пользователя — потребуется sudo-пароль»; `pid < 100` →
    «Похоже на системный процесс ядра — остановка может уронить сервер»;
    KILL — «данные не сохранятся». Предупреждения усиливают подтверждение,
    не блокируют;
  - поле «sudo-пароль (если нужны права)» — опционально; удерживается в
    стейте OverviewPage на время жизни вкладки без persist (паттерн
    ServicesPage, комментарий тот же);
  - ошибка — inline в модалке (`confirmError`, не закрывает её): «Процесс
    больше не существует», «Неверный sudo-пароль», «укажите sudo-пароль»
    (последний — подсказка вернуться и ввести пароль);
  - после успеха — `notice` на 5 с (с output renice, если есть), закрытие,
    `setReloadKey(k => k + 1)` — тик polling'а сработает немедленно против
    сброшенного кэша.
- Состояние модалки держит снимок `ProcessInfo` (строка обновляется каждые
  3 с; гонку «процесс умер между снимком и кликом» честно закрывает сервер
  категорией `gone`).
- Стили: переиспользовать `Modal`, `modal`, `btn-danger`, `mono`,
  `proc-command`; нового — только выравнивание блока сводки (при
  необходимости).

## 3. Тесты

`server/test/processes.test.ts` (новый; фейковый `execFn` по вызовам —
паттерн `systemd.test.ts`, без ssh2):

1. `parsePid`: `2`, `1234`, `4194304` → число; `0`, `1`, `-1`, `1.5`,
   `1e3`, `' 12'`, `'007'`, `'abc'`, `''`, `4194305`, длинный мусор → null.
2. Сигналы: `TERM`/`KILL`/`HUP` в whitelist; `SIGKILL`, `9`, `kill`, `''` —
   мимо (zod-схема + константа).
3. `nice`: −20/19 принимаются, −21/20/1.5/NaN отклоняются (zod-схема).
4. Билдеры: `killCommand('TERM', 1234)`, `sudoKillCommand`,
   `reniceCommand(-5, 1234)`, `sudoReniceCommand` — точные строки;
   отрицательный nice не ломает формат.
5. `classifyProcessActionFailure`: code 0 → ok; обе формулировки EPERM
   (util-linux и bash-builtin) → sudo-needed; renice `Permission denied` →
   sudo-needed; `No such process` (kill и renice) → gone;
   `sh: renice: command not found` и `sudo: renice: command not found` →
   no-tool; мусор → transport.
6. `runProcessSignal` (матрица): успех без sudo; EPERM без пароля → 400
   «укажите sudo-пароль»; EPERM + пароль → зонд ok → sudo-ретрай ok; зонд
   «Sorry, try again» → 400 «Неверный sudo-пароль»; «not in the sudoers» →
   400; зонд-мусор → 502; gone → 400 «больше не существует»; sudo-ретрай
   с ненулевым кодом → 502. Пароль уходит только в `stdin` (фейковый execFn
   фиксирует вызовы: в командной строке пароля нет).
7. `runProcessRenice`: успех своего процесса (+5, без sudo); понижение
   (−5) → EPERM → sudo-ветка; прочее — как в 6.

`systemd.test.ts` не меняется (реэкспорт сохраняет импорты). Прогон всего
набора — регресс. Роут-тест не заводим: обработчики тонкие (валидация
делегирована тестируемым функциям), стриминговых особенностей нет —
аналогично `routes/profiles.ts`.

Ручной сценарий (`server/test/integration.manual.mjs`, расширить): на
sshd-стенде запустить `sleep 600` → TERM через API (свой процесс, без
sudo) → процесс исчез из снимка; renice +5 → вывод «old nice level 0,
new nice level 5»; renice −5 без пароля → 400; несуществующий pid → 400
«больше не существует»; при `SUDO_ACCESS`-стенде — kill чужого процесса с
sudo-паролем.

## 4. Порядок работ и коммиты

1. `services/sudo.ts` (перенос) + реэкспорт из `systemd.ts` — `npm test`
   зелёный без правки тестов.
2. `services/processes.ts` + `test/processes.test.ts` + экспорт
   `invalidateMetricsCache` из `metrics.ts`.
3. `routes/processes.ts` + mount в `index.ts`.
4. Frontend: `api.ts` + OverviewPage (колонка, модалка, notice, sudo-стейт).
5. Документация: `AGENTS.md` (маршруты, инвариант «pid > 1, whitelist
   сигналов, sudo как в аудите»), `docs/architecture.md` (раздел),
   `docs/roadmap.md` (пометка «Реализовано», отклонения). Сдача:
   `npm run build` в обоих каталогах, `npm test`, `npm audit`.

## 5. Риски

- **Убийство системного/чужого процесса** — предупреждения в модалке
  (владелец ≠ пользователь профиля, pid < 100, KILL); API-защита — pid
  строго > 1 и каноничный, сигнал из whitelist, произвольная строка не
  принимается.
- **Гонка «процесс умер между снимком и кликом»** (включая reuse pid другим
  процессом) — категория `gone` с явным 400; окно секунды (polling 3 с),
  принимается как любое kill-UI.
- **Утилиты может не быть** — `renice` отсутствует на многих минимальных
  образах, `sudo -- kill` требует бинарника `/bin/kill` (не builtin);
  категория `no-tool` даёт понятный 400 вместо 502.
- **EPERM как норма, а не ошибка** — renice вниз и чужие процессы без root
  всегда EPERM: это штатный вход в sudo-ветку, не 502; тексты утилиты
  пробрасываются как есть.
- **Sudo-пароль** — инвариант аудита/эпика 13: первая строка stdin, не в
  argv/логах/персисте, живёт в памяти одного запроса (на клиенте — в стейте
  вкладки без persist).
- **Кэш метрик после мутации** — без инвалидации refetch «Обзора» до 2 с
  показывал бы убитый процесс; инвалидация закрывает (включая сайдбар
  `/api/overview`).
- **Параллелизм не ограничиваем** — kill/renice суть секундные разовые
  exec'ы, транзитный слот канала занимается на мгновение; лимитеры
  (терминалы/follow) не затрагиваются.

## 5.1 Вне области v1 (осознанно)

- **Инструмент агента** (`process_kill`/`renice`) — не даём: `kill`/`pkill`/
  `killall` в deny-листе `guard.ts` осознанно; агент при необходимости
  идёт через мутating `exec` с approve.
- **Полный список процессов** (не только топ-10 «Обзора») и ввод pid
  вручную — терминал для этого есть; таблица остаётся топ-10 по CPU.
- **Другие сигналы** (USR1/USR2/STOP/CONT…) — whitelist TERM|KILL|HUP
  закрывает целевые сценарии эпика; расширение — одна строка в enum.

## 6. Оценка

~0.5–0.75 дня: сервер ~0.3 (sudo.ts-перенос, processes.ts, роут,
`invalidateMetricsCache`, тесты), фронтенд ~0.25 (модалка — основной объём,
колонка, api), ручной сценарий и docs ~0.15. Из них ~0.05 — вынос
`services/sudo.ts`, окупится эпиком 19.
