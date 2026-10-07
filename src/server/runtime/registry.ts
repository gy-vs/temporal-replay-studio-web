import { scanForNonDeterminism, type DeterminismFinding } from './determinism.js';
import { compileWorkflowModule, type CompiledModule } from './realm.js';
import type {
  ActivityOptions,
  ErrorPayload,
  JSONValue,
  RunRequest,
} from '../../shared/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../../shared/types.js';

export interface WorkflowVersion {
  version: string;
  source: string;
  fileName: string;
  exportName: string;
  findings: DeterminismFinding[];
  /** Lazily compiled per trap-set (traps differ per run; compile is cached). */
  compile: (traps: import('./realm.js').RealmTraps) => CompiledModule;
}

export interface WorkflowEntry {
  type: string;
  versions: Map<string, WorkflowVersion>;
}

/** Shape of the workflow function the sandbox module must export. */
export type WorkflowFn<In = JSONValue, Out = JSONValue> = (
  ctx: WorkflowContext,
  input: In,
) => Promise<Out> | Out;

export interface Compensation {
  activityType: string;
  input: JSONValue;
  options?: Partial<ActivityOptions>;
}

export interface WorkflowContext {
  now(): number;
  newDate(): Date;
  random(): number;
  sleep(durationMs: number): Promise<void>;
  activity(
    type: string,
    input?: JSONValue,
    options?: Partial<ActivityOptions>,
  ): Promise<JSONValue>;
  parallel(thunks: (() => Promise<unknown>)[]): Promise<unknown[]>;
  registerCompensation(label: string, undo: Compensation): void;
  /**
   * Explicit version marker. Replays return the value recorded in history,
   * so histories carrying the old marker keep taking the old branch — never
   * reported as a divergence.
   */
  version(changeId: string, current: number): number;
  failWorkflow(message: string, opts?: { name?: string; nonRetriable?: boolean }): never;
}

export class WorkflowRegistry {
  private entries = new Map<string, WorkflowEntry>();

  register(
    type: string,
    version: string,
    source: string,
    opts: { fileName?: string; exportName?: string } = {},
  ): WorkflowVersion {
    const fileName = opts.fileName ?? `${type}-${version}.ts`;
    const exportName = opts.exportName ?? 'run';
    const findings = scanForNonDeterminism(source, fileName);

    let cached: { traps: import('./realm.js').RealmTraps; module: CompiledModule } | null = null;
    const compile = (traps: import('./realm.js').RealmTraps) => {
      if (cached && cached.traps === traps) return cached.module;
      const module = compileWorkflowModule(source, fileName, traps);
      cached = { traps, module };
      return module;
    };

    const wv: WorkflowVersion = { version, source, fileName, exportName, findings, compile };
    let entry = this.entries.get(type);
    if (!entry) {
      entry = { type, versions: new Map() };
      this.entries.set(type, entry);
    }
    entry.versions.set(version, wv);
    return wv;
  }

  get(type: string, version: string): WorkflowVersion {
    const v = this.entries.get(type)?.versions.get(version);
    if (!v) throw new Error(`工作流未注册：${type}@${version}`);
    return v;
  }

  list(): { type: string; versions: string[]; findings: Record<string, DeterminismFinding[]> }[] {
    return [...this.entries.values()].map((e) => ({
      type: e.type,
      versions: [...e.versions.keys()],
      findings: Object.fromEntries(
        [...e.versions.values()].map((v) => [v.version, v.findings]),
      ),
    }));
  }

  resolveFn(wv: WorkflowVersion, traps: import('./realm.js').RealmTraps): WorkflowFn {
    const mod = wv.compile(traps);
    const fn = mod.exports[wv.exportName];
    if (typeof fn !== 'function') {
      throw new Error(`${wv.fileName} 没有导出名为 "${wv.exportName}" 的函数`);
    }
    return fn as WorkflowFn;
  }
}

export function normalizeOptions(o?: Partial<ActivityOptions>): ActivityOptions {
  return {
    scheduleToCloseTimeoutMs: o?.scheduleToCloseTimeoutMs ?? DEFAULT_ACTIVITY_OPTIONS.scheduleToCloseTimeoutMs,
    retry: {
      maxAttempts: o?.retry?.maxAttempts ?? DEFAULT_ACTIVITY_OPTIONS.retry.maxAttempts,
      initialBackoffMs: o?.retry?.initialBackoffMs ?? DEFAULT_ACTIVITY_OPTIONS.retry.initialBackoffMs,
      maxBackoffMs: o?.retry?.maxBackoffMs ?? DEFAULT_ACTIVITY_OPTIONS.retry.maxBackoffMs,
    },
  };
}

export function toErrorPayload(e: unknown): ErrorPayload {
  if (e && typeof e === 'object' && 'message' in e) {
    const err = e as { name?: string; message?: string; nonRetriable?: boolean };
    return {
      name: err.name ?? 'Error',
      message: String(err.message ?? '未知错误'),
      ...(err.nonRetriable ? { nonRetriable: true } : {}),
    };
  }
  return { name: 'Error', message: String(e) };
}

/** Thrown into pending awaits when a parallel branch / root fails. */
export class CancelledError extends Error {
  constructor(message = '工作流分支失败，其余待执行活动被取消') {
    super(message);
    this.name = 'CancelledError';
  }
}

export type { RunRequest };
