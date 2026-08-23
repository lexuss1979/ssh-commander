# План реализации: Эпик 13 — Вкладка «Службы» (systemd)

> Статус: реализовано (2026-08-23; план согласован в ревизии roadmap 2026-08-23). Ревизия 2 после ревью:
> - needsSudoRetry дополнен polkit-формулировкой `Interactive authentication required` — без неё sudo-ветка мертва на типовом сервере (Debian/Ubuntu/RHEL/Fedora);
> - транспорт журнала — исправленный из эпика 14, а не «копия routes/docker.ts» (баг `handle.code` в execStream закрывает ответ до первого чанка);
> - list-unit-files: трёхколоночный формат с PRESET (systemd ≥ 245), STATE всегда второе поле;
> - классификация ошибок действий: 400 для пользовательских причин, 502 только для транспорта; зонд sudo-пароля;
> - общий лимитер follow-стримов на профиль и backpressure — из эпика 14.
>
> Ревизия 3 (сверка с планом эпика 14):
> - backpressure — `createChunkGate` (дроп с маркером), а не pause/resume канала: эпик 14 последний вариант рассмотрел и отклонил, две редакции противоречили друг другу;
> - лимитер follow-стримов вынесен в отдельный модуль `services/stream-limits.ts` — чтобы `routes/services.ts` не импортировал счётчик из `file-tail.ts`;
> - зонд sudo-пароля разбирает «пользователь не в sudoers» (400, а не 502);
> - отказ журнала без прав выглядит как пустой вывод с кодом 0, а не ошибка → подсказка про группы `adm`/`systemd-journal` в UI;
> - разовый `journalctl` — честная пометка об обрезке по лимиту `exec` 2 МБ.
>
> Эпик 13 из «Продолжение: эпики 13–20», Tier 1.
> Перед взятием в работу — реализовать эпик 14 (просмотрщик логов) **вместе с починкой транспорта `execStream`** (см. раздел 0): 13 переиспользует и компонент просмотрщика, и исправленный транспорт, и общий лимитер.

## 0. Контекст и зависимости

