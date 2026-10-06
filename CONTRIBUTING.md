# Contributing

Small fixes and documentation improvements can be proposed directly. For large changes, discuss in an issue first: describe the user's task and the expected behavior. Opening an issue is not a promise of implementation. A PR should solve one clear task and explain what changed and how it was verified.

## Environment

You need Git, Node.js 22 LTS, and npm. To run in a container — Docker with Compose v2. Clone the repository and run `npm ci` separately in `server/` and `web/`. Install the git hook: `bash scripts/install-hooks.sh`.

For hot-reload use `bash scripts/docker-dev.sh up`: API on `:8081`, web on `:5173`. If those ports are busy, pick free ones in a separate configuration first. Changing package.json/lock requires running `up` again to rebuild dependencies. The dev container uses its own data but mounts `keys/` read-only; to test with fictional data, use a separate clone without real keys.

To run locally without Docker: `npm run dev` in `server/` and `web/` in two terminals. Set separate `DATA_DIR` and `KEYS_DIR` so you don't touch your working installation. Detailed rules — [AGENTS.md](AGENTS.md); subsystem internals — the [architecture doc](docs/architecture.md).

## Checks before a PR

From the repository root (run each command in the given directory):

```bash
cd server
npm ci
npm run build
npm test
npm audit --audit-level=low
cd ../web
npm ci
npm run build
npm run lint
npm audit --audit-level=low
```

CI runs the same set. Unit tests need no SSH server, sudo password, or paid AI API. A network error during audit does not mean there are no vulnerabilities. Build the Docker image from source with `docker compose up -d --build`. To smoke-check a separately built image: `node scripts/smoke-image.mjs IMAGE linux/amd64` — it uses temporary data and a free loopback port.

TypeScript is strict; relative server imports use the `.js` extension. Add new UI strings to ru and en at the same time. Code comments and internal technical documentation are currently written in English; commit messages are in English too. Do not extend the agent's read-only tools without guard checks and tests.

## Data in examples

Use fictional profiles and test servers. Do not put `.env`, private keys, passwords, `data/` contents, or unredacted diagnostic archives into commits, issues, PRs, or screenshots. Review the diff before submitting. Report vulnerabilities [privately](SECURITY.md); ordinary bugs go through the bug report form.
