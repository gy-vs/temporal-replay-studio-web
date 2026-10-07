import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CancelledError,
  normalizeOptions,
  type Compensation,
  type WorkflowContext,
  type WorkflowFn,
} from './registry.js';
import type {
  ActivityAttemptFailedEvent,
  ActivityCancelledEvent,
  ActivityCompletedEvent,
  ActivityOptions,
  ActivityScheduledEvent,
  ActivityStartedEvent,
  ActivityTerminalIgnoredEvent,
  ActivityTimedOutEvent,
  Command,
  CommandMatch,
  CompensationFailedEvent,
  CompensationRegisteredEvent,
  CompensationSucceededEvent,
  DeterminismViolationEvent,
  Divergence,
  ErrorPayload,
  HistoryEvent,
  JSONValue,
  NowSampledEvent,
  RandomConsumedEvent,
  ReplayNote,
  TimerCancelledEvent,
  TimerFiredEvent,
  TimerScheduledEvent,
  VersionMarkerEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
} from '../../shared/types.js';

type ActivityTerminalEvent =
  | ActivityCompletedEvent
  | ActivityTimedOutEvent
  | ActivityCancelledEvent
  | ActivityAttemptFailedEvent;

export interface QueuedSignal {
  at: number;
  kind: 'completed' | 'failed' | 'timeout' | 'cancelled';
  result?: JSONValue;
  error?: ErrorPayload;
}

interface AttemptState {
  attempt: number;
  startedAt: number;
  signals: QueuedSignal[];
  /** True once the FIRST terminal signal has been consumed. */
  terminalConsumed: boolean;
  /** The event that finally settles the attempt (if any). */
  terminalEvent?: ActivityTerminalEvent;
  /** A failed attempt that is followed by a retry. */
  failure?: ActivityAttemptFailedEvent;
  deadline: number;
}

export interface PendingActivity {
  kind: 'activity';
  id: number;
  type: string;
  options: ActivityOptions;
  compensationOf?: number;
  compensationId?: number;
  attempts: AttemptState[];
  deferred: Deferred<JSONValue>;
  scopeId: number | null;
  settled: boolean;
}

export interface PendingTimer {
  kind: 'timer';
  id: number;
  durationMs: number;
  fireAt: number;
  deferred: Deferred<void>;
  scopeId: number | null;
  settled: boolean;
}

type Pending = PendingActivity | PendingTimer;

