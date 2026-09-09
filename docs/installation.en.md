# Installation and updates

[Русский](installation.md) · [Your first server](getting-started.md)

Run the prebuilt image on your computer with Docker and Compose v2; Git and Node/npm are not required. Platforms are `linux/amd64` and `linux/arm64`: the architecture of the computer running Docker, not the remote VPS. 32-bit ARM is not supported.

**Release preparation:** the first image, `0.1.1`, has not been published yet. Use the [source build](#source-build) for now. Image installation applies after [Releases](https://github.com/lexuss1979/ssh-commander/releases) lists a release with `docker-compose.release.yml` and a verified public image. `v0.1.0` does not contain this file.

## Install the image

Create an empty directory. Browse the chosen release's source at its tag, open `docker-compose.release.yml` and click **Raw**. Substitute that URL for `COMPOSE_URL` below: it must contain a specific tag, not `main`. Do not run a second installation on ports used by an existing one.

Linux/macOS:

```bash
mkdir ssh-commander
cd ssh-commander
curl --fail --location 'COMPOSE_URL' --output compose.yaml
docker compose up -d
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory ssh-commander
Set-Location ssh-commander
Invoke-WebRequest -Uri 'COMPOSE_URL' -OutFile compose.yaml
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080), choose an app password, and skip the AI key if you prefer. Add the VPS SSH address and credentials separately in the server form. `localhost` inside the container is not your VPS.

Compose pins an exact version, publishes the panel and tunnels only on `127.0.0.1`, and stores data in `./data` and SSH keys in `./keys`. Keep these directories with Compose. No `.env` is needed: `APP_PASSWORD` and `AI_API_KEY/BASE/MODEL` only seed settings on first launch. Afterwards use Settings to change the password and AI configuration.

## Update

Read the release notes, including format changes and migration instructions. Record the existing `image:` line and digest (`docker image inspect IMAGE --format '{{json .RepoDigests}}'`). Stop the app for a consistent backup:

```bash
docker compose stop
```

Copy **both** `data/` and `keys/`, `compose.yaml`, and `.env` if present, to a separate protected location. Linux/macOS:

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

Backups contain plaintext secrets. Restrict access through your OS and never attach them to issues. Verify the copy is readable. Change the **exact tag** in `image:` to the chosen published version (or pin its published `image@sha256:…` digest), preserving your paths, ports and configuration:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

If downloading fails, `docker compose start` can restart the previous container. After updating, check login, profiles and manual tools. Do not delete `data/`, `keys/` or volumes to update.

Rolling back the image does not roll back data. An incompatible format change may require a matching backup and a release-specific recovery procedure. Stop the app before restoring; never allow two instances to write to the same directory.

## Switch from a source build

In the old directory, run `docker compose down`, then back up as above (save the old `docker-compose.yml` instead of `compose.yaml`). `down` preserves the bind-mounted `data/` and `keys/`. Save the downloaded release Compose there as `docker-compose.release.yml`, keeping the existing relative data paths:

```bash
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
```

Always use `-f docker-compose.release.yml` there afterwards. The original `docker-compose.yml` still means a source build. Release Compose does not set a global container name, but its ports must be free. Never run both variants simultaneously.

## Source build

Requires Git and Docker with Compose v2. Docker builds the app internally:

```bash
git clone https://github.com/lexuss1979/ssh-commander.git
cd ssh-commander
docker compose up -d --build
```

Repeat with `--build` after changing code. Hot-reload remains separate in `docker-compose.dev.yml`; see [CONTRIBUTING.md](../CONTRIBUTING.md).
