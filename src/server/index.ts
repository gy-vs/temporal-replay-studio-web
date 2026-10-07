import express from 'express';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRegistry } from './bootstrap.js';
import { WorkflowService } from './workflow-service.js';
import { InMemoryHistoryStore } from './storage/store.js';
import { seedDemos } from './seed.js';
import { webDistDir } from './paths.js';

export async function createApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const registry = createRegistry();
  const service = new WorkflowService(registry, new InMemoryHistoryStore());
  await seedDemos(service);

  app.get('/api/workflows', (_req, res) => {
    res.json(registry.list());
  });

  app.get('/api/runs', (_req, res) => {
    res.json(service.listRuns());
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = service.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: `找不到运行 ${req.params.id}` });
      return;
    }
    res.json(run);
  });

  app.post('/api/runs', async (req, res) => {
    try {
      const summary = await service.run(req.body);
      res.status(201).json(summary);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post('/api/runs/:id/replay', async (req, res) => {
    try {
      const version = String(req.body?.version ?? '');
      if (!version) {
        res.status(400).json({ error: '缺少重放目标版本 version' });
        return;
      }
      const report = await service.replay(req.params.id, version);
      res.json(report);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Serve the built UI in production.
  const distDir = webDistDir();
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')));
  }

  return app;
}

function isMainModule(): boolean {
  // Set by the esbuild CJS banner in production; ESM dev compares import.meta.
  if ((globalThis as { __TRS_MAIN__?: boolean }).__TRS_MAIN__) return true;
  return (
    !!process.argv[1] &&
    (import.meta as { url?: string }).url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  const port = Number(process.env.PORT ?? 3001);
  createApp().then((app) => {
    app.listen(port, () => {
      console.log(`Temporal Replay Studio server: http://localhost:${port}`);
    });
  });
}