interface HeapEntry {
  at: number;
  seq: number;
  kind: 'signal' | 'retry' | 'timerFire';
  activity?: PendingActivity;
  attemptNo?: number;
  signalIndex?: number;
  timer?: PendingTimer;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

/**
 * Payload fields compared between a freshly emitted event and history.
 * `seq` and `at` are intentionally excluded — replay drives the clock from
 * history, and identity is carried by the ids that ARE listed.
 */
const COMPARABLE_KEYS: Record<string, string[]> = {
  WorkflowStarted: ['workflowType', 'input'],
  WorkflowCompleted: ['result'],
  WorkflowFailed: ['error'],
  ActivityScheduled: ['activityId', 'activityType', 'input', 'options', 'compensationOf', 'compensationId'],
  ActivityStarted: ['activityId', 'attempt'],
  ActivityAttemptFailed: ['activityId', 'attempt', 'kind', 'error', 'backoffMs'],
  ActivityCompleted: ['activityId', 'attempt', 'result'],
  ActivityTimedOut: ['activityId', 'attempt', 'error'],
  ActivityCancelled: ['activityId', 'attempt', 'error'],
  ActivityTerminalIgnored: ['activityId', 'attempt', 'ignored'],
  TimerScheduled: ['timerId', 'durationMs'],
  TimerFired: ['timerId'],
  TimerCancelled: ['timerId'],
  CompensationRegistered: ['compensationId', 'afterActivitySeq', 'label'],
  CompensationSucceeded: ['compensationId'],
  CompensationFailed: ['compensationId', 'error'],
  VersionMarker: ['changeId'],
  RandomConsumed: ['value'],
  NowSampled: ['nowMs'],
  DeterminismViolation: ['kind', 'message'],
};

export function eventsEquivalent(a: HistoryEvent, b: HistoryEvent): boolean {
  if (a.type !== b.type) return false;
  const keys = COMPARABLE_KEYS[a.type] ?? [];
  return keys.every((k) =>
    deepEqual(
      (a as unknown as Record<string, unknown>)[k],
      (b as unknown as Record<string, unknown>)[k],
    ),
  );
}

// ---------------------------------------------------------------------------
// Host abstraction — the only part that differs between live run and replay
// ---------------------------------------------------------------------------

export interface CommandResponse {
  divergence?: Divergence;
  /** Do not append the event / consume a history position (version backfill). */
  skip?: boolean;
  /** Replay may rewrite the value the workflow code receives (history value). */
  versionValue?: number;
  randomValue?: number;
}

export interface MachineHost {
  mode: 'live' | 'replay';
  onCommand(ev: HistoryEvent, command: Command): CommandResponse;
  onRuntimeEvent(ev: HistoryEvent): CommandResponse;
  onActivityScheduled(ev: ActivityScheduledEvent, p: PendingActivity): void;
  signalsForAttempt(p: PendingActivity, attemptNo: number): QueuedSignal[];
  /** Backoff to record; replay reads the historical value. */
  backoffAfterFailure(p: PendingActivity, attemptNo: number, computed: number): number;
  /**
   * Workflow code failed and an in-flight activity must be cancelled.
   * Live: enqueue a cancel signal now. Replay: no-op — the cancel (and any
   * rival terminals) are already part of the reconstructed signal list.
   */
  queueCancel(p: PendingActivity, attemptNo: number, at: number, queue: (sig: QueuedSignal) => void): void;
  onFinished(): CommandResponse;
  note(n: ReplayNote): void;
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export interface MachineResult {
  history: HistoryEvent[];
  status: 'completed' | 'failed';
  result?: JSONValue;
  error?: ErrorPayload;
  matches: CommandMatch[];
  divergence: Divergence | null;
  notes: ReplayNote[];
  violations: DeterminismViolationEvent[];
}

export class DivergenceError extends Error {
  constructor(public divergence: Divergence) {
    super(divergence.message);
    this.name = 'DivergenceError';
  }
}

export interface MachineConfig {
  workflowType: string;
  version: string;
  input: JSONValue;
  fn: WorkflowFn;
  host: MachineHost;
  rng: () => number;
}

function payloadOf(e: unknown): ErrorPayload {
  const p = (e as { __payload?: ErrorPayload })?.__payload;
  if (p) return p;
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: 'Error', message: String(e) };
}

export class WorkflowMachine {
  history: HistoryEvent[] = [];
  private seq = 0;
  private clock = 0;
  private nextActivityId = 1;
  private nextTimerId = 1;
  private nextCompensationId = 1;
  private pending = new Set<Pending>();
  private heap: HeapEntry[] = [];
  private heapSeq = 0;
  private compensations: { id: number; label: string; undo: Compensation; afterActivitySeq: number }[] = [];
  private compensationQueue: number[] = [];
  private result: MachineResult;
  private phase: 'running' | 'cancelling' | 'compensating' | 'tail' | 'finished' = 'running';
  private scopeAls = new AsyncLocalStorage<number>();
  private nextScopeId = 1;
  private rootError: unknown;
  /** Effective value returned by the most recent ctx.version() call. */
  private lastVersionResult = 0;
  /** Set when a divergence is recorded; the event loop must stop immediately. */
  private aborted = false;

  constructor(private cfg: MachineConfig) {
    this.result = {
      history: this.history,
      status: 'completed',
      matches: [],
      divergence: null,
      notes: [],
      violations: [],
    };
  }

  // ---- event emission ----------------------------------------------------

