# План: перевод комментариев и тестов на английский

Проект стал opensource — англоязычные контрибьютеры должны понимать комментарии в коде и тестах. Переводим **комментарии/JSDoc во всех исходниках** и **имена/комментарии в тестах**. Функциональные строки не трогаем.

Цифры в батчах — приблизительный объём кириллицы (символы, включая строковые литералы; реальный объём перевода меньше, т.к. часть литералов остаётся русской).

## Что НЕ переводим (инварианты)

- `web/src/i18n/ru.ts` — русский словарь интерфейса, рабочие данные.
- `server/src/ai/strings.ts` — **ru-значения зафиксированы**, на них завязаны тесты. Переводим только комментарии.
- `server/src/ai/prompts.ts` — русские промпты модели (отправляются при `lang=ru`). Перевод меняет поведение агента — отдельное решение, в этом эпике не трогаем. Переводим только комментарии.
- Описания инструментов в `server/src/ai/tools.ts` — тоже уходят модели; русская версия остаётся для `lang=ru`. Двуязычность описаний — **этап 0** (см. ниже), выполняется до перевода комментариев.
- Русские строковые литералы в тестах, которые **ассертят** поведение (сравнение со строками из `strings.ts`, проверка текстов ошибок) — остаются русскими. Переводим `describe`/`it`-имена, комментарии, имена хелперов.
- Сентинел «Новый диалог» в `ai/dialogues.ts` — persisted-данные.
- `data/` (профили, диалоги) — не код.
- `docs/` — вне скоупа этого эпика (живую документацию переведём отдельно, если решим).

## Правила перевода

- Меняются только комментарии, JSDoc, имена тестов и нефункциональные текстовки. **Код не трогаем вообще.**
- Стиль — лаконичный технический английский, как в существующих английских комментариях проекта; терминология — из `docs/architecture.md` и README (exec, follow-stream, allow-list, corrupt-guard, TOFU и т.п.).
- Ссылки на инварианты (`эпик 13`, имена файлов, идентификаторы) сохраняются как есть.
- В тестах: сначала проверить, не сравнивается ли литерал с `strings.ts` или текстом ошибки — если да, литерал остаётся, переводятся имя теста и комментарии.

## Этап 0: двуязычные описания инструментов (`ai/tools.ts`) — ✅ выполнен

Сейчас описания инструментов захардкожены по-русски и `getToolDefs()` не принимает язык — англоязычному пользователю (`lang=en`) промпт уходит английский, а схемы инструментов — с русскими description. Делаем до перевода комментариев: после этого этапа батч S4 переведёт уже комментарии вокруг двуязычного словаря.

1. `server/src/ai/tools.ts`: описания инструментов (верхнеуровневый `description` каждого инструмента и `description` параметров в схемах) переводятся на словарь по образцу `prompts.ts` — ru-значения остаются дословно прежними (на них могут опираться тесты и поведение модели при `lang=ru`), добавляется en-версия. Форма — либо `description(lang)`, либо объект `{ ru, en }` + сборка в `getToolDefs(lang)`; выбрать то, что меньше раздувает схемы.
2. `getToolDefs(lang: PromptLang)` — сигнатура с языком; вызов в `agent.ts` (сейчас `agent.ts:566`) передаёт `this.lang`. Проверить остальных потребителей (`toolsForRequest` в `plan.ts` — plan-режим идёт без tools, но сигнатуру не сломать).
3. Тесты: расширить `server/test/agent-lang.test.ts` (или профильный тест tools) — при `lang=en` описания английские, при `lang=ru` дословно прежние русские.
4. Обновить AGENTS.md: убрать «описания инструментов в `ai/tools.ts` пока только русские», зафиксировать инвариант «описания инструментов двуязычны, ru — дословно прежние».
5. Проверки: `cd server && npm run build && npm test`.

## Проверки

- После каждого батча server/: `cd server && npm run build && npm test`.
- После каждого батча web/: `cd web && npm run build && npm run lint`.
- Коммиты батчами (сообщения на английском, как принято) — откат порции безболезнен.
- Pre-commit хук прогоняет те же проверки, но не полагаемся на него — гоняем руками после батча.

## Батчи: server/src (~96k кириллицы)

