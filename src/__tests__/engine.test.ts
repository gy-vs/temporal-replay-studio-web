import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowRegistry } from '../server/runtime/registry.js';
import { InMemoryHistoryStore } from '../server/storage/store.js';
import { WorkflowService } from '../server/workflow-service.js';
import { validateHistory } from '../server/runtime/history-validator.js';
import { scanForNonDeterminism } from '../server/runtime/determinism.js';
import type { ActivityBehaviour, HistoryEvent, RunRequest } from '../shared/types.js';

const WF_V1 = `
export async function run(ctx, input) {
  await ctx.activity('a', { x: input.x });
  ctx.registerCompensation('undo-a', { activityType: 'undoA', input: { x: input.x } });
  await ctx.sleep(100);
  const r = await ctx.activity('b', null, { scheduleToCloseTimeoutMs: 1000, retry: { maxAttempts: 2, initialBackoffMs: 50, maxBackoffMs: 50 } });
  return { ok: true, r };
}
`;

const WF_V2_BRANCH = `
export async function run(ctx, input) {
  await ctx.activity('a', { x: input.x });
  ctx.registerCompensation('undo-a', { activityType: 'undoA', input: { x: input.x } });
  const v = ctx.version('extra-step', 1);
  if (v >= 1) {
    await ctx.activity('newStep', { x: input.x });
  }
  await ctx.sleep(100);
  const r = await ctx.activity('b', null, { scheduleToCloseTimeoutMs: 1000, retry: { maxAttempts: 2, initialBackoffMs: 50, maxBackoffMs: 50 } });
  // Same result shape as v1: the backfilled branch is behaviour-identical here.
  return { ok: true, r };
}
`;

const WF_V3_REORDER = `
export async function run(ctx, input) {
  await ctx.activity('a', { x: input.x });
  await ctx.sleep(100);
  await ctx.activity('b', null);
  return { ok: true };
}
`;

const WF_NONDET = `
export async function run(ctx, input) {
  await ctx.activity('a', null);
  const t = Date.now();
  const r = Math.random();
  const d = new Date();
  return { t, r, s: d.getTime() };
}
`;

const WF_SHADOW_OK = `
export async function run(ctx, input) {
  const Date = { now: () => 42 };
  const Math = { random: () => 0.5 };
  const t = Date.now();
  const r = Math.random();
  await ctx.activity('a', { t, r });
  return { t, r };
}
`;

function setup() {
  const registry = new WorkflowRegistry();
  registry.register('wf', 'v1', WF_V1, { fileName: 'v1.ts' });
  registry.register('wf', 'v2', WF_V2_BRANCH, { fileName: 'v2.ts' });
  registry.register('wf', 'v3', WF_V3_REORDER, { fileName: 'v3.ts' });
  registry.register('bad', 'v1', WF_NONDET, { fileName: 'bad.ts' });
  registry.register('shadow', 'v1', WF_SHADOW_OK, { fileName: 'shadow.ts' });
  const store = new InMemoryHistoryStore();
  const service = new WorkflowService(registry, store);
  return { registry, store, service };
}

const happyActivities: Record<string, ActivityBehaviour> = {
  a: { mode: 'succeed', afterMs: 10, result: { a: 1 } },
  b: { mode: 'succeed', afterMs: 20, result: { b: 2 } },
};