  private makeEvent<E extends HistoryEvent>(partial: Omit<E, 'seq' | 'at'>): E {
    return { seq: ++this.seq, at: this.clock, ...(partial as object) } as E;
  }

  private note(n: ReplayNote) {
    this.result.notes.push(n);
    this.cfg.host.note(n);
  }

  private failWithDivergence(d: Divergence): never {
    this.result.divergence = d;
    this.result.history = [...this.history];
    this.aborted = true;
    throw new DivergenceError(d);
  }

  private emitCommand(command: Command): HistoryEvent | null {
    // Ask the host BEFORE committing: replay backfills skip the event
    // entirely. The preview gets a real seq (counters roll back on skip) so
    // the host can still position itself in history.
    const preview = this.commandToEvent(command);
    const resp = this.cfg.host.onCommand(preview, command);
    if (resp.divergence) this.failWithDivergence(resp.divergence);
    if (resp.skip) {
      this.rollbackPreview(command);
      this.lastVersionResult = resp.versionValue ?? 0;
      return null;
    }
    // Committed: preview is the real event.
    const ev = preview;
    if (command.kind === 'version' && resp.versionValue !== undefined) {
      (ev as VersionMarkerEvent).version = resp.versionValue;
      command = { ...command, version: resp.versionValue };
    }
    if (command.kind === 'random' && resp.randomValue !== undefined) {
      (ev as RandomConsumedEvent).value = resp.randomValue;
      command = { ...command, value: resp.randomValue };
    }
    this.history.push(ev);
    this.result.matches.push({ historySeq: ev.seq, command });
    return ev;
  }

  /** Undo seq/id allocation for a command the host decided to skip. */
  private rollbackPreview(command: Command) {
    this.seq--;
    if (command.kind === 'scheduleActivity') this.nextActivityId--;
    if (command.kind === 'startTimer') this.nextTimerId--;
    if (command.kind === 'registerCompensation') this.nextCompensationId--;
  }

  private emitRuntime(ev: HistoryEvent) {
    const resp = this.cfg.host.onRuntimeEvent(ev);
    if (resp.divergence) this.failWithDivergence(resp.divergence);
    this.history.push(ev);
  }

  private commandToEvent(command: Command): HistoryEvent {
    switch (command.kind) {
      case 'startWorkflow':
        return this.makeEvent<WorkflowStartedEvent>({
          type: 'WorkflowStarted',
          workflowType: command.workflowType,
          version: command.version,
          input: command.input,
        });
      case 'scheduleActivity':
        return this.makeEvent<ActivityScheduledEvent>({
          type: 'ActivityScheduled',
          activityId: this.nextActivityId++,
          activityType: command.activityType,
          input: command.input,
          options: command.options,
          ...(command.compensationOf !== undefined ? { compensationOf: command.compensationOf } : {}),
          ...(command.compensationId !== undefined ? { compensationId: command.compensationId } : {}),
        });
      case 'startTimer':
        return this.makeEvent<TimerScheduledEvent>({
          type: 'TimerScheduled',
          timerId: this.nextTimerId++,
          durationMs: command.durationMs,
        });
      case 'registerCompensation':
        return this.makeEvent<CompensationRegisteredEvent>({
          type: 'CompensationRegistered',
          compensationId: command.compensationId,
          afterActivitySeq: command.afterActivitySeq,
          label: command.label,
        });
      case 'version':
        return this.makeEvent<VersionMarkerEvent>({
          type: 'VersionMarker',
          changeId: command.changeId,
          version: command.version,
        });
      case 'random':
        return this.makeEvent<RandomConsumedEvent>({ type: 'RandomConsumed', value: command.value ?? this.cfg.rng() });
      case 'now':
        return this.makeEvent<NowSampledEvent>({ type: 'NowSampled', nowMs: this.clock });
      case 'determinismViolation':
        return this.makeEvent<DeterminismViolationEvent>({
          type: 'DeterminismViolation',
          kind: command.violationKind,
          message: command.message,
        });
      case 'completeWorkflow':
        return this.makeEvent<WorkflowCompletedEvent>({ type: 'WorkflowCompleted', result: command.result });
      case 'failWorkflow':
        return this.makeEvent<WorkflowFailedEvent>({ type: 'WorkflowFailed', error: command.error });
    }
  }

