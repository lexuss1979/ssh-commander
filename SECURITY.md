# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/lexuss1979/ssh-commander/security/advisories/new). A GitHub account is required. Include the affected version or image digest, impact, and minimal reproduction steps using synthetic data. Do not open a public issue with exploit details or credentials. Ordinary bugs belong in [Issues](https://github.com/lexuss1979/ssh-commander/issues).

Never attach `.env`, private keys, passwords, a complete `data/` directory, or unredacted diagnostic archives. Share only the minimum sanitized information needed to reproduce the problem.

## Supported versions

Security fixes target the latest stable release listed in [Releases](https://github.com/lexuss1979/ssh-commander/releases). Older releases are not maintained separately. This is a volunteer project: there is no SLA, guaranteed response time, or guaranteed fix date.

## Trust boundaries

- This is a single-user tool for a trusted local computer. Compose publishes the panel and tunnel ports only on `127.0.0.1`. Do not expose it through a public port, reverse proxy, or shared hosting account. Protect your computer and Docker access.
- The app password is stored as a scrypt hash. SSH and database passwords and the AI API key are stored **in plaintext** in local `data/` files; private SSH keys live in `keys/`. Restrictive file permissions do not encrypt these files. Protect backups as carefully as the originals.
- The agent operates with the selected SSH user's permissions. Mutating tools require explicit approval. Automatic shell commands use a conservative read-only allow-list; sensitive file reads also require approval. Review the actual command and target server. Approval and secret redaction do not guarantee safety or undo changes.
- AI prompts, conversation context and tool results go to the configured AI provider. When web search is enabled, queries go to its configured search endpoint. Redaction is best effort; never paste secrets into chat. Manual tools can be used without an AI key. There is no ssh-commander telemetry.
- SSH host keys use trust on first use. Verify the first fingerprint through a trusted channel; investigate changed keys. Local SSH tunnel ports do not require the app password and may be accessible to other local processes.

See also the detailed [security notes](README.md#security) and [first-use guide](docs/getting-started.md).
