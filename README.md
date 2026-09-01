# ssh-commander

**English** · [Русский](README.ru.md)

<!-- Screencast placeholder: add an animated GIF here — e.g. the agent investigating
     "why is the disk full?" and asking for approval before acting on anything. -->

A local, password-protected web app for managing remote Linux servers over SSH: terminal, file manager (SFTP), Docker Explorer, databases, systemd services, Nginx, cron — plus an AI agent that works through your SSH connection and **asks for confirmation before every mutating action**.

Runs via Docker, listens on `127.0.0.1` only. No cloud, no accounts, no telemetry: the agent uses **your own API key** with any OpenAI-compatible provider, and all state stays on your machine.

Self-hosted server panels are a crowded niche — but none of them ship an AI agent that operates on your servers and asks before touching anything, while keeping everything local with your own API key. That's the gap ssh-commander fills.

## Features

### Terminal
- Full PTY via xterm.js; several terminal tabs per server (up to 4); sessions survive page reloads.
- Command-history palette (Ctrl+R); send the last output or a selection to the AI agent in one click.

### File manager (SFTP)
- Browse, upload/download files **and whole directories** (tar.gz), inline editing with syntax highlighting (CodeMirror), create/rename/delete/chmod.
- Search by file name or content, live `tail -F` log viewing, "what's taking space" disk-usage explorer.

### Docker Explorer
- Containers, images, volumes, networks: start/stop/restart/remove, pull, run, prune, live logs (follow).
- `docker compose` (v2) up/down, a terminal inside a container, and a port overview that includes unpublished container-network-only ports.

### Databases
- PostgreSQL and MySQL connections: query, dump, and a read-only toggle per connection.

### Services (systemd)
- Full unit snapshot, start/stop/restart, enable/disable autostart, daemon-reload — with sudo — and live journal follow.

### Nginx
- Config discovery (native and inside containers), sites grouped by config file, certificate expiry dates, `nginx -t` check and safe reload.

### Ports & SSH tunnels
- Everything listening on the host plus container ports (published and container-network-only).
- One-click SSH port forwarding: `localhost:<port>` → remote service (TCP only).

### Cron & processes
- View/edit the user crontab; top processes on the Overview tab with TERM/KILL/HUP signals and renice.

### Package updates
- Snapshot of available updates (apt/dnf/yum/apk) and one-click apply, streamed live with sudo confirmation.

### AI agent
- OpenAI-compatible API with tool calling (OpenAI, OpenRouter, vLLM, DeepSeek, …).
- **Read-only tools run automatically; anything that mutates (write a file, run a command, docker action, connect a server) waits for your approve/reject in the UI.** A conservative deny-list filters what read-only commands may even run.
- Plan mode: the agent proposes a plan first, you approve it, then it executes.
- Per-profile persistent memory (`MEMORY.md`, loaded into context at session start); secrets are never written to it.
- Optional web search tool (DeepSeek), cost tracking per dialogue, suggested-reply hints.
- Agent language controlled by `AI_LANG` (`ru`/`en`).

### Servers
- Multiple SSH profiles (password or key auth), key import from the UI (saved with `0600`), one-click bootstrap of a new server (root + password), saved command snippets that run on several servers at once, threshold alerts with a sidebar bell (availability/disk/memory/load).

### Localization
- UI in English and Russian — switch in the sidebar, no reload; default follows the browser locale.

## Quick start

```bash
cp .env.example .env
# edit .env — at minimum set APP_PASSWORD; to enable the agent add AI_API_KEY
# (and AI_MODEL if you want a different model); AI_LANG=en for an English-speaking agent

docker compose up -d --build
```