  // ---- clock & heap ------------------------------------------------------

  private pushHeap(e: Omit<HeapEntry, 'seq'>) {
    this.heap.push({ ...e, seq: this.heapSeq++ });
  }

  private popHeap(): HeapEntry | null {
    if (this.heap.length === 0) return null;
    let idx = 0;
    for (let i = 1; i < this.heap.length; i++) {
      const a = this.heap[i];
      const b = this.heap[idx];
      if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) idx = i;
    }
    return this.heap.splice(idx, 1)[0];
  }

  // ---- sandbox traps: direct Date/Math usage inside workflow code --------

  /** Invoked from the vm realm when code calls Date.now() / new Date(). */
  trapNow(kind: 'Date.now' | 'new Date()'): number {
    this.emitCommand({ kind: 'now' });
    const ev = this.emitCommand({
      kind: 'determinismViolation',
      violationKind: kind,
      message:
        kind === 'Date.now'
          ? '工作流代码直接调用了 Date.now()，必须改用 ctx.now()（重放时返回历史记录的时间）'
          : '工作流代码直接调用了 new Date()，必须改用 ctx.newDate()（重放时返回历史记录的时间）',
    }) as DeterminismViolationEvent;
    this.result.violations.push(ev);
    return this.clock;
  }

  /** Invoked from the vm realm when code calls Math.random(). */
  trapRandom(): number {
    const ev = this.emitCommand({ kind: 'random', value: this.cfg.rng() }) as RandomConsumedEvent;
    const viol = this.emitCommand({
      kind: 'determinismViolation',
      violationKind: 'Math.random',
      message: '工作流代码直接调用了 Math.random()，必须改用 ctx.random()（重放时返回历史记录的值）',
    }) as DeterminismViolationEvent;
    this.result.violations.push(viol);
    return ev.value;
  }

  // ---- DSL ---------------------------------------------------------------

  private buildCtx(): WorkflowContext {
    const m = this;
    const ctx: WorkflowContext = {
      now() {
        m.emitCommand({ kind: 'now' });
        return m.clock;
      },
      newDate() {
        m.emitCommand({ kind: 'now' });
        return new Date(m.clock);
      },
      random() {
        const ev = m.emitCommand({ kind: 'random', value: m.cfg.rng() }) as RandomConsumedEvent;
        return ev.value;
      },
      sleep(durationMs: number) {
        return m.startTimer(durationMs).deferred.promise;
      },
      activity(type, input, options) {
        return m.scheduleActivity(type, input ?? null, normalizeOptions(options), undefined).deferred.promise;
      },
      parallel(thunks) {
        return m.runParallel(thunks);
      },
      registerCompensation(label, undo) {
        m.registerCompensation(label, undo);
      },
      version(changeId, current) {
        const ev = m.emitCommand({ kind: 'version', changeId, version: current });
        // Backfilled markers produce no event; the observed value is stashed.
        return ev ? (ev as VersionMarkerEvent).version : m.lastVersionResult;
      },
      failWorkflow(message, opts) {
        const error: ErrorPayload = {
          name: opts?.name ?? 'ApplicationFailure',
          message,
          ...(opts?.nonRetriable ? { nonRetriable: true } : {}),
        };
        const e = new Error(message);
        e.name = error.name;
        if (error.nonRetriable) (e as Error & { nonRetriable?: boolean }).nonRetriable = true;
        (e as Error & { __payload?: ErrorPayload }).__payload = error;
        throw e;
      },
    };
    return ctx;
  }

  // ---- activities --------------------------------------------------------

