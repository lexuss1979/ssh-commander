import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import {
  containerAction,
  inspect,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  pullImage,
  removeImage,
  removeNetwork,
  removeVolume,
  runContainer,
  streamContainerLogs,
  type RunContainerOptions,
} from '../services/docker.js';

export const dockerRouter = Router();

function profileId(req: { query: Record<string, unknown>; body?: Record<string, unknown> }): string {
  const q = String(req.query.profileId ?? '');
  if (q) return q;
  const b = req.body as Record<string, unknown> | undefined;
  return String(b?.profileId ?? '');
}

dockerRouter.get('/containers', async (req, res) => {
  try {
    res.json(await listContainers(requireProfile(profileId(req))));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.get('/containers/:id/inspect', async (req, res) => {
  try {
    res.json(await inspect(requireProfile(profileId(req)), req.params.id));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.post('/containers/:id/:action', async (req, res) => {
  try {
    const action = req.params.action as 'start' | 'stop' | 'restart' | 'rm';
    if (!['start', 'stop', 'restart', 'rm'].includes(action)) {
      res.status(400).json({ error: 'Неизвестное действие' });
      return;
    }
    const output = await containerAction(requireProfile(profileId(req)), action, req.params.id);
    res.json({ ok: true, output });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.post('/containers', async (req, res) => {
  try {
    const opts: RunContainerOptions = {
      image: String(req.body?.image ?? ''),
      name: req.body?.name ? String(req.body.name) : undefined,
      ports: Array.isArray(req.body?.ports) ? req.body.ports.map(String) : [],
      env: Array.isArray(req.body?.env) ? req.body.env.map(String) : [],
      command: req.body?.command ? String(req.body.command) : undefined,
    };
    const output = await runContainer(requireProfile(profileId(req)), opts);
    res.json({ ok: true, output });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.get('/containers/:id/logs', async (req, res) => {
  const profile = requireProfile(profileId(req));
  const tail = Math.max(1, Number(req.query.tail ?? 200));
  const follow = req.query.stream === '1' || req.query.follow === '1';
  if (!follow) {
    const { dockerExec } = await import('../services/docker.js');
    try {
      const result = await dockerExec(profile, ['logs', '--tail', String(tail), req.params.id], {
        timeoutMs: 30000,
      });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send([result.stdout, result.stderr].filter(Boolean).join('') || '(логов нет)');
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
    return;
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  let closed = false;
  const handle = streamContainerLogs(profile, req.params.id, tail, (chunk) => {
    if (!closed) res.write(chunk);
  });
  void handle.code.then(() => {
    if (!closed) res.end();
  }).catch(() => {
    if (!closed) res.end();
  });
  req.on('close', () => {
    closed = true;
    handle.close();
  });
});

dockerRouter.get('/images', async (req, res) => {
  try {
    res.json(await listImages(requireProfile(profileId(req))));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.post('/images/pull', async (req, res) => {
  try {
    const image = String(req.body?.image ?? '');
    if (!image) {
      res.status(400).json({ error: 'Укажите образ' });
      return;
    }
    const output = await pullImage(requireProfile(profileId(req)), image);
    res.json({ ok: true, output });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.post('/images/:id/remove', async (req, res) => {
  try {
    const output = await removeImage(requireProfile(profileId(req)), req.params.id);
    res.json({ ok: true, output });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.get('/volumes', async (req, res) => {
  try {
    res.json(await listVolumes(requireProfile(profileId(req))));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.post('/volumes/:name/remove', async (req, res) => {
  try {
    const output = await removeVolume(requireProfile(profileId(req)), req.params.name);
    res.json({ ok: true, output });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.get('/networks', async (req, res) => {
  try {
    res.json(await listNetworks(requireProfile(profileId(req))));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dockerRouter.post('/networks/:name/remove', async (req, res) => {
  try {
    const output = await removeNetwork(requireProfile(profileId(req)), req.params.name);
    res.json({ ok: true, output });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

