import { describe, it, expect, vi } from 'vitest';
import { WorkflowRegistry } from '../server/runtime/registry.js';
import { WorkflowService } from '../server/workflow-service.js';
import { InMemoryHistoryStore, type HistoryStore } from '../server/storage/store.js';

describe('replaceable HistoryStore', () => {
  it('service writes through the injected store implementation', async () => {
    const saved = vi.fn();
    const store: HistoryStore = {
      save: saved,
      get: () => undefined,
      list: () => [],
      delete: () => true,
    };
    const registry = new WorkflowRegistry();
    registry.register(
      'wf',
      'v1',
      `export async function run(ctx){ return await ctx.activity('a', null); }`,
    );
    const service = new WorkflowService(registry, store);
    const summary = await service.run({
      workflowType: 'wf',
      version: 'v1',
      input: null,
      seed: 1,
      activities: { a: { mode: 'succeed' } },
    });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0][0].runId).toBe(summary.runId);
  });

  it('InMemoryHistoryStore supports save/get/list/delete', () => {
    const store = new InMemoryHistoryStore();
    const rec = {
      runId: 'x',
      createdAt: 'now',
      workflowType: 'wf',
      version: 'v1',
      input: null,
      status: 'completed' as const,
      seed: 1,
      history: [],
      determinismViolations: [],
    };
    store.save(rec);
    expect(store.get('x')?.runId).toBe('x');
    expect(store.list()).toHaveLength(1);
    expect(store.delete('x')).toBe(true);
    expect(store.get('x')).toBeUndefined();
    expect(store.delete('missing')).toBe(false);
  });
});
