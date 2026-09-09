# Установка и обновление

[English](installation.en.md) · [Первый сервер](getting-started.ru.md)

Готовый образ запускается на вашем компьютере с Docker и Compose v2; Git и Node/npm не нужны. Платформы — `linux/amd64` и `linux/arm64`: это архитектура компьютера с Docker, а не удалённого VPS. 32-битный ARM не поддерживается.

Текущая версия образа — **0.1.1**. [Release notes](https://github.com/lexuss1979/ssh-commander/releases/tag/v0.1.1) · [GHCR](https://github.com/lexuss1979/ssh-commander/pkgs/container/ssh-commander). В `v0.1.0` готового образа и release Compose ещё не было.

## Установка из образа

Создайте новую пустую папку. Команды скачивают Compose из конкретного тега `v0.1.1`, версия образа закреплена в файле. Не запускайте новый экземпляр на портах существующей установки.

Linux/macOS:

```bash
mkdir ssh-commander
cd ssh-commander
curl --fail --location 'https://raw.githubusercontent.com/lexuss1979/ssh-commander/v0.1.1/docker-compose.release.yml' --output compose.yaml
docker compose up -d
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory ssh-commander
Set-Location ssh-commander
Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/lexuss1979/ssh-commander/v0.1.1/docker-compose.release.yml' -OutFile compose.yaml
docker compose up -d
```

Откройте [http://localhost:8080](http://localhost:8080), задайте пароль приложения. Ключ AI можно пропустить. SSH-адрес VPS и его пароль/ключ вводятся отдельно в форме сервера. `localhost` внутри контейнера не является адресом VPS.

Compose закрепляет конкретную версию, публикует панель и туннели только на `127.0.0.1`, хранит данные в `./data`, SSH-ключи в `./keys`. Сохраняйте эти каталоги вместе с Compose. `.env` не обязателен: `APP_PASSWORD` и `AI_API_KEY/BASE/MODEL` задают начальные настройки только при первом старте. После него пароль и AI меняются в модалке «Настройки», а не через `.env`.

## Обновление

Прочитайте release notes выбранной версии, особенно изменения формата данных и инструкции миграции. Запишите текущую строку `image:` и digest (`docker image inspect IMAGE --format '{{json .RepoDigests}}'`). Остановите приложение для согласованной резервной копии:

```bash
docker compose stop
```

Скопируйте **оба** каталога `data/` и `keys/`, `compose.yaml` и `.env`, если он есть, в отдельное защищённое место. Linux/macOS:

```bash
backup="../ssh-commander-backup-$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir "$backup"
cp -a data keys compose.yaml "$backup/"
if [ -f .env ]; then cp -a .env "$backup/"; fi
```

PowerShell:

```powershell
$backupDir = "../ssh-commander-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory $backupDir
Copy-Item -LiteralPath data,keys,compose.yaml -Destination $backupDir -Recurse
if (Test-Path -LiteralPath .env) { Copy-Item -LiteralPath .env -Destination $backupDir }
```

Бэкап содержит открытые секреты: ограничьте доступ средствами ОС, не отправляйте архив в issue. Проверьте читаемость копии. Измените **точный тег** в `image:` на выбранную выпущенную версию (или закрепите опубликованный digest `image@sha256:…`), сохранив пути, порты и собственные настройки:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

При ошибке скачивания прежний контейнер можно запустить через `docker compose start`. После обновления проверьте вход, профили и ручные инструменты. Не удаляйте `data/`, `keys/` или volumes ради обновления.

Откат образа не откатывает данные. Для несовместимого формата нужен совместимый бэкап и процедура из release notes. Перед восстановлением остановите приложение; никогда не допускайте запись двух экземпляров в один каталог данных.

## Переход со сборки из исходников

В старом каталоге сначала выполните `docker compose down` и сделайте описанную выше резервную копию (в ней вместо `compose.yaml` сохраните старый `docker-compose.yml`). `down` сохраняет bind-каталоги `data/` и `keys/`. В той же папке сохраните скачанный release Compose как `docker-compose.release.yml`, чтобы относительные пути указывали на прежние данные:

```bash
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
```

Дальше всегда указывайте `-f docker-compose.release.yml` в этой папке. Старый `docker-compose.yml` продолжает означать сборку из исходников. Release Compose не задаёт глобальное имя контейнера, но его порты должны быть свободны. Не запускайте оба варианта одновременно.

## Сборка из исходников

Требуются Git и Docker с Compose v2. Сборка выполняется внутри Docker:

```bash
git clone https://github.com/lexuss1979/ssh-commander.git
cd ssh-commander
docker compose up -d --build
```

После изменения кода повторите команду с `--build`. Для hot-reload предусмотрен отдельный `docker-compose.dev.yml`, см. [CONTRIBUTING.md](../CONTRIBUTING.md).