| # | Файлы | Объём |
|---|---|---|
| S1 ✅ | `ssh/manager.ts`, `ssh/sftp.ts`, `util/origin.ts`, `util/async.ts`, `util/path.ts` | ~2k |
| S2 ✅ | `config.ts`, `index.ts`, `types.ts`, `profiles.ts`, `auth.ts` | ~3.1k |
| S3 ✅ | `ai/agent.ts`, `ai/responses.ts`, `ai/dialogues.ts` (кроме сентинела), `ai/memory.ts`, `ai/plan.ts` | ~6k |
| S4 ✅ | `ai/prompts.ts` (только комментарии), `ai/tools.ts` (только комментарии), `ai/guard.ts` | ~9k |
| S5 ✅ | `ai/strings.ts` (только комментарии), `ai/redact.ts`, `ai/suggest.ts`, `ai/client.ts`, `ai/web-search.ts`, `ai/usage.ts`, `ai/pricing.ts` | ~9.5k |
| S6 ✅ | `routes/db.ts`, `routes/files.ts`, `routes/profiles.ts`, `routes/nginx.ts`, `routes/services.ts` | ~6.1k |
| S7 ✅ | `routes/settings.ts`, `routes/setup.ts`, `routes/packages.ts`, `routes/snippets.ts`, `routes/docker.ts`, `routes/processes.ts`, `routes/ports.ts`, `routes/terminal.ts`, `routes/disk-usage.ts`, `routes/cron.ts`, `routes/metrics-history.ts`, `routes/ai.ts`, `routes/alerts.ts`, `routes/tunnels.ts`, `routes/metrics.ts`, `routes/auth.ts`, `routes/overview.ts` | ~7.1k |
| S8 ✅ | `services/bootstrap.ts`, `services/systemd.ts` | ~8.9k |
| S9 ✅ | `services/db-query.ts`, `services/disk-usage.ts`, `services/cron.ts` | ~11k |
| S10 ✅ | `services/packages.ts`, `services/nginx.ts`, `services/nginx-parser.ts`, `services/settings.ts`, `services/processes.ts` | ~10.7k |
| S11 ✅ | `services/snippets.ts`, `services/security-audit.ts`, `services/tunnels.ts`, `services/db-discovery.ts`, `services/db-connections.ts`, `services/profile-transfer.ts`, `services/known-hosts.ts`, `services/keys.ts`, `services/metrics-history.ts`, `services/metrics.ts`, `services/db-dump.ts` | ~14k |
| S12 ✅ | `services/alerts.ts`, `services/ports.ts`, `services/history.ts`, `services/overview.ts`, `services/chunk-gate.ts`, `services/stream-limits.ts`, `services/file-search.ts`, `services/sudo.ts`, `services/container-ports.ts`, `services/external-ip.ts`, `services/docker.ts`, `services/file-tail.ts`, `services/transfer.ts` | ~6.4k |
| S13 ✅ | `ws/terminal.ts`, `ws/agent.ts` | ~1.5k |

## Батчи: web/src (~48k кириллицы, без `i18n/ru.ts`)

| # | Файлы | Объём |
|---|---|---|
| W1 ✅ | `App.tsx`, `api.ts` | ~9k |
| W2 ✅ | `pages/AgentPage.tsx`, `pages/TerminalPage.tsx` | ~9.9k |
| W3 ✅ | `pages/DatabasesPage.tsx`, `pages/OverviewPage.tsx`, `pages/FilesPage.tsx` | ~6.9k |
| W4 ✅ | `pages/ServicesPage.tsx`, `pages/NginxPage.tsx`, `pages/DockerPage.tsx`, `pages/AiCostsPage.tsx`, `pages/OnboardingPage.tsx`, `pages/CronPage.tsx`, `pages/ServersPage.tsx`, `pages/PortsPage.tsx`, `pages/LoginPage.tsx` | ~4.3k |
| W5 ✅ | `components/LogViewer.tsx`, `components/SnippetsSection.tsx`, `components/ProfileModal.tsx`, `components/SettingsModal.tsx`, `components/DiskUsageModal.tsx` | ~6.8k |
| W6 ✅ | `components/CodeEditor.tsx`, `components/Modal.tsx`, `components/AlertsBell.tsx`, `components/AlertsSettingsForm.tsx`, `components/Sparkline.tsx`, `components/Markdown.tsx`, `alerts.ts`, `log-buffer.ts`, `ai-providers.ts`, `hooks/useSortBy.tsx`, `types.ts`, `i18n/core.ts`, `i18n/index.tsx`, `i18n/en.ts`, `main.tsx` | ~4.9k |
| W7 ✅ | `styles.css` (комментарии в CSS) | ~6.2k |

