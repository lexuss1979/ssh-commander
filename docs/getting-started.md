# Your First Server and Task

**English** · [Русский](getting-started.ru.md) · [README](../README.md)

Connect a Linux server, ask the agent to inspect it, then move on to your own task. Start with a test server; back up important data before making changes.

## 1. Start the App

You need a running Docker installation with Compose v2 and a Linux server you can access over SSH. Run ssh-commander **on your own computer**, not on the VPS. Git and Node/npm are not required; the app does not rent servers for you. Create an empty directory and download Compose for version `0.1.1`:

Linux/macOS:

```bash
mkdir ssh-commander
cd ssh-commander
curl --fail --location https://raw.githubusercontent.com/lexuss1979/ssh-commander/v0.1.1/docker-compose.release.yml --output compose.yaml
docker compose up -d
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory ssh-commander
Set-Location ssh-commander
Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/lexuss1979/ssh-commander/v0.1.1/docker-compose.release.yml' -OutFile compose.yaml
docker compose up -d
```

[Backups, updates and source builds](installation.en.md).

Open [http://localhost:8080](http://localhost:8080). On first launch, choose an app password of at least 8 characters and repeat it. You can leave the API key empty for now. Click **Finish setup**. No `.env` file is needed for this path.

Keep the credentials separate: the **app password** protects the local panel; your **SSH password or key** grants access to the server; the **API key** grants access to your AI provider. These are three different things.

## 2. Connect Your Server

Open **Manage servers → + New server**. This is the ordinary connection form. The separate **New server (root + password)…** action configures an SSH key and can disable password login; you do not need it for this guide.

| Field | What to enter |
|---|---|
| Name | A useful label such as `new-vps`. It does not change the server's hostname. |
| Host | Your server's IP address or hostname, without `http://`, a path or port. |
| Port | The SSH port, usually `22`; use the value supplied by your provider. |
| Username | An existing SSH user. Do not leave `root` just because the form suggests it. |
| Authentication | Password or SSH key, matching your existing access. |

For password authentication, enter the **server user's password**. For key authentication, select **SSH key → Import…** and choose your private key file, not the `.pub` file. If encrypted, fill in **Key passphrase (if set)**. The imported key is stored locally in `keys/`; its form path will look like `/keys/id_ed25519`.

Click **Test connection**. On success, the result includes the host key fingerprint. The first host key is remembered automatically; where possible, verify its fingerprint through your provider's trusted console. Click **Save**, close the dialog, and select `new-vps` in the sidebar. Open **Terminal** to check that you get a server shell.

Do not use `localhost` or `127.0.0.1` as a remote VPS address: with Docker, those refer to the app container itself, not your VPS. Docker is not required on the remote server for ordinary SSH access.

## 3. Configure AI

If you skipped the key, click the gear at the bottom of the sidebar: **Settings → AI agent**. Select your provider, enter its API key and a model available to that key. **Custom URL** also requires the Base URL of an OpenAI-compatible API. Click **Save**; no app restart is needed.

Without a key, the terminal and other manual tools still work, but the agent is unavailable. API usage is billed separately by the provider. Estimated costs appear in the dialogue and **Settings → AI costs**. Change the interface and agent language in **Settings → Interface**.

Enter the key in settings, not in the dialogue. Prompts and tool results are sent to your configured AI provider; do not paste passwords or private keys into chat. Read [Cost and privacy](../README.md#cost-and-privacy) and [Security](../README.md#security).

## 4. Give It a First Task

Check that the correct server is selected. Open the panel with the **AI agent** button if hidden, and send:

> Inspect this server: its OS, free disk space, active services and listening ports. Briefly explain anything that needs attention. Do not install, restart or change anything yet.

The agent starts investigating. Allowed read-only tools run automatically. Other actions show an approval bar beside the input field:

- **More** shows the arguments, such as the full command or file contents. Also check which server the action targets.
- **Approve** permits that specific action. If it is unclear or does not match the task, click **Reject** and ask for an explanation or another approach.
- **Stop** interrupts the agent, but does not undo changes. A remote command that has already started may continue running.

Even a check, such as an HTTP request, can require approval: automatic read-only access is deliberately limited. The presence of an approval button does not mean an action is safe.

[Approval screenshot](media/agent-approval.png) · [Server overview screenshot](media/server-overview.png). Captured from the real UI with a synthetic SSH profile and a local scripted AI response; [capture details](media/README.md).

## 5. Move On to Your Task

On a new test VPS, you can enable **Plan** and ask:

> I want a simple "Hello from my VPS" website on Nginx, accessible over HTTP at this server's public IP. First check whether port 80 is free and whether a website already exists. If one exists, do not replace anything; ask me first. Propose an installation, verification and rollback plan. Do not change SSH settings; ask separately about firewall changes.

Review the plan. **Run** starts executing it, but individual changes still require approval. Afterwards, ask the agent to test the configuration, check the HTTP response and provide the website URL. Open it in your browser: a successful check from inside the server does not prove external access works.

Use your remote VPS's public address, not `localhost`. If the site does not open, tell the agent which URL you tried and the error you saw. Ask it to check the service, listening address and firewall; network rules in the VPS provider's control panel may need your involvement. Do not disable all protection just to test access.

[Watch the Nginx example (45 seconds)](media/hero-new-vps.mp4). The recording uses a local SSH test server and port `8088`, so do not copy its address literally for your VPS.

## Troubleshooting

| Symptom | What to check |
|---|---|
| The panel at `localhost:8080` will not open | Is Docker running? From the project directory, run `docker compose ps`, then `docker compose logs --tail=100`. A port-in-use error means another process owns the port; do not blindly stop unfamiliar services. |
| SSH timeout / connection refused | Check the host, SSH port, server availability, VPN and provider network rules. The agent cannot investigate a server without a working SSH connection; use your provider's console. |
| SSH authentication failed / permission denied | Check the username, authentication method, password or private key and its passphrase. The app password is not your SSH password. |
| The host key changed | Stop and verify the cause through your provider's trusted console. It may be a reinstall or an impersonated server. Do not remove the trust record just to connect. |
| Agent unavailable or API error | In Settings → AI agent, check the provider, key, model and Base URL. For 401/403 check key access; for 429 check provider limits and balance. Do not publish the key along with the error. |
| An action on the server lacks permission | The agent has the SSH user's permissions. Ask it to explain the required access; do not paste a sudo password into chat or switch everything to `root` without understanding why. |

If the problem persists, [open an issue](https://github.com/lexuss1979/ssh-commander/issues) with the version, your computer's OS, installation method, steps and error message. Remove secrets and private data from logs and screenshots before sharing them.
