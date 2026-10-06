import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import { config, ensureDirs } from './config.js';
import { SESSION_COOKIE, hasSession, readCookie, requireAuth } from './auth.js';
import { authRouter } from './routes/auth.js';
import { setupRouter } from './routes/setup.js';
import { settingsRouter } from './routes/settings.js';
import { getAiSettings, seedSettingsFromEnv } from './services/settings.js';
import { profilesRouter } from './routes/profiles.js';
import { keysRouter } from './routes/keys.js';
import { filesRouter } from './routes/files.js';
import { dockerRouter } from './routes/docker.js';
import { aiRouter } from './routes/ai.js';
import { metricsRouter } from './routes/metrics.js';
import { metricsHistoryRouter } from './routes/metrics-history.js';
import { portsRouter } from './routes/ports.js';
import { tunnelsRouter } from './routes/tunnels.js';
import { overviewRouter } from './routes/overview.js';
import { cronRouter } from './routes/cron.js';
import { servicesRouter } from './routes/services.js';
import { processesRouter } from './routes/processes.js';
import { terminalRouter } from './routes/terminal.js';
import { dbRouter } from './routes/db.js';
import { diskUsageRouter } from './routes/disk-usage.js';
import { snippetsRouter } from './routes/snippets.js';
import { packagesRouter } from './routes/packages.js';
import { alertsRouter } from './routes/alerts.js';
import { nginxRouter } from './routes/nginx.js';
import { requireProfile } from './profiles.js';
import { attachTerminal } from './ws/terminal.js';
import { handleAgentWs, parseAgentLang } from './ws/agent.js';
import { isAllowedOrigin, isLoopbackHostname } from './util/origin.js';

ensureDirs();
// Seed from env on first start (docs/settings-model-plan.md): settings.json
// doesn't exist yet and env is set → values are copied into settings (the
// password as a hash). After that env is never read — data/settings.json is
// the source of truth.
seedSettingsFromEnv();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

/**
 * Cross-site requests are cut off by `Origin` (util/origin.ts) before any
 * router: before this the only protection was `sameSite: 'lax'` on the
 * cookie. /api/health deliberately stays open — healthchecks use it.
 */
app.use('/api', (req, res, next) => {
  if (isAllowedOrigin(req.headers.origin)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Запрос с постороннего источника отклонён' });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
// First-run setup (onboarding, docs/onboarding-plan.md) — no requireAuth:
// a public status and a one-shot POST, available only until the first setup.
app.use('/api/setup', setupRouter);
app.use('/api/profiles', requireAuth, profilesRouter);
app.use('/api/keys', requireAuth, keysRouter);
app.use('/api/files', requireAuth, filesRouter);
app.use('/api/docker', requireAuth, dockerRouter);
app.use('/api/ai', requireAuth, aiRouter);
app.use('/api/metrics', requireAuth, metricsRouter);
app.use('/api/metrics-history', requireAuth, metricsHistoryRouter);
app.use('/api/ports', requireAuth, portsRouter);
app.use('/api/tunnels', requireAuth, tunnelsRouter);
app.use('/api/overview', requireAuth, overviewRouter);
app.use('/api/cron', requireAuth, cronRouter);
app.use('/api/services', requireAuth, servicesRouter);
app.use('/api/processes', requireAuth, processesRouter);
app.use('/api/terminal', requireAuth, terminalRouter);
app.use('/api/db', requireAuth, dbRouter);
app.use('/api/disk-usage', requireAuth, diskUsageRouter);
app.use('/api/snippets', requireAuth, snippetsRouter);
app.use('/api/packages', requireAuth, packagesRouter);
app.use('/api/alerts', requireAuth, alertsRouter);
app.use('/api/nginx', requireAuth, nginxRouter);
// Settings page (epic 23): password and AI config changes are behind auth.
app.use('/api/settings', requireAuth, settingsRouter);

// SPA static files (built web app).
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
      next();
      return;
    }
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
} else {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
      next();
      return;
    }
    res
      .status(200)
      .type('html')
      .send(
        '<!doctype html><html lang="ru"><meta charset="utf-8">' +
          '<body style="font-family:sans-serif;background:#0f1419;color:#d8dee9;padding:48px">' +
          '<h1>ssh-commander</h1>' +
          `<p>Веб-интерфейс не найден (искал в <code>${config.webDist}</code>).</p>` +
          '<p>Запускайте через <code>docker compose up -d --build</code> ' +
          'или соберите фронтенд: <code>cd web && npm install && npm run build</code>.</p>' +
          '</body></html>',
      );
  });
}

// Unhandled error: the full text goes to the log, a generic message goes
// outside. Node messages contain container-internal paths and implementation
// details; routes with their own meaningful texts never reach here — they
// answer for themselves.
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  },
);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // Same gate as /api: a WS handshake from someone else's page is a ready
  // terminal on the user's servers.
  if (!isAllowedOrigin(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (!token || !hasSession(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (url.pathname !== '/ws/terminal' && url.pathname !== '/ws/agent') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const profileId = url.searchParams.get('profileId') ?? '';
    let profile;
    try {
      profile = requireProfile(profileId);
    } catch {
      ws.close(1008, 'Profile not found');
      return;
    }
    if (url.pathname === '/ws/terminal') {
      const cols = Number(url.searchParams.get('cols')) || 80;
      const rows = Number(url.searchParams.get('rows')) || 24;
      const container = url.searchParams.get('container') || undefined;
      // Terminal tab tabId (epic 15): missing or empty value → default 0
      // inside attachTerminal (same as container/cols/rows); garbage
      // non-empty → close(1008).
      const tabId = url.searchParams.get('tabId') || null;
      const containerName = url.searchParams.get('containerName') || undefined;
      attachTerminal(ws, profile, cols, rows, container, tabId, containerName);
    } else {
      const dialogueId = url.searchParams.get('dialogueId') ?? undefined;
      // Agent language = UI language: a WS connection parameter, garbage → ru.
      handleAgentWs(ws, profile, dialogueId, parseAgentLang(url.searchParams.get('lang')));
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(`ssh-commander listening on http://${config.host}:${config.port}`);
  if (!isLoopbackHostname(config.host)) {
    console.warn(
      `WARNING: APP_HOST=${config.host} — the app is reachable from the network. ` +
        'It is a single-user local tool without TLS: one password guards SSH access to every server. ' +
        'Use 127.0.0.1 unless the port is deliberately published (Docker publishes it as 127.0.0.1:8080).',
    );
  }
  if (!getAiSettings().apiKey) {
    console.warn(
      'AI key is not configured (data/settings.json) — AI agent will be unavailable until set.',
    );
  }
  if (!fs.existsSync(config.webDist)) {
    console.warn(`Web UI not found at ${config.webDist} — serving API only.`);
  }
});