  private scheduleActivity(
    type: string,
    input: JSONValue,
    options: ActivityOptions,
    comp: { id: number; label: string; undo: Compensation; afterActivitySeq: number } | undefined,
  ): PendingActivity {
    const command: Command = comp
      ? {
          kind: 'scheduleActivity',
          activityType: type,
          input,
          options,
          compensationOf: comp.afterActivitySeq,
          compensationId: comp.id,
        }
      : { kind: 'scheduleActivity', activityType: type, input, options };
    const ev = this.emitCommand(command) as ActivityScheduledEvent;

    const p: PendingActivity = {
      kind: 'activity',
      id: ev.activityId,
      type,
      options,
      ...(comp ? { compensationOf: comp.afterActivitySeq, compensationId: comp.id } : {}),
      attempts: [],
      deferred: defer<JSONValue>(),
      scopeId: this.scopeAls.getStore() ?? null,
      settled: false,
    };
    this.cfg.host.onActivityScheduled(ev, p);
    this.pending.add(p);
    this.startAttempt(p, this.clock);
    return p;
  }

  private startAttempt(p: PendingActivity, startedAt: number) {
    this.clock = startedAt;
    const attemptNo = p.attempts.length + 1;
    this.emitRuntime(
      this.makeEvent<ActivityStartedEvent>({ type: 'ActivityStarted', activityId: p.id, attempt: attemptNo }),
    );

    const deadline =
      p.attempts.length === 0
        ? startedAt + p.options.scheduleToCloseTimeoutMs
        : p.attempts[0].deadline;
    // Push state BEFORE asking the host for signals (host reads startedAt).
    const state: AttemptState = { attempt: attemptNo, startedAt, signals: [], terminalConsumed: false, deadline };
    p.attempts.push(state);
    state.signals = this.cfg.host.signalsForAttempt(p, attemptNo);

    state.signals.forEach((sig, i) => {
      this.pushHeap({
        at: Math.max(sig.at, startedAt),
        kind: 'signal',
        activity: p,
        attemptNo,
        signalIndex: i,
      });
    });
  }