Open [http://localhost:8080](http://localhost:8080), sign in with the password from `.env`, add a server, and go.

Notes:

- **SSH keys**: put them into `keys/`, or import them later via the UI (server form → "Import…", saved with `0600`). In a profile the key path is the in-container path, e.g. `/keys/id_rsa`. Key contents are never returned by the API.
- There is no need to build the frontend manually — the Dockerfile builds it inside the image.
- If the browser shows "Cannot GET /", the container runs an old image: run `docker compose up -d --build` again (`--build` is mandatory after code changes).
- SSH tunnels: the container publishes `127.0.0.1:10000-10049` (configurable via `TUNNEL_PORT_MIN`/`TUNNEL_PORT_MAX`) for forwarded ports.

## Configuration

Environment variables are set via `.env` (template: `.env.example`); inside the container they come from `environment` in `docker-compose.yml`.

| Variable | Default | Description |
|---|---|---|
| `APP_PORT` / `APP_HOST` | `8080` / `0.0.0.0` | HTTP/WS port and bind address |
| `APP_PASSWORD` | `admin` | Password for the web UI |
| `DATA_DIR` | `/data` (docker) | Directory with `profiles.json`, `db-connections.json`, `ai-dialogues.json`, `memory/`, … |
| `KEYS_DIR` | `/keys` (docker) | Directory with SSH keys |
| `WEB_DIST` | auto-detected | Path to the built frontend |
| `AI_API_BASE` | `https://api.openai.com/v1` | Base URL of an OpenAI-compatible API |
| `AI_API_KEY` | empty | API key; without it the agent is unavailable |
| `AI_MODEL` | `gpt-4.1-mini` | Agent model |
| `AI_MAX_STEPS` | `30` | Step limit of the agent loop |
| `AI_TEMPERATURE` | `0.2` | Model temperature |
| `AI_SEARCH_API_BASE` | empty | Anthropic-compatible web-search endpoint for the agent (DeepSeek: `https://api.deepseek.com/anthropic`, same `AI_API_KEY`). Empty — search is disabled and the tool is not announced to the model |
| `AI_SEARCH_MODEL` | `deepseek-v4-flash` | Model used for web search |
| `AI_LANG` | `ru` | Agent language — the system prompt and plan instruction. `en` — English; unknown values fall back to `ru` |
| `TUNNEL_PORT_MIN` / `TUNNEL_PORT_MAX` | `10000` / `10049` | Port range for SSH tunnels (local end) |

### Data storage

Server profiles live in `data/profiles.json` (volume `./data`), DB connections in `data/db-connections.json`, saved snippets in `data/snippets.json`, agent dialogues in `data/ai-dialogues.json`, the AI usage/cost journal in `data/ai-usage.json`, and agent memory in `data/memory/<profileId>/MEMORY.md`. SSH keys are mounted from `./keys` into `/keys` inside the container.

## Security

**Read this before exposing anything.**

- The recommended deployment (`docker compose`) publishes the app **only to `127.0.0.1`** — it is not reachable from the network. Don't change the port mapping or `APP_HOST` unless you understand the risk: this tool is not built to be exposed.
- It is a **single-user local tool**: SSH passwords and key passphrases are stored **in plain text** in `data/profiles.json`; database passwords likewise in `data/db-connections.json`. Never publish the `data/` volume and never expose the container beyond localhost.
- SSH tunnels open an **unauthenticated listener** on `127.0.0.1:<port>` — any local process or user can reach the forwarded service without the app password (the same trust model as a local terminal).
- The AI agent **never executes mutating actions without your approval**; read-only commands pass a conservative deny-list. The agent's memory never stores secrets — the system prompt forbids it.
- The optional web search sends your query text to the configured external search API — leave `AI_SEARCH_API_BASE` empty to disable it entirely.
- Exposing this tool to the internet is a reliable way to get your servers compromised. Don't.

## Support

Published as-is. Maintained on a best-effort basis by the author — issues and PRs are welcome, but there is no SLA. Found and fixed something? A PR is the best way to make it stick.

## Development

```bash
# server (API + WebSocket on :8080)
cd server && npm install && npm run dev

# frontend with hot reload (Vite on :5173, proxies /api and /ws to :8080)
cd web && npm install && npm run dev
```

Tests and checks:

```bash
cd server && npm test        # vitest unit tests
cd web && npm run lint       # eslint
```

Pre-commit hooks (eslint + tsc + vitest + web build on every commit):

```bash
bash scripts/install-hooks.sh
```

## License

MIT — see [LICENSE](LICENSE).