## Батчи: server/test (~48k кириллицы)

| # | Файлы | Объём |
|---|---|---|
| T1 ✅ | `bootstrap.test.ts`, `disk-usage.test.ts` | ~4.7k |
| T2 ✅ | `systemd.test.ts`, `client.test.ts` | ~3.5k |
| T3 ✅ | `terminal-ws.test.ts`, `packages.test.ts`, `nginx.test.ts` | ~4.5k |
| T4 ✅ | `multi-server.test.ts`, `suggest.test.ts`, `snippets.test.ts` | ~4k |
| T5 ✅ | `settings-route.test.ts`, `web-search.test.ts`, `pricing.test.ts`, `settings.test.ts` | ~4.7k |
| T6 ✅ | `security-audit.test.ts`, `packages-route.test.ts`, `setup-route.test.ts`, `processes.test.ts` | ~4.2k |
| T7 ✅ | AI-мелочь: `agent-session-headers.test.ts`, `alerts-merge.test.ts`, `redact.test.ts`, `ai-strings.test.ts`, `i18n.test.ts`, `agent-usage.test.ts`, `plan.test.ts`, `ai-prompts.test.ts`, `ai-usage.test.ts`, `dialogues.test.ts`, `guard.test.ts`, `agent-lang.test.ts`, `messages.test.ts`, `memory.test.ts` | ~5.5k |
| T8 ✅ | сервисы/роуты, часть 1: `helpers/fake-ssh2.ts`, `stream-limits.test.ts`, `exec-stream.test.ts`, `history.test.ts`, `alerts.test.ts`, `file-tail-route.test.ts`, `profiles.test.ts`, `cron.test.ts`, `file-tail.test.ts`, `metrics-history.test.ts`, `db-connections.test.ts`, `known-hosts.test.ts`, `tunnels.test.ts` | ~5.9k |
| T9 ✅ | сервисы/роуты, часть 2: `db-query.test.ts`, `profiles-route.test.ts`, `profile-transfer.test.ts`, `alerts-route.test.ts`, `docker-logs-route.test.ts`, `cron-route.test.ts`, `origin.test.ts`, `metrics.test.ts`, `container-ports.test.ts`, `keys.test.ts`, `db-dump.test.ts`, `ports.test.ts`, `file-search.test.ts`, `overview.test.ts`, `db-discovery.test.ts` | ~2.4k |
| T10 ✅ | ручные сценарии: `integration.manual.mjs`, `bootstrap.manual.mjs`, `db.manual.mjs`, `agent.manual.mjs`, `nginx.manual.mjs`, `multi-server.manual.mjs`, `security-audit.manual.ts`, `mock-openai-manual.mjs` | ~8.8k |

## Финальные шаги

1. Обновить `AGENTS.md`: «Комментарии в коде и документация — на русском» → комментарии и тесты на английском (документация пока на русском, до отдельного решения). Это критично — иначе новые русские комментарии будут появляться снова.
2. Финальная проверка полноты: `grep -rP '\p{Cyrillic}'` по `server/src`, `server/test`, `web/src` — остаться должны только белый список (`i18n/ru.ts`, ru-значения `strings.ts`, промпты `prompts.ts`, описания `tools.ts`, русские литералы в тестовых ассертах, сентинел «Новый диалог»).
3. Полный прогон: `npm run build` в обоих каталогах, `npm test`, `npm run lint`, `npm audit`.
4. Запись в `CHANGELOG.md`.

## Порядок выполнения

Сначала **этап 0** (двуязычные описания инструментов), затем server/src (S1–S13), web/src (W1–W7), тесты (T1–T10). Тесты в конце — чтобы к моменту их перевода устоялась терминология из комментариев кода, на которую тесты ссылаются. Батчи внутри группы независимы, можно параллелить субагентами; в одном батче файлы одной подсистемы, чтобы терминология была консистентной.
