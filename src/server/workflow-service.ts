import { randomUUID } from 'node:crypto';
import { WorkflowMachine, type MachineResult } from './runtime/machine.js';
import { LiveHost } from './runtime/live-host.js';
import { ReplayHost } from './runtime/replay-host.js';
import type { RealmTraps } from './runtime/realm.js';
import { createRng, randomSeed } from './runtime/rng.js';
import { WorkflowRegistry } from './runtime/registry.js';
import { validateHistory } from './runtime/history-validator.js';
import type { HistoryStore, RunRecord } from './storage/store.js';
import type {
  HistoryEvent,
  ReplayNote,
  ReplayReport,
  RunRequest,
  RunSummary,
} from '../shared/types.js';

function mergeNotes(a: ReplayNote[], b: ReplayNote[]): ReplayNote[] {
  const seen = new Set(a.map((n) => `${n.seq}:${n.kind}`));
  const merged = [...a];
  for (const n of b) {
    const key = `${n.seq}:${n.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(n);
    }
  }
  return merged.sort((x, y) => x.seq - y.seq);
}

/** Stable trap handle whose target machine is wired in after construction
 *  (machine -> traps -> compiled fn -> machine is a compile-time cycle). */
function trapHandle(): { traps: RealmTraps; bind(m: WorkflowMachine): void } {
  let target: WorkflowMachine | null = null;
  return {
    traps: {
      onNow: (kind) => target!.trapNow(kind),
      onRandom: () => target!.trapRandom(),
    },
    bind: (m) => {
      target = m;
    },
  };
}

export class WorkflowService {
  constructor(
    private registry: WorkflowRegistry,
    private store: HistoryStore,
  ) {}

  async run(req: RunRequest): Promise<RunSummary> {
    const wv = this.registry.get(req.workflowType, req.version);
    const seed = req.seed ?? randomSeed();
    const handle = trapHandle();
    const fn = this.registry.resolveFn(wv, handle.traps);

    const machine = new WorkflowMachine({
      workflowType: req.workflowType,
      version: req.version,
      input: req.input ?? null,
      fn,
      host: new LiveHost(req.activities ?? {}),
      rng: createRng(seed),
    });
    handle.bind(machine);

    const result = await machine.run();
    const runId = req.runId ?? randomUUID();

    const record: RunRecord = {
      runId,
      createdAt: new Date().toISOString(),
      workflowType: req.workflowType,
      version: req.version,
      input: req.input ?? null,
      status: result.status,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error ? { error: result.error } : {}),
      seed,
      history: result.history,
      determinismViolations: result.violations,
    };
    this.store.save(record);
    return this.toSummary(record);
  }

  async replay(runId: string, targetVersion: string): Promise<ReplayReport> {
    const record = this.store.get(runId);
    if (!record) throw new Error(`找不到运行记录：${runId}`);
    const wv = this.registry.get(record.workflowType, targetVersion);

    const corruption = validateHistory(record.history);
    if (corruption.length > 0) {
      return {
        status: 'corrupt',
        workflowType: record.workflowType,
        replayedWithVersion: targetVersion,
        matches: [],
        divergence: null,
        corruption,
        notes: [],
        determinismViolations: [],
      };
    }

    const host = new ReplayHost(record.history as HistoryEvent[]);
    const handle = trapHandle();
    const fn = this.registry.resolveFn(wv, handle.traps);
    const machine = new WorkflowMachine({
      workflowType: record.workflowType,
      version: targetVersion,
      input: record.input,
      fn,
      host,
      rng: createRng(0),
    });
    handle.bind(machine);

    const result: MachineResult = await machine.run();
    // Notes the host collected internally (e.g. version backfill) merge with
    // ones the machine forwarded as it decided to drop terminals.
    const notes = mergeNotes(result.notes, host.notes);

    const violations = result.violations.map((v) => ({ kind: v.kind, message: v.message }));
    if (result.divergence) {
      return {
        status: 'diverges',
        workflowType: record.workflowType,
        replayedWithVersion: targetVersion,
        matches: result.matches,
        divergence: result.divergence,
        corruption: [],
        notes,
        determinismViolations: violations,
      };
    }

    return {
      status: 'matches',
      workflowType: record.workflowType,
      replayedWithVersion: targetVersion,
      matches: result.matches,
      divergence: null,
      corruption: [],
      notes,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error ? { error: result.error } : {}),
      determinismViolations: violations,
    };
  }

  private toSummary(r: RunRecord): RunSummary {
    return {
      runId: r.runId,
      workflowType: r.workflowType,
      version: r.version,
      input: r.input,
      status: r.status,
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(r.error ? { error: r.error } : {}),
      eventCount: r.history.length,
      history: r.history,
      determinismViolations: r.determinismViolations.map((v) => ({ kind: v.kind, message: v.message })),
      seed: r.seed,
    };
  }

  listRuns(): RunSummary[] {
    return this.store.list().map((r) => this.toSummary(r));
  }

  getRun(runId: string): RunSummary | undefined {
    const r = this.store.get(runId);
    return r ? this.toSummary(r) : undefined;
  }
}
