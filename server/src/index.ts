import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import { config, ensureDirs } from './config.js';
import { SESSION_COOKIE, hasSession, readCookie, requireAuth } from './auth.js';
import { authRouter } from './routes/auth.js';
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
import { terminalRouter } from './routes/terminal.js';
import { dbRouter } from './routes/db.js';
import { diskUsageRouter } from './routes/disk-usage.js';
import { requireProfile } from './profiles.js';
import { attachTerminal } from './ws/terminal.js';
import { handleAgentWs } from './ws/agent.js';

ensureDirs();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
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
app.use('/api/terminal', requireAuth, terminalRouter);
app.use('/api/db', requireAuth, dbRouter);
app.use('/api/disk-usage', requireAuth, diskUsageRouter);

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

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(500).json({ error: err.message });
  },
);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
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
      attachTerminal(ws, profile, cols, rows, container);
    } else {
      const dialogueId = url.searchParams.get('dialogueId') ?? undefined;
      handleAgentWs(ws, profile, dialogueId);
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(`ssh-commander listening on http://${config.host}:${config.port}`);
  if (config.appPassword === 'admin') {
    console.warn('WARNING: using default password. Set APP_PASSWORD to change it.');
  }
  if (!config.ai.apiKey) {
    console.warn('AI_API_KEY is not set — AI agent will be unavailable until configured.');
  }
  if (!fs.existsSync(config.webDist)) {
    console.warn(`Web UI not found at ${config.webDist} — serving API only.`);
  }
});