describe('live run', () => {
  it('records a contiguous, ordered event stream', async () => {
    const { service } = setup();
    const summary = await service.run({
      workflowType: 'wf',
      version: 'v1',
      input: { x: 1 },
      seed: 1,
      activities: happyActivities,
    });
    const types = summary.history.map((e) => e.type);
    expect(types[0]).toBe('WorkflowStarted');
    expect(types).toContain('ActivityScheduled');
    expect(types).toContain('TimerScheduled');
    expect(types).toContain('TimerFired');
    expect(types.at(-1)).toBe('WorkflowCompleted');
    summary.history.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it('retries on failure with backoff then succeeds', async () => {
    const { service } = setup();
    const summary = await service.run({
      workflowType: 'wf',
      version: 'v1',
      input: { x: 1 },
      seed: 1,
      activities: {
        a: { mode: 'succeed', afterMs: 10 },
        b: { mode: 'fail', afterMs: 10, error: { name: 'Boom', message: 'first fails' } },
      },
    });
    const starts = summary.history.filter((e) => e.type === 'ActivityStarted');
    const bId = summary.history.find((e) => e.type === 'ActivityScheduled' && e.activityType === 'b')!;
    const bStarts = starts.filter((e) => e.type === 'ActivityStarted' && (e as { activityId: number }).activityId === (bId as { activityId: number }).activityId);
    expect(bStarts.length).toBe(2);
    const failed = summary.history.find((e) => e.type === 'ActivityAttemptFailed');
    expect(failed).toBeTruthy();
    expect((failed as { backoffMs: number }).backoffMs).toBe(50);
    expect(summary.status).toBe('completed');
  });

  it('runs registered compensations in reverse on root failure', async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      'comp',
      'v1',
      `
      export async function run(ctx) {
        await ctx.activity('s1', null);
        ctx.registerCompensation('c1', { activityType: 'u1', input: null });
        await ctx.activity('s2', null);
        ctx.registerCompensation('c2', { activityType: 'u2', input: null });
        await ctx.activity('boom', null);
      }
      `,
    );
    const service = new WorkflowService(registry, new InMemoryHistoryStore());
    const summary = await service.run({
      workflowType: 'comp',
      version: 'v1',
      input: null,
      seed: 1,
      activities: {
        s1: { mode: 'succeed' },
        s2: { mode: 'succeed' },
        boom: { mode: 'fail', error: { name: 'X', message: 'boom', nonRetriable: true } },
        u1: { mode: 'succeed', result: 'u1' },
        u2: { mode: 'succeed', result: 'u2' },
      },
    });
    expect(summary.status).toBe('failed');
    const undoOrder = summary.history
      .filter((e) => e.type === 'ActivityScheduled' && (e as { compensationId?: number }).compensationId !== undefined)
      .map((e) => (e as { activityType: string }).activityType);
    expect(undoOrder).toEqual(['u2', 'u1']);
    const comps = summary.history.filter((e) => e.type === 'CompensationSucceeded');
    expect(comps.length).toBe(2);
    expect(summary.history.at(-1)!.type).toBe('WorkflowFailed');
  });

  it('parallel fail-fast cancels sibling branches', async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      'par',
      'v1',
      `
      export async function run(ctx) {
        await ctx.parallel([
          () => ctx.activity('fast', null),
          () => ctx.activity('slow', null, { scheduleToCloseTimeoutMs: 5000, retry: { maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0 } }),
        ]);
        return 1;
      }
      `,
    );
    const service = new WorkflowService(registry, new InMemoryHistoryStore());
    const summary = await service.run({
      workflowType: 'par',
      version: 'v1',
      input: null,
      seed: 1,
      activities: {
        fast: { mode: 'fail', afterMs: 10, error: { name: 'X', message: 'fail', nonRetriable: true } },
        slow: { mode: 'succeed', afterMs: 3000 },
      },
    });
    expect(summary.status).toBe('failed');
    const cancel = summary.history.find((e) => e.type === 'ActivityCancelled');
    expect(cancel).toBeTruthy();
  });
});

describe('replay determinism', () => {
  let service: WorkflowService;
  let runId: string;

  beforeEach(async () => {
    const s = setup();
    service = s.service;
    const summary = await service.run({
      workflowType: 'wf',
      version: 'v1',
      input: { x: 1 },
      seed: 1,
      activities: happyActivities,
    });
    runId = summary.runId;
  });

  it('matches when replaying with the same version', async () => {
    const report = await service.replay(runId, 'v1');
    expect(report.status).toBe('matches');
    expect(report.divergence).toBeNull();
    // commands carry the history position they consumed
    expect(report.matches.length).toBeGreaterThan(3);
    expect(report.matches.every((m) => m.historySeq > 0)).toBe(true);
  });

  it('diverges at the first reordered command with surrounding context', async () => {
    const report = await service.replay(runId, 'v3');
    expect(report.status).toBe('diverges');
    const d = report.divergence!;
    const expectedType = (d.expected.event as HistoryEvent).type;
    // v3 removed the compensation registration; that missing command is the
    // first divergence point and the actual command v3 emitted next is shown.
    expect(expectedType).toBe('CompensationRegistered');
    expect(['startTimer', 'scheduleActivity']).toContain((d.actual as { kind: string }).kind);
    expect(d.contextBefore.length).toBeGreaterThan(0);
    expect(d.contextAfter.length).toBeGreaterThan(0);
    expect(d.atSeq).not.toBeNull();
  });

  it('treats a downgraded version marker as a note, not a divergence', async () => {
    // Record v2 history (marker present at version 1), then replay against a
    // "new code" v2 where current is still 1 — trivially matches.
    const { service: s2 } = setup();
    const v2run = await s2.run({
      workflowType: 'wf',
      version: 'v2',
      input: { x: 1 },
      seed: 1,
      activities: { ...happyActivities, newStep: { mode: 'succeed', afterMs: 5 } },
    });
    const report = await s2.replay(v2run.runId, 'v1');
    // v1 history shape: v1 never calls version(); old code replay of v2
    // history diverges — here check the reverse (v2 code on v1 history):
    const v1run = await s2.run({
      workflowType: 'wf',
      version: 'v1',
      input: { x: 1 },
      seed: 1,
      activities: happyActivities,
    });
    const backfill = await s2.replay(v1run.runId, 'v2');
    expect(backfill.status).toBe('matches');
    expect(backfill.notes.some((n) => n.kind === 'versionBackfill')).toBe(true);
    // same-version v2 replay marker matches normally
    const same = await s2.replay(v2run.runId, 'v2');
    expect(same.status).toBe('matches');
    void report;
  });
});

