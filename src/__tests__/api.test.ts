import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../server/index.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = await createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => server.close());

describe('HTTP API', () => {
  it('lists seeded runs and replays without crashing', async () => {
    const res = await fetch(`${base}/api/runs`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as { runId: string }[];
    expect(runs.length).toBeGreaterThan(0);

    const replayRes = await fetch(`${base}/api/runs/${runs[0].runId}/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v1' }),
    });
    expect([200]).toContain(replayRes.status);
    const body = (await replayRes.json()) as { status: string };
    expect(['matches', 'diverges', 'corrupt']).toContain(body.status);
  });

  it('rejects an unknown run with 400', async () => {
    const res = await fetch(`${base}/api/runs/nope/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v1' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires a version field', async () => {
    const runs = (await (await fetch(`${base}/api/runs`)).json()) as { runId: string }[];
    const res = await fetch(`${base}/api/runs/${runs[0].runId}/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