  private processSignal(entry: HeapEntry) {
    const p = entry.activity!;
    const state = p.attempts.find((a) => a.attempt === entry.attemptNo)!;
    const sig = state.signals[entry.signalIndex!];
    this.clock = sig.at;

    if (state.terminalConsumed) {
      // First terminal already decided this attempt; drop the late arrival.
      const decided = state.terminalEvent ?? state.failure;
      const ignored = this.makeEvent<ActivityTerminalIgnoredEvent>({
        type: 'ActivityTerminalIgnored',
        activityId: p.id,
        attempt: state.attempt,
        ignored: sig.kind === 'timeout' ? 'timedout' : sig.kind,
        reason: `该活动尝试已在事件 #${decided?.seq ?? '?'}（${decided?.type ?? 'AttemptFailed'}）得到终态结论，后到的 ${sig.kind} 被丢弃`,
      });
      this.emitRuntime(ignored);
      this.note({
        seq: ignored.seq,
        kind: 'ignoredTerminal',
        message: `活动 #${p.id} 尝试 ${state.attempt} 的 ${sig.kind} 晚于终态 ${decided?.type ?? 'AttemptFailed'}（#${decided?.seq ?? '?'}），已丢弃`,
      });
      return;
    }
    state.terminalConsumed = true;

    if (sig.kind === 'completed') {
      const ev = this.makeEvent<ActivityCompletedEvent>({
        type: 'ActivityCompleted',
        activityId: p.id,
        attempt: state.attempt,
        result: sig.result ?? null,
      });
      state.terminalEvent = ev;
      this.emitRuntime(ev);
      this.settleActivity(p, { ok: true, value: ev.result });
      return;
    }

    if (sig.kind === 'cancelled') {
      const ev = this.makeEvent<ActivityCancelledEvent>({
        type: 'ActivityCancelled',
        activityId: p.id,
        attempt: state.attempt,
        error: sig.error ?? { name: 'CancelledError', message: '活动因工作流失败被取消' },
      });
      state.terminalEvent = ev;
      this.emitRuntime(ev);
      this.settleActivity(p, { ok: false, error: ev.error, cancelled: true });
      return;
    }

    // failure / timeout: backoff decides whether another attempt follows.
    const isTimeout = sig.kind === 'timeout';
    const error: ErrorPayload =
      sig.error ??
      (isTimeout
        ? { name: 'TimeoutError', message: `活动 ${p.type} 在 ${p.options.scheduleToCloseTimeoutMs}ms 内未完成` }
        : { name: 'ActivityFailure', message: '活动失败' });
    const canRetry =
      state.attempt < p.options.retry.maxAttempts &&
      !error.nonRetriable &&
      sig.at < state.deadline;
    const computed = canRetry
      ? Math.min(
          p.options.retry.initialBackoffMs * 2 ** (state.attempt - 1),
          p.options.retry.maxBackoffMs,
        )
      : 0;
    const backoffMs = this.cfg.host.backoffAfterFailure(p, state.attempt, computed);

    const failedEv = this.makeEvent<ActivityAttemptFailedEvent>({
      type: 'ActivityAttemptFailed',
      activityId: p.id,
      attempt: state.attempt,
      kind: isTimeout ? 'timeout' : 'failure',
      error,
      backoffMs,
    });
    this.emitRuntime(failedEv);

    if (canRetry && backoffMs > 0 && sig.at + backoffMs <= state.deadline) {
      // The attempt is over (failure won) but the ACTIVITY retries.
      state.failure = failedEv;
      this.pushHeap({ at: sig.at + backoffMs, kind: 'retry', activity: p, attemptNo: state.attempt });
      return;
    }

    if (isTimeout) {
      const timedOut = this.makeEvent<ActivityTimedOutEvent>({
        type: 'ActivityTimedOut',
        activityId: p.id,
        attempt: state.attempt,
        error,
      });
      state.terminalEvent = timedOut;
      this.emitRuntime(timedOut);
      this.settleActivity(p, { ok: false, error, cancelled: false });
    } else {
      // A plain (non-retried) failure is itself the terminal outcome. The
      // AttemptFailed event already recorded it — just settle the promise.
      state.terminalEvent = failedEv;
      this.settleActivity(p, { ok: false, error, cancelled: false });
    }
  }

  private settleActivity(
    p: PendingActivity,
    r: { ok: true; value: JSONValue } | { ok: false; error: ErrorPayload; cancelled: boolean },
  ) {
    p.settled = true;
    this.pending.delete(p);
    if (r.ok) {
      p.deferred.resolve(r.value);
    } else {
      const e = new Error(r.error.message);
      e.name = r.cancelled ? 'CancelledError' : r.error.name;
      (e as Error & { __payload?: ErrorPayload }).__payload = r.error;
      p.deferred.reject(e);
    }
  }

  // ---- timers ------------------------------------------------------------

  private startTimer(durationMs: number): PendingTimer {
    const ev = this.emitCommand({ kind: 'startTimer', durationMs }) as TimerScheduledEvent;
    const t: PendingTimer = {
      kind: 'timer',
      id: ev.timerId,
      durationMs,
      fireAt: this.clock + durationMs,
      deferred: defer<void>(),
      scopeId: this.scopeAls.getStore() ?? null,
      settled: false,
    };
    this.pending.add(t);
    this.pushHeap({ at: t.fireAt, kind: 'timerFire', timer: t });
    return t;
  }

  private fireTimer(t: PendingTimer) {
    if (t.settled) return;
    t.settled = true;
    this.pending.delete(t);
    this.emitRuntime(this.makeEvent<TimerFiredEvent>({ type: 'TimerFired', timerId: t.id }));
    t.deferred.resolve();
  }

  private cancelTimer(t: PendingTimer) {
    if (t.settled) return;
    t.settled = true;
    this.pending.delete(t);
    this.emitRuntime(this.makeEvent<TimerCancelledEvent>({ type: 'TimerCancelled', timerId: t.id }));
    t.deferred.reject(new CancelledError());
  }

