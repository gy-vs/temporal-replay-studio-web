import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp, createContext } from './app';

const port = Number(process.env.PORT ?? 3000);
const app = createApp(createContext());
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '../..');

if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(projectRoot, 'dist');
  app.use(express.static(distDir));
  app.get('*', (_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'));
  });
}

async function start(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      root: projectRoot,
      appType: 'custom',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, () => {
    console.log(`Temporal Replay Studio listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