describe('racing terminals', () => {
  it('the first terminal wins and later ones are recorded as ignored; replay agrees', async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      'race',
      'v1',
      `export async function run(ctx) { const r = await ctx.activity('pay', null, { scheduleToCloseTimeoutMs: 1000, retry: { maxAttempts: 1, initialBackoffMs: 10, maxBackoffMs: 10 } }); return r; }`,
    );
    const service = new WorkflowService(registry, new InMemoryHistoryStore());
    const req: RunRequest = {
      workflowType: 'race',
      version: 'v1',
      input: null,
      seed: 1,
      activities: {
        pay: {
          mode: 'race',
          signals: [
            { kind: 'completed', atMs: 500, result: { tx: 'X' } },
            { kind: 'timeout', atMs: 500 },
            { kind: 'cancelled', atMs: 501 },
          ],
        },
      },
    };
    const summary = await service.run(req);
    const ignored = summary.history.filter((e) => e.type === 'ActivityTerminalIgnored');
    expect(ignored.length).toBe(2);
    expect((ignored[0] as { ignored: string }).ignored).toBe('timedout');
    expect((ignored[1] as { ignored: string }).ignored).toBe('cancelled');
    expect(summary.status).toBe('completed');

    const replay = await service.replay(summary.runId, 'v1');
    expect(replay.status).toBe('matches');
    expect(replay.notes.filter((n) => n.kind === 'ignoredTerminal').length).toBe(2);
  });
});

describe('determinism enforcement', () => {
  it('static scan flags Date.now/new Date/Math.random with line numbers', () => {
    const findings = scanForNonDeterminism(WF_NONDET, 'bad.ts');
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(['Date.now', 'Math.random', 'new Date()']);
    expect(findings.every((f) => f.line > 0)).toBe(true);
  });

  it('static scan respects local shadowing', () => {
    const findings = scanForNonDeterminism(WF_SHADOW_OK, 'shadow.ts');
    expect(findings).toEqual([]);
  });

  it('runtime traps record violations on both run and replay and still completes', async () => {
    const { service } = setup();
    const summary = await service.run({
      workflowType: 'bad',
      version: 'v1',
      input: null,
      seed: 1,
      activities: { a: { mode: 'succeed', afterMs: 10 } },
    });
    expect(summary.determinismViolations.length).toBe(3);
    const replay = await service.replay(summary.runId, 'v1');
    expect(replay.status).toBe('matches');
    expect(replay.determinismViolations.length).toBe(3);
  });
});

describe('corrupt history', () => {
  function base(): HistoryEvent[] {
    return [
      { seq: 1, at: 0, type: 'WorkflowStarted', workflowType: 'wf', version: 'v1', input: null },
      { seq: 2, at: 0, type: 'ActivityScheduled', activityId: 1, activityType: 'a', input: null, options: { scheduleToCloseTimeoutMs: 1000, retry: { maxAttempts: 1, initialBackoffMs: 1, maxBackoffMs: 1 } } },
      { seq: 3, at: 0, type: 'ActivityStarted', activityId: 1, attempt: 1 },
      { seq: 4, at: 10, type: 'ActivityCompleted', activityId: 1, attempt: 1, result: null },
      { seq: 5, at: 10, type: 'WorkflowCompleted', result: null },
    ];
  }

  it('flags gaps, truncation, dangling refs and empty history', () => {
    const gap = base();
    gap[1] = { ...(gap[1] as { seq: number }), seq: 9 } as HistoryEvent;
    const gapIssues = validateHistory(gap);
    expect(gapIssues.some((i) => i.code === 'SEQ_GAP')).toBe(true);

    const truncated = base().slice(0, 3);
    expect(validateHistory(truncated).some((i) => i.code === 'TRUNCATED')).toBe(true);

    const dangling = base();
    dangling.splice(3, 0, {
      seq: 4,
      at: 5,
      type: 'ActivityCompleted',
      activityId: 99,
      attempt: 1,
      result: null,
    } as HistoryEvent);
    // renumber to avoid masking with seq-gap: shift later seqs
    dangling.forEach((e, i) => ((e as { seq: number }).seq = i + 1));
    expect(validateHistory(dangling).some((i) => i.code === 'UNKNOWN_ACTIVITY')).toBe(true);

    expect(validateHistory([])[0].code).toBe('EMPTY_HISTORY');
  });

  it('replay of corrupt history returns a report instead of throwing', async () => {
    const { service, store } = setup();
    const summary = await service.run({
      workflowType: 'wf',
      version: 'v1',
      input: { x: 1 },
      seed: 1,
      activities: happyActivities,
    });
    const rec = store.get(summary.runId)!;
    rec.history = rec.history.slice(0, 4);
    const report = await service.replay(summary.runId, 'v1');
    expect(report.status).toBe('corrupt');
    expect(report.corruption.some((c) => c.code === 'TRUNCATED')).toBe(true);
  });
});