  // ---- compensation ------------------------------------------------------

  private registerCompensation(label: string, undo: Compensation) {
    const id = this.nextCompensationId++;
    // Associate with the work most recently FINISHED at the point of
    // registration (the activity whose await just returned) — not the most
    // recently scheduled one, which a parallel branch may have overtaken.
    let afterActivitySeq = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (h.type === 'ActivityCompleted' || h.type === 'ActivityTimedOut') {
        afterActivitySeq = h.seq;
        break;
      }
    }
    this.emitCommand({ kind: 'registerCompensation', compensationId: id, afterActivitySeq, label });
    this.compensations.push({ id, label, undo, afterActivitySeq });
  }

  private runCompensation(c: { id: number; label: string; undo: Compensation; afterActivitySeq: number }) {
    const options = normalizeOptions(c.undo.options);
    const p = this.scheduleActivity(c.undo.activityType, c.undo.input, options, c);
    p.deferred.promise.then(
      () => {
        this.emitRuntime(
          this.makeEvent<CompensationSucceededEvent>({ type: 'CompensationSucceeded', compensationId: c.id }),
        );
      },
      (e) => {
        this.emitRuntime(
          this.makeEvent<CompensationFailedEvent>({
            type: 'CompensationFailed',
            compensationId: c.id,
            error: payloadOf(e),
          }),
        );
      },
    );
  }

  // ---- parallel with fail-fast cancellation ------------------------------

  private async runParallel(thunks: (() => Promise<unknown>)[]): Promise<unknown[]> {
    const scopeId = this.nextScopeId++;
    const results = new Array(thunks.length);
    return this.scopeAls.run(scopeId, async () => {
      let firstFailure: unknown = null;
      const wrapped = thunks.map(async (thunk, i) => {
        try {
          results[i] = await thunk();
        } catch (e) {
          if (!firstFailure) {
            firstFailure = e;
            this.cancelScope(scopeId);
          }
          throw e;
        }
      });
      const settled = await Promise.allSettled(wrapped);
      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (rejected.length > 0) throw rejected[0].reason;
      return results;
    });
  }

  private cancelScope(scopeId: number) {
    for (const p of [...this.pending]) {
      if (p.scopeId !== scopeId) continue;
      if (p.kind === 'timer') this.cancelTimer(p);
      else this.queueCancelSignal(p);
    }
  }

  private queueCancelSignal(p: PendingActivity) {
    const state = p.attempts[p.attempts.length - 1];
    if (!state || state.terminalConsumed) return;
    this.cfg.host.queueCancel(p, state.attempt, this.clock, (sig) => {
      state.signals.push(sig);
      this.pushHeap({
        at: Math.max(sig.at, this.clock),
        kind: 'signal',
        activity: p,
        attemptNo: state.attempt,
        signalIndex: state.signals.length - 1,
      });
    });
  }

  // ---- root failure: cancel all, then undo in reverse --------------------

  private beginFailure(err: unknown) {
    if (this.phase !== 'running' || this.aborted) return;
    this.phase = 'cancelling';
    this.rootError = err;
    for (const p of [...this.pending]) {
      if (p.kind === 'timer') this.cancelTimer(p);
      else this.queueCancelSignal(p);
    }
  }

  private beginCompensation() {
    this.phase = 'compensating';
    this.compensationQueue = this.compensations.map((c) => c.id).reverse();
  }

  private nextCompensation(): (typeof this.compensations)[number] | null {
    const id = this.compensationQueue.shift();
    if (id === undefined) return null;
    return this.compensations.find((c) => c.id === id) ?? null;
  }

  private finishFailed() {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    const error = payloadOf(this.rootError);
    this.emitCommand({ kind: 'failWorkflow', error });
    this.result.status = 'failed';
    this.result.error = error;
  }

  // ---- main loop ---------------------------------------------------------

  async run(): Promise<MachineResult> {
    try {
      const ctx = this.buildCtx();

      const startEv = this.makeEvent<WorkflowStartedEvent>({
        type: 'WorkflowStarted',
        workflowType: this.cfg.workflowType,
        version: this.cfg.version,
        input: this.cfg.input,
      });
      this.cfg.host.onCommand(startEv, {
        kind: 'startWorkflow',
        workflowType: this.cfg.workflowType,
        version: this.cfg.version,
        input: this.cfg.input,
      });
      this.history.push(startEv);
      this.result.matches.push({
        historySeq: startEv.seq,
        command: { kind: 'startWorkflow', workflowType: this.cfg.workflowType, version: this.cfg.version, input: this.cfg.input },
      });

      const rootPromise = Promise.resolve()
        .then(() => this.cfg.fn(ctx, this.cfg.input))
        .then(
          (result) => {
            if (this.phase !== 'running') return;
            this.emitCommand({ kind: 'completeWorkflow', result: (result ?? null) as JSONValue });
            this.result.status = 'completed';
            this.result.result = (result ?? null) as JSONValue;
            // Rival terminals that already "happened" must still be recorded
            // as ignored events after the workflow completes.
            this.phase = this.heap.some((e) => e.kind === 'signal') ? 'tail' : 'finished';
          },
          (err) => {
            if (this.aborted) return;
            this.beginFailure(err);
          },
        );

      for (;;) {
        await this.drainMicrotasks();
        if (this.aborted) break;
        if (this.phase === 'finished') break;

        if (this.phase === 'tail') {
          // Drain every queued signal; they land on settled attempts/activities
          // and are recorded as ActivityTerminalIgnored. Retries/timers are
          // stale by now and skipped.
          const entry = this.popHeap();
          if (!entry) {
            this.phase = 'finished';
            break;
          }
          if (entry.at > this.clock) this.clock = entry.at;
          if (entry.kind === 'signal') this.processSignal(entry);
          if (!this.heap.some((e) => e.kind === 'signal')) this.phase = 'finished';
          continue;
        }

        if (this.phase === 'cancelling') {
          if (this.pending.size === 0) {
            this.beginCompensation();
            continue;
          }
        } else if (this.phase === 'compensating') {
          const busy = [...this.pending].some(
            (p) => p.kind === 'activity' && p.compensationId !== undefined,
          );
          if (!busy) {
            const c = this.nextCompensation();
            if (!c) {
              this.finishFailed();
              break;
            }
            this.runCompensation(c);
            continue;
          }
        }

        const entry = this.popHeap();
        if (!entry) {
          if (this.phase === 'cancelling') {
            this.beginCompensation();
            continue;
          }
          if (this.phase === 'compensating') {
            this.finishFailed();
            break;
          }
          // Heap empty but workflow still running: code is stuck on a promise
          // the runtime can never resolve.
          this.beginFailure(new Error('工作流挂起：等待一个运行时无法完成的活动或计时器'));
          continue;
        }

        if (entry.at > this.clock) this.clock = entry.at;
        if (entry.kind === 'signal') this.processSignal(entry);
        else if (entry.kind === 'retry') {
          if (!entry.activity!.settled) this.startAttempt(entry.activity!, entry.at);
        } else if (entry.kind === 'timerFire') {
          this.fireTimer(entry.timer!);
        }

        if (this.phase === 'cancelling' && this.pending.size === 0) {
          this.beginCompensation();
        }
      }

      await rootPromise.catch(() => {});
      // A divergence already ended the run inside the workflow coroutine; do
      // not ask the host to re-check the cursor (it would report a second,
      // misleading "ended early" divergence and overwrite the real one).
      if (!this.aborted) {
        const finishResp = this.cfg.host.onFinished();
        if (finishResp.divergence) this.failWithDivergence(finishResp.divergence);
      }
      this.result.history = [...this.history];
      return this.result;
    } catch (e) {
      if (e instanceof DivergenceError) {
        this.result.history = [...this.history];
        return this.result;
      }
      throw e;
    }
  }

  private drainMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }
}