**Цель:** управлять сервисами вне контейнеров (nginx, postgres, sshd, свои unit'ы) — список, статусы, автозапуск, действия, журнал. Сейчас `systemctl` в коде встречается только в deny-листе `ai/guard.ts:15` — bare-metal половина сервера не видна вообще.

**Зависимость от эпика 14 (по roadmap обязательная):** журнал unit'а рендерится просмотрщиком из эпика 14 («Живой просмотр логов», `tail -F`). Порядок: **сначала 14, затем 13**. Контракт просмотрщика: компонент, принимающий URL стрима (`fetch` + `reader`, chunked `text/plain`), `visible`-флаг (пауза стрима при скрытой вкладке), кольцевая обрезка буфера, тумблеры follow/автоскролла. Если 13 берут без 14 — ставится минимальный inline-просмотрщик по образцу `LogsModal` (`DockerPage.tsx:660`), который при реализации 14 заменяется на общий компонент без изменений бэкенда.

**Транспорт стрима — тоже из эпика 14, исправленный.** Наивная копия `routes/docker.ts:83-123` не работает: `execStream` (`ssh/manager.ts:161-213`) отдаёт `handle.code` как `Promise.resolve(null)` и подменяет его только после открытия канала (manager.ts:168, 202-204), поэтому синхронное чтение `handle.code` в роуте (`routes/docker.ts:114`) закрывает ответ до первого чанка — стрим отдаёт пустоту. Эпик 14 чинит транспорт (настоящий промис `handle.code` с первого момента, backpressure через `createChunkGate`, общий лимитер follow-стримов) — 13 берёт ровно этот исправленный транспорт. Если 13 реализуют без 14, исправленный транспорт поставляется в составе 13.

**Backpressure — `createChunkGate`, не pause/resume.** Эпик 14 рассмотрел паузу SSH-канала по возврату `res.write() === false` с возобновлением по `drain` и **отклонил**: это требует вывести канал наружу через API `execStream`. Принятый механизм — гейт на стороне роута: при `res.writableLength > 1 МБ` чанки дропаются с подсчётом, при возврате в норму в тело пишется маркер «пропущено N байт». Для просмотрщика с кольцевым буфером потеря середины — честная цена. Эпик 13 использует тот же гейт, своего механизма не заводит.

**Общий лимитер follow-стримов (вводится эпиком 14 отдельным модулем `server/src/services/stream-limits.ts`, используется здесь).** Модуль намеренно отдельный, а не внутри `file-tail.ts`: иначе `routes/services.ts` импортировал бы счётчик из чужой подсистемы. Лимит считает активные follow-стримы **на профиль**, а не на подсистему: SSH-соединение на профиль одно (`ssh/manager.ts`), на нём висят постоянный SFTP-канал (getSftp кешируется), shell терминала, docker-логи, транзитные exec'ы метрик — при `MaxSessions 10` у OpenSSH каналы кончаются быстро. `/api/services/:unit/logs?follow=1` идёт через тот же лимитер: `acquireFollowSlot(profileId)` при старте, `releaseFollowSlot(profileId)` при закрытии (`req.on('close')` или завершение команды, идемпотентно через локальный флаг); сверх лимита — **429** с понятным текстом. Ключ — профиль, не подсистема.

Переиспользуемые паттерны (проверены по коду):

- **sudo:** `sudo -S -p ''` с паролем **первой строкой stdin** канала — паттерн `security-audit.ts:209` (`sudoWrap`), поле `stdin` у `exec` (`ssh/manager.ts:107`: пишется в канал + EOF). Для systemctl используется **прямая форма без `sh -c`** — `sudo -S -p '' -- systemctl <action> -- <unit>` (см. 1.3). Не в argv, не логируется, живёт только в памяти запроса.
- **Стрим:** исправленный `execStream` + chunked `text/plain`, `req.on('close')` → `handle.close()`, backpressure через `createChunkGate`, слоты через `services/stream-limits.ts` — всё из эпика 14 (см. выше).
- **Кэш 2 с на профиль:** `services/ports.ts:101-130` (Map + промис, ошибочный промис из кэша удаляется).
- **Два вывода в одном exec:** маркер-разделитель, как `=== <файл>` в `services/cron.ts`.
- **Роут:** `routes/tunnels.ts` (zod, 404/409), `routes/cron.ts` (400/502).
- **Страница:** `CronPage.tsx` (polling 5 с, пауза по `visible`, try/catch → toast, keep-alive в `App.tsx`), `useSortBy.tsx`, бейджи `scope-badge`/`status-dot`.

---

## 1. Backend

### 1.1 `server/src/services/systemd.ts` — снимок, парсеры, кэш

**Типы:**

```ts
export interface UnitInfo {
  name: string;            // 'nginx.service' (с суффиксом)
  description: string | null;
  load: string | null;     // loaded / not-found / error / null (не загружен)
  active: string | null;   // active / inactive / activating / failed / null
  sub: string | null;      // running / dead / exited / failed / null
  enabled: string | null;  // enabled / disabled / masked / static / indirect / generated / alias / null
}
export interface ServicesSnapshot {
  timestamp: number;
  available: boolean;      // systemd обнаружен
  reason?: string;         // причина недоступности — для заглушки UI
  units: UnitInfo[];
}
```

**Команда снимка — один exec, маркеры, `2>&1` (ошибки детекта в stdout), `LC_ALL=C` (стабильные заголовки/статусы):**

```
LC_ALL=C systemctl --version 2>&1 | head -1
echo '@@UNITS@@'
LC_ALL=C systemctl list-units --type=service --all --no-pager --plain --no-legend 2>&1
echo '@@UNITFILES@@'
LC_ALL=C systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>&1
```

Код возврата игнорируем (на не-systemd системах последняя команда падает) — решение принимает парсер по тексту.

**Чистые функции (под unit-тесты):**

- `parseVersionLine(line)` — первая строка: `systemd 252 (252.26-1~deb12u2)` → версия; содержит `not found` / `command not found` → нет systemctl.
- `parseListUnits(raw)` — колонки `UNIT LOAD ACTIVE SUB DESCRIPTION` (`--plain --no-legend` убирают заголовок/футер; `--plain` дополнительно снимает bullet `●` у failed-юнитов, который иначе сдвинул бы колонки); `-` в LOAD/ACTIVE/SUB → `null`; описания с пробелами — всё после 4-й колонки; пустой вывод → `[]`; мусорные строки отбрасываются.
- `parseListUnitFiles(raw)` — **формат зависит от версии: с systemd ≥ 245 колонок три — `UNIT FILE / STATE / PRESET` (Ubuntu 20.04+, Debian 11+ — подавляющее большинство целей); до этого — две (`UNIT FILE / STATE`).** STATE — **всегда второе поле (`fields[1]`)**, никогда не «последнее»: в трёхколоночном формате чтение последнего поля запишет в `enabled` значение preset'а. PRESET игнорируем. В тестах — фикстуры обоих форматов.
- `mergeUnits(units, unitFiles)` — `UnitInfo`: имя из любого списка; `enabled` из unit-files (отсутствует → `null`, напр. transient-юниты); load/active/sub из list-units (не загружен → null); сортировка по имени.
- `parseSnapshot(raw)` → `{available, reason?, units}`:
  - версия не похожа на systemd (`not found`) → `{available: false, reason: 'systemctl не найден (не systemd? Alpine/OpenRC/контейнер)'}`;
  - секция UNITS содержит `has not been booted with systemd` → `{available: false, reason: 'systemd не является PID 1 (контейнер?)'}`;
  - **ошибка самого systemctl в начале секции** — первая непустая строка секции UNITS/UNITFILES содержит `Unknown option` / `Invalid option` / `Failed to` (флаг не поддержан экзотической сборкой и т.п.) → `{available: false, reason: <текст ошибки>}`. Иначе парсер молча отбросит строку ошибки как мусор, и UI покажет `available: true` с пустой/половинчатой таблицей вместо внятной причины;
  - иначе → `{available: true, units}`.
- `collectServices(profile)` — exec → `parseSnapshot` + `timestamp`, **кэш 2 с на профиль** (паттерн `ports.ts`; ошибочный промис из кэша удаляем).

### 1.2 Деталь unit'а: `GET /api/services/:unit?profileId=`

Один exec с маркером:

```
LC_ALL=C systemctl status --no-pager -n 0 <unit> 2>&1
echo '@@SHOW@@'
LC_ALL=C systemctl show -p MainPID -p ActiveState -p SubState -p UnitFileState -p FragmentPath -p Restart -p NRestarts -p Result -p MemoryCurrent -p TasksCurrent -p ActiveEnterTimestamp <unit> 2>&1
```

`<unit>` — аргумент через `shq` (имя уже прошло regex-валидацию). `-n 0` — без дампа журнала, `--no-pager` — без пагинации.

**Код возврата составной команды игнорируется — для `systemctl status` он не признак ошибки: 3 = inactive (unit остановлен), 4 = not-found (unit не существует) — нормальные состояния, не 502.** Решение принимается по тексту секций, а не по коду; неявная зависимость от порядка строк (что последним идёт `systemctl show`, возвращающий 0) в план не закладывается.

Ответ:

```ts
{ name: string; status: string; show: Record<string, string | null> }
```

`status` — raw-вывод `systemctl status` для человека, не парсим. `parseShowOutput(raw, fields)` — строки `^([A-Za-z0-9_.]+)=(.*)$`, первое вхождение выигрывает (для выбранных полей значения однострочные).

### 1.3 Действия: `POST /api/services/:unit/action`

- Body: `{action, sudoPassword?}`. Zod:
  - `action: z.enum(['start','stop','restart','reload','enable','disable','reset-failed'])`;
  - `sudoPassword: z.string().max(1024).optional()` — пароль **не логируется, не сохраняется**, используется только как stdin для `sudo -S` в пределах одного запроса;
  - имя unit'а из URL — отдельная валидация до всего остального: regex `^[A-Za-z0-9@._:\-]+$` (отказ на `;`, пробелы, `/`, `..`, `$()`, пустую строку → 400).
- **`reset-failed` добавлен сверх списка роадмапа (start|stop|restart|reload|enable|disable) осознанно:** без него сбойный unit остаётся в списке failed по счётчику и после успешного start — в UI заметно; команда безобидна (`systemctl reset-failed <unit>`). **`daemon-reload` осознанно отложен** — он глобальный, без unit'а, ему нужен отдельный эндпоинт (см. «Вне области v1»).
- Команда без sudo: `systemctl <action> -- <unit>` (unit через `shq`; `--` — защита от опций, getopt_long корректно останавливает парсинг).

**Sudo-механика — ретрай по access-denied с классификацией.** Чистая функция `classifyActionFailure(ExecResult)` → категория:

| Категория | Признак (stderr, code ≠ 0) |
|---|---|
| `ok` | code === 0 |
| `sudo-needed` | `Interactive authentication required` (polkit — **типовой** Debian/Ubuntu/RHEL/Fedora; именно это systemctl отдаёт без TTY), `Authentication is required`, `Access denied` (система без polkit), `Operation refused`, `Permission denied` |
| `masked` | `Unit … is masked` — это не про права, ретрай с sudo бесполезен |
| `not-found` | `Unit … not found` / `could not be found` |
| `job-failed` | `Job for … failed` |
| `transport` | всё остальное |

Алгоритм:

1. пробуем без sudo;
2. `sudo-needed` и `sudoPassword` передан → **зонд пароля** `sudo -S -p '' -- true` со `stdin: <password>\n` (паттерн `security-audit.ts:330`):
   - зонд не прошёл: stderr `Sorry, try again.` → 400 «Неверный sudo-пароль»; `is not in the sudoers file` / `not allowed to execute` → 400 «У пользователя <username> нет прав sudo на этом сервере» (типовой случай для SSH-пользователя без прав — в 502 ему не место); `not found` → 400 «sudo не установлен»; иное → 502;
   - зонд прошёл → повтор `sudo -S -p '' -- systemctl <action> -- <unit>` со `stdin: <password>\n`; результат снова через `classifyActionFailure` (masked/not-found/job-failed → 400, иное → 502);
3. `sudo-needed` без пароля → 400 `Требуются права root для <action> <unit>: укажите sudo-пароль`;
4. `masked` / `not-found` / `job-failed` → **400 с текстом systemd как есть** — это состояние сервиса, а не «сервер недоступен»;
5. `transport` / иной ненулевой код → **502** (транспорт/неизвестное).

Ретрай безопасен: access-denied/interactive-auth означает, что мутация не началась.

**Форма sudo — без `sh -c`.** Используем `sudo -S -p '' -- systemctl <action> -- <unit>`, а не обёртку `sudoWrap` (`sh -c <shq(cmd)>` из аудита): аргумент unit'а уже shq-экранирован, лишний слой обёртки только добавляет экранирование. Обе формы рабочие — выбрана прямая, единообразно для всех действий.

**Пароль вводится заново на каждое действие** — как в аудите: на каждый запрос, не персистится. Осознанное решение v1 (остановил → посмотрел → запустил = три ввода). Допустимый вариант UX — удерживать пароль в стейте ServicesPage на время жизни вкладки (без persist) — на усмотрение реализации; инвариант «на сервере не сохраняется» не меняется.

### 1.4 Журнал: `GET /api/services/:unit/logs?profileId=&tail=&follow=1`

- Команда: `journalctl -u <unit> --no-pager -n <tail> [-f]` (unit через `shq`); `tail` 1..5000, дефолт 500 (те же границы, что заложит эпик 14).
- Без follow — разовый `exec` с таймаутом 30 с. Предел `exec` — 2 МБ: `journalctl -n 5000` болтливого unit'а может упереться в него, поэтому при достижении лимита дописываем хвостовую пометку `… (вывод обрезан по лимиту 2 МБ)` — как в разовой ветке эпика 14, молчаливая обрезка хуже честной.
- Транспорт — **не копия `routes/docker.ts` (там баг `handle.code`, см. раздел 0), а исправленный транспорт из эпика 14**: настоящий промис `handle.code` с первого момента; `flushHeaders()` + chunked `text/plain; charset=utf-8` + `Cache-Control: no-cache`; `req.on('close')` → `handle.close()`; завершение команды → `res.end()`. **Backpressure** — `res.write()` возвращает `false` → пауза чтения канала, `res.on('drain')` → возобновление (иначе `journalctl -f` на болтливом unit'е раздует память Node).
- **Follow-стримы — через общий лимитер эпика 14** (ключ — профиль, см. раздел 0): сверх лимита — 429.
- Sudo для журнала в v1 не делаем (роадмапом не предусмотрено). **Важно: отказ здесь не выглядит ошибкой.** `journalctl -u <unit>` от пользователя вне групп `adm`/`systemd-journal` обычно не падает и ничего не пишет в stderr — он выходит с кодом 0 и печатает `-- No entries --`, то есть пользователь получает пустой просмотрщик без объяснения. Поэтому UI при пустом выводе журнала показывает подсказку про группы (см. 2.2), а не молчит.

### 1.5 Роут и монтирование

- `server/src/routes/services.ts` — `servicesRouter` с 4 эндпоинтами; `profileId` из query, `requireProfile` → 404. **Статусы ошибок действий — по классификации 1.3** (400 для пользовательских причин, 502 только для транспорта); 429 — от лимитера follow-стримов.
- `server/src/index.ts`: `app.use('/api/services', requireAuth, servicesRouter)` — рядом с остальными роутами (паттерн index.ts:37-50).

---

## 2. Frontend

### 2.1 `web/src/api.ts`

Типы `UnitInfo`, `ServicesSnapshot`, `ServiceDetail`; функции:

- `fetchServices(profileId)` → `ServicesSnapshot`;
- `fetchServiceDetail(profileId, unit)` → `ServiceDetail`;
- `serviceAction(profileId, unit, action, sudoPassword?)` → `{ok, output}` — ошибки 400 с текстом systemd показываются как есть (toast), 502 — как «сервер недоступен»;
- `serviceLogsUrl(profileId, unit, tail, follow)` — URL стрима для просмотрщика.

Все через существующий `api()`.

### 2.2 Новая страница `web/src/pages/ServicesPage.tsx`

- **Тулбар** (паттерн `CronPage.tsx`): статус-точка + «Обновлено …», фильтр по тексту, переключатели «только запущенные» / «только сбойные», кнопка «Обновить».
- **Заглушка** при `available: false` — `empty-state` с `reason` + пояснением «systemd не обнаружен (Alpine/OpenRC/контейнер?) — управление службами недоступно» вместо таблицы.
- **Таблица** (`data-table`, `ports-scroll`): колонки Имя (mono) / Описание / Статус (бейдж `active/sub`: running — зелёный, failed — красный, остальное нейтральный) / Автозапуск (`enabled` текстом) / Действия. Сортировка через `useSortBy`; **дефолт: failed вверх** (accessor сортировки — приоритет `failed` → `activating` → остальные), как требует роадмап. Фильтры применяются до сортировки.
- **Панель детали** — при клике на строку: фетч `fetchServiceDetail`; raw-вывод `systemctl status` в `<pre class="logs-view">`-стиле + сводка полей `show` (MainPID, ActiveState, Restart, NRestarts, Result, FragmentPath, MemoryCurrent…) мелкими ячейками; кнопки действий, включая **«Сбросить failed»** (reset-failed) для сбойных unit'ов.
- **Модалка подтверждения действия**: «Перезапустить nginx?»; для критичных unit'ов — жирное предупреждение «Это может оборвать SSH/сеть»; опциональное поле «sudo-пароль (если нужны права)» с пояснением «передаётся только на этот запрос»; после успеха — немедленный refetch снимка.
  - **Критичный список** (точное имя или префикс до `.service`): `sshd, ssh, network, networking, networkd, systemd-networkd, firewalld, ufw, fail2ban, docker, containerd` — только усиливает confirm-текст, не блокирует.
- **Журнал**: кнопка «Журнал» в строке/панели детали открывает просмотрщик эпика 14 на `serviceLogsUrl(...)`; при скрытой вкладке страницы стрим на паузе (через `visible` просмотрщика); **429 от лимитера → toast с текстом** («достигнут лимит одновременных журналов на сервер»). **Пустой вывод журнала — подсказка под просмотрщиком** «Журнал пуст или недоступен: для чтения системного журнала пользователь должен быть в группе `adm` или `systemd-journal`» (см. 1.4: прав нет → пустой вывод с кодом 0, а не ошибка).
- **Polling 5 с** при `visible === true`, пауза при скрытии (паттерн `CronPage.tsx:196-219`); мутации применяют свежий snapshot сразу.

### 2.3 `web/src/App.tsx` + стили

- `type Tab` → добавить `'services'`; `TABS` → `{ id: 'services', label: 'Службы' }` (рядом с «Порты»/«Cron»).
- Keep-alive mount: `<ServicesPage key={activeProfile.id} profile={activeProfile} showError={showError} visible={tab === 'services'} />`.
- `styles.css`: переиспользование существующих классов (`data-table`, `scope-badge`, `empty-state`, `logs-view`, `search-input`); новых минимум: красный бейдж failed, сетка полей детали (`detail-grid`).

---

## 3. Тесты: `server/test/systemd.test.ts`

Все парсеры/билдеры/валидаторы — экспортируемые чистые функции:

1. `parseListUnits` по фикстурам: обычный unit; `getty@tty1.service` (имя с `@`); `load=not-found`; `-` в колонках (не загружен) → null; описание с пробелами (всё после 4-й колонки); пустой вывод → `[]`; мусорные строки отбрасываются.
2. `parseListUnitFiles`: **фикстуры обоих форматов — две колонки (`UNIT FILE STATE`) и три (`UNIT FILE STATE PRESET`, systemd ≥ 245); STATE всегда берётся как `fields[1]`, никогда как последнее поле**; все состояния (enabled/disabled/masked/static/indirect/generated/alias/bad); пустой вывод.
3. `mergeUnits`: unit только в list-units (transient → enabled null); только в unit-files (active/sub/load null); в обоих (значения из list-units + enabled из unit-files); сортировка.
4. `parseVersionLine`/`parseSnapshot`: версия systemd → available; `not found` → `{available: false}`; `has not been booted with systemd` → `{available: false, reason}`; **ошибка флага в начале секции (`Unknown option` / `Invalid option` / `Failed to`) → `{available: false}` с текстом ошибки в reason**.
5. Валидация имени unit'а: принять `nginx.service`, `foo@bar.service`, `postgresql@14-main`, `a.b-c_d:e`; отклонить `nginx; rm -rf /`, `..`, `/etc/passwd`, пробел, `$(x)`, пустую строку.
6. Валидация action: whitelist (включая `reset-failed`), отказ на `rm`, `exec`, `daemon-reload` (вне v1), пустое.
7. Классификация и sudo:
   - `classifyActionFailure`: **основная фикстура `sudo-needed` — `Failed to restart nginx.service: Interactive authentication required.` (polkit, типовой сервер)**; вторичные — `Access denied`, `Operation refused`, `Permission denied`, `Authentication is required`; `Unit nginx.service is masked.` → категория `masked` (ретрая нет); `Unit foo.service not found.` → `not-found`; `Job for nginx.service failed…` → `job-failed`; code 0 → `ok`.
   - Зонд пароля: stderr `Sorry, try again.` → «Неверный sudo-пароль»; `<user> is not in the sudoers file. This incident will be reported.` → «нет прав sudo» (400, не 502); `not found` → «sudo не установлен».
   - Сборка команд: без sudo (`systemctl start -- nginx.service`, unit через `shq`); с sudo — **прямая форма `sudo -S -p '' -- systemctl …` без `sh -c`**.
8. `parseShowOutput`: обычные поля, поле с `=` внутри значения, отсутствующее поле → null, повторяющееся поле — первое выигрывает.

Ручной сценарий — расширить `server/test/integration.manual.mjs`: снимок, деталь, действие (start/stop/restart тестового unit'а на sshd-стенде), журнал без follow. **Отдельный кейс polkit** (Debian/Ubuntu-стенд): действие без sudo-пароля → 400 «укажите sudo-пароль»; с паролем → успех; masked-unit → 400.

---

## 4. Порядок работ и коммиты

0. **Эпик 14** (по roadmap — до 13): просмотрщик логов **+ починка транспорта `execStream`** (настоящий `handle.code` с первого момента, backpressure через `createChunkGate`) **+ общий лимитер follow-стримов на профиль** (`services/stream-limits.ts`) — 13 берёт их готовыми. Если 14 уже реализован без починки — починка входит в 13.
1. `services/systemd.ts` + `test/systemd.test.ts` — парсеры, merge, детект, валидации, классификация, билдеры команд, кэш. `npm test` зелёный.
2. `routes/services.ts` (4 эндпоинта) + mount в `index.ts` — поверх готового сервиса; smoke через curl / `integration.manual.mjs`.
3. Frontend: `api.ts` + `ServicesPage.tsx` + таб в `App.tsx` + стили; ручной проход в dev-режиме (`scripts/docker-dev.sh` или локально `server` + `web`).
4. Документация и сдача: `docs/architecture.md` (раздел сервисов/маршрутов/тестов), `AGENTS.md` (новый роут `/api/services`, вкладка «Службы», sudo-инвариант), `npm run build` в `server/` и `web/`, `npm test`, `npm audit` — всё зелёное.

---

## 5. Риски

- **systemd есть не везде** — детект по `systemctl --version` + «has not been booted with systemd» + «ошибка флага в начале секции»; заглушка в UI с внятным `reason` вместо падения (Alpine/OpenRC/контейнеры/экзотические сборки).
- **polkit vs без polkit** — разные формулировки отказа (`Interactive authentication required` vs `Access denied`): обе в списке `sudo-needed`, polkit-вариант — основная фикстура тестов.
- **`stop`/`disable` на ssh/sshd/network\*** — потеря доступа: отдельное предупреждение в модалке для критичного списка; `sudo-needed` без пароля → явный 400, действие не выполняется.
- **sudo-пароль** — тот же инвариант, что в аудите: первая строка stdin, `sudo -S -p ''`, не в argv/логах, не сохраняется, живёт только в памяти одного запроса; зонд перед ретраем даёт явный «неверный пароль» вместо 502; ретрай безопасен (отказ прав до начала мутации).
- **Каналы SSH** — follow-стримы журнала через общий лимитер эпика 14 (`services/stream-limits.ts`, ключ — профиль); без него `journalctl -f` + `docker logs -f` + терминал упрутся в `MaxSessions 10` OpenSSH.
- **Backpressure** — как в эпике 14: `createChunkGate` (дроп чанков с маркером «пропущено N байт» при `res.writableLength > 1 МБ`); pause/resume канала эпиком 14 рассмотрен и отклонён. Без гейта болтливый unit раздувает память Node.
- **Журнал без sudo** — ограничение v1. Отказ маскируется под пустой журнал (`-- No entries --`, код 0), а не под ошибку, — поэтому подсказка про группы `adm`/`systemd-journal` в UI обязательна, иначе выглядит как «журнал не работает».
- **`systemctl status` долгий/объёмный** — `-n 0` (без журнала) + `--no-pager` + лимит exec 2 МБ; таймаут exec 60 с по умолчанию (manager.ts:97-98).
- **Имена с `@`** (template-инстансы `foo@bar.service`) — regex и `shq` покрывают; в URL `@` допустим, Express декодирует params.
- **Polling при открытой вкладке** — кэш 2 с на профиль гасит дубли (несколько запросов → один exec); при скрытой вкладке polling на паузе.

## 5.1 Вне области v1 (осознанно)

- **`daemon-reload`** — глобальное действие без unit'а, нужен отдельный эндпоинт; отложен.
- **Sudo для журнала unit'а** — отложено (см. 1.4).
- **Read-only инструменты агента поверх systemd (`list_services` / `service_status`)** — снимок появится, а `systemctl` целиком в deny-листе `guard.ts:15`: агент по-прежнему не видит службы. Шаг заманчив (в эпике 16 такой же заложен для `disk_usage`), но это расширение области — решается отдельным планом.

---

## 6. Оценка

~2–2.5 дня (эпик 13 без эпика 14; с 14 — суммарно ~3–3.5, из них починка транспорта `execStream` входит в 14):
- backend + тесты — ~1–1.25 дня;
- frontend — ~0.75–1 дня;
- интеграция, документация, сдача — ~0.25–0.5 дня.
