# Выпуск готового образа

Публикацию и номер следующей версии согласует владелец. Не передвигать существующие теги, не переиздавать другой код под старой версией. Выпуск `0.1.1` согласован владельцем 2026-09-10.

1. Включить изменения в `main`, дождаться зелёного [CI](https://github.com/lexuss1979/ssh-commander/actions/workflows/ci.yml). Проверить локально обе сборки, тесты, lint, audit, Docker smoke и Gitleaks всей истории с `--all --full-history -m`, как в [publication-readiness.md](publication-readiness.md). Проверка только файлов не заменяет историю.
2. После согласования синхронно обновить версии в обоих package.json, корневой версии обоих lock и `packages[""].version`, строке `image:` release Compose. Обновить CHANGELOG и подготовить текст релиза. Не менять зависимости ради номера версии.
3. Проверить финальный коммит и создать новый тег `vX.Y.Z` на нём. Push тега запускает `Release image`; ветки и PR ничего не публикуют. Текущий workflow выпускает только стабильные версии, prerelease отклоняется и не меняет `latest`.
4. `validate` проверяет тег и версии, `checks` выполняет reusable CI на том же SHA. Только job `publish` получает `packages: write`. Actions закреплены полными SHA проверенных релизов, используют Node 24 для самих actions; приложение и проверки — Node 22. Hosted runner — Ubuntu 24.04. Node 20 больше не используется из-за EOL.
5. Публикация сначала создаёт технический тег `sha-<commit>`, затем скачивает его по digest и выполняет `scripts/smoke-image.mjs` для amd64 и arm64. ARM проверяется через QEMU, а не на физическом Mac/Raspberry Pi. Только после успешных smoke назначаются точная версия и `latest`. Повтор старого выпуска не понижает `latest`.
6. Для повтора используйте **Re-run failed jobs** либо **Run workflow**, выбрав существующий тег. Скрипт использует уже опубликованную версию или кандидата того же SHA и проверяет OCI revision/version на обеих платформах. Ошибка сети/авторизации останавливает выпуск; только подтверждённый registry 404 означает отсутствие manifest. Если кандидат имеет неверные метаданные, не удалять/переписывать его автоматически: выяснить причину и выбрать новый выпуск.
7. После первой публикации откройте настройки [пакетов владельца](https://github.com/lexuss1979?tab=packages), проверьте связь `ssh-commander` с репозиторием, доступ workflow и выставьте видимость **Public**. Публичный репозиторий сам по себе этого не гарантирует. Для workflow используется штатный `GITHUB_TOKEN`, отдельный PAT для registry не нужен.
8. Сохраните digest и SHA из summary workflow. В отдельном временном каталоге Docker config с содержимым `{}` выполните анонимный pull обеих платформ. Не делайте глобальный `docker logout`. Например, PowerShell:

```powershell
$registryConfig = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory $registryConfig
[IO.File]::WriteAllText((Join-Path $registryConfig 'config.json'), '{}')
docker --config $registryConfig pull --platform linux/amd64 ghcr.io/lexuss1979/ssh-commander:VERSION
docker --config $registryConfig pull --platform linux/arm64 ghcr.io/lexuss1979/ssh-commander:VERSION
```

9. Проверьте manifest и smoke по опубликованному digest, чистую установку скачанного Compose и переход с source-build на синтетических данных. Публичные команды проверяются после публикации. Только тогда замените предупреждения «готовится к выпуску» в README и installation ru/en готовыми URL конкретного тега и сделайте образ основным Quick start. Сохраните путь сборки из исходников и пояснение к прежнему Quickstart-ролику, который показывает сборку.
10. Запишите фактические результаты в [план](distribution-readiness-plan.md): workflow runs, версия, SHA, digest, публичные ссылки, проверенные ОС и ограничения. Создайте GitHub Release с этими данными. При сбое укажите этап; наличие кандидата в registry не равно завершённому выпуску.

Для private vulnerability reporting форма включается отдельно в настройках репозитория. Проверка API: `gh api repos/lexuss1979/ssh-commander/private-vulnerability-reporting`. Владельцу нужно проверить подписку **Watch → Custom → Security alerts** и собственные настройки получения уведомлений; тестовое сообщение от имени исследователя отправлять не нужно.

Официальные источники: [Node.js release status](https://nodejs.org/en/about/previous-releases), [GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [private reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository), [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node), [Buildx](https://github.com/docker/setup-buildx-action), [QEMU](https://github.com/docker/setup-qemu-action), [login](https://github.com/docker/login-action).
