// Shared types: event history, commands, run & replay reports.
// These cross the server/UI boundary and must stay JSON-serializable.

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/** Terminal states an activity attempt can reach. */
export type ActivityTerminal = 'completed' | 'failed' | 'timedout' | 'cancelled';

export interface ErrorPayload {
  name: string;
  message: string;
  /** Non-retriable failures stop retry; timeout/cancel/retriable failures back off. */
  nonRetriable?: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
}

export interface ActivityOptions {
  scheduleToCloseTimeoutMs: number;
  retry: RetryPolicy;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 1,
  initialBackoffMs: 100,
  maxBackoffMs: 1000,
};

export const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions = {
  scheduleToCloseTimeoutMs: 5000,
  retry: DEFAULT_RETRY,
};

// ---------------------------------------------------------------------------
// History events
// ---------------------------------------------------------------------------

export type HistoryEvent =
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | ActivityScheduledEvent
  | ActivityStartedEvent
  | ActivityAttemptFailedEvent
  | ActivityCompletedEvent
  | ActivityTimedOutEvent
  | ActivityCancelledEvent
  | ActivityTerminalIgnoredEvent
  | TimerScheduledEvent
  | TimerFiredEvent
  | TimerCancelledEvent
  | CompensationRegisteredEvent
  | CompensationStartedEvent
  | CompensationSucceededEvent
  | CompensationFailedEvent
  | VersionMarkerEvent
  | RandomConsumedEvent
  | NowSampledEvent
  | DeterminismViolationEvent;

export type EventType = HistoryEvent['type'];

interface EventBase {
  /** 1-based position in history; must be contiguous and gap-free. */
  seq: number;
  /** Virtual runtime clock (ms). */
  at: number;
}

export interface WorkflowStartedEvent extends EventBase {
  type: 'WorkflowStarted';
  workflowType: string;
  /** Version string recorded at recording time; never compared during replay. */
  version: string;
  input: JSONValue;
}

export interface WorkflowCompletedEvent extends EventBase {
  type: 'WorkflowCompleted';
  result: JSONValue;
}

export interface WorkflowFailedEvent extends EventBase {
  type: 'WorkflowFailed';
  error: ErrorPayload;
}

export interface ActivityScheduledEvent extends EventBase {
  type: 'ActivityScheduled';
  /** Runtime-assigned stable id; ids are assigned in command order. */
  activityId: number;
  activityType: string;
  input: JSONValue;
  options: ActivityOptions;
  /** Scheduled sequence of the enclosing compensation activity, when any. */
  compensationOf?: number;
  /** Compensation this activity executes, when it is an undo activity. */
  compensationId?: number;
}

export interface ActivityStartedEvent extends EventBase {
  type: 'ActivityStarted';
  activityId: number;
  /** 1-based attempt counter. */
  attempt: number;
}

/** A failed attempt that *may* be retried (retriable failure or timeout). */
export interface ActivityAttemptFailedEvent extends EventBase {
  type: 'ActivityAttemptFailed';
  activityId: number;
  attempt: number;
  kind: 'failure' | 'timeout';
  error: ErrorPayload;
  /** ms the runtime waited before the next attempt; 0 means no retry followed. */
  backoffMs: number;
}

export interface ActivityCompletedEvent extends EventBase {
  type: 'ActivityCompleted';
  activityId: number;
  attempt: number;
  result: JSONValue;
}

export interface ActivityTimedOutEvent extends EventBase {
  type: 'ActivityTimedOut';
  activityId: number;
  attempt: number;
  error: ErrorPayload;
}

export interface ActivityCancelledEvent extends EventBase {
  type: 'ActivityCancelled';
  activityId: number;
  attempt: number;
  error: ErrorPayload;
}

/** A terminal signal that arrived after the attempt already terminated. */
export interface ActivityTerminalIgnoredEvent extends EventBase {
  type: 'ActivityTerminalIgnored';
  activityId: number;
  attempt: number;
  ignored: ActivityTerminal;
  reason: string;
}

export interface TimerScheduledEvent extends EventBase {
  type: 'TimerScheduled';
  timerId: number;
  durationMs: number;
}

export interface TimerFiredEvent extends EventBase {
  type: 'TimerFired';
  timerId: number;
}

export interface TimerCancelledEvent extends EventBase {
  type: 'TimerCancelled';
  timerId: number;
}

export interface CompensationRegisteredEvent extends EventBase {
  type: 'CompensationRegistered';
  compensationId: number;
  /** Activity schedule sequence this compensation was registered after. */
  afterActivitySeq: number;
  label: string;
}

export interface CompensationStartedEvent extends EventBase {
  type: 'CompensationStarted';
  compensationId: number;
  activityId: number;
  activityType: string;
  input: JSONValue;
  options: ActivityOptions;
}

export interface CompensationSucceededEvent extends EventBase {
  type: 'CompensationSucceeded';
  compensationId: number;
}

export interface CompensationFailedEvent extends EventBase {
  type: 'CompensationFailed';
  compensationId: number;
  error: ErrorPayload;
}

export interface VersionMarkerEvent extends EventBase {
  type: 'VersionMarker';
  changeId: string;
  /** Version recorded at recording time. */
  version: number;
}

export interface RandomConsumedEvent extends EventBase {
  type: 'RandomConsumed';
  value: number;
}

export interface NowSampledEvent extends EventBase {
  type: 'NowSampled';
  nowMs: number;
}

export interface DeterminismViolationEvent extends EventBase {
  type: 'DeterminismViolation';
  kind: 'Date.now' | 'new Date()' | 'Math.random';
  message: string;
}

/** Events that are emitted as a direct consequence of one code command. */
export const COMMAND_EVENT_TYPES = [
  'WorkflowStarted',
  'ActivityScheduled',
  'TimerScheduled',
  'CompensationRegistered',
  'VersionMarker',
  'RandomConsumed',
  'NowSampled',
  'DeterminismViolation',
  'WorkflowCompleted',
  'WorkflowFailed',
] as const;

/** Runtime events: outcomes the runtime attaches to pending work. */
export const RUNTIME_EVENT_TYPES = [
  'ActivityStarted',
  'ActivityAttemptFailed',
  'ActivityCompleted',
  'ActivityTimedOut',
  'ActivityCancelled',
  'ActivityTerminalIgnored',
  'TimerFired',
  'TimerCancelled',
  'CompensationSucceeded',
  'CompensationFailed',
] as const;

// ---------------------------------------------------------------------------
// Commands — what the code asks for, in replay-comparable form
// ---------------------------------------------------------------------------

export type Command =
  | { kind: 'startWorkflow'; workflowType: string; version: string; input: JSONValue }
  | {
      kind: 'scheduleActivity';
      activityType: string;
      input: JSONValue;
      options: ActivityOptions;
      compensationOf?: number;
      compensationId?: number;
    }
  | { kind: 'startTimer'; durationMs: number }
  | { kind: 'registerCompensation'; compensationId: number; afterActivitySeq: number; label: string }
  | { kind: 'version'; changeId: string; version: number }
  | { kind: 'random'; value?: number }
  | { kind: 'now'; nowMs?: number }
  | { kind: 'determinismViolation'; violationKind: DeterminismViolationEvent['kind']; message: string }
  | { kind: 'completeWorkflow'; result: JSONValue }
  | { kind: 'failWorkflow'; error: ErrorPayload };

export interface CommandMatch {
  /** Position of the history event that satisfied this command. */
  historySeq: number;
  command: Command;
}

export interface ActivityPlan {
  /** attempts[seq] = terminal outcome, or 'ignored' bookkeeping rows. */
  attempts: {
    started: ActivityStartedEvent;
    /** First terminal that wins. */
    winner?: ActivityCompletedEvent | ActivityTimedOutEvent | ActivityCancelledEvent;
    failure?: ActivityAttemptFailedEvent;
    ignored: ActivityTerminalIgnoredEvent[];
  }[];
}

// ---------------------------------------------------------------------------
// Run & replay reports
// ---------------------------------------------------------------------------

export interface RunRequest {
  workflowType: string;
  version: string;
  input: JSONValue;
  /** Activity type -> simulated behaviour; missing types succeed. */
  activities?: Record<string, ActivityBehaviour>;
  /** Exact id/seed; server generates when omitted. */
  runId?: string;
  seed?: number;
}

export type ActivityBehaviour =
  | { mode: 'succeed'; afterMs?: number; result?: JSONValue }
  | { mode: 'fail'; afterMs?: number; error: ErrorPayload }
  | { mode: 'timeout'; afterMs?: number }
  /** Emit several terminal signals nearly at once; listed in arrival order. */
  | {
      mode: 'race';
      signals: (
        | { kind: 'completed'; atMs: number; result?: JSONValue }
        | { kind: 'failed'; atMs: number; error: ErrorPayload }
        | { kind: 'timeout'; atMs: number }
        | { kind: 'cancelled'; atMs: number }
      )[];
    };

export interface RunSummary {
  runId: string;
  workflowType: string;
  version: string;
  input: JSONValue;
  status: 'completed' | 'failed';
  result?: JSONValue;
  error?: ErrorPayload;
  eventCount: number;
  history: HistoryEvent[];
  determinismViolations: { kind: DeterminismViolationEvent['kind']; message: string }[];
  seed: number;
}

export interface CorruptionIssue {
  seq: number | null;
  code:
    | 'EMPTY_HISTORY'
    | 'FIRST_EVENT_NOT_STARTED'
    | 'SEQ_GAP'
    | 'DUPLICATE_SEQ'
    | 'UNKNOWN_ACTIVITY'
    | 'ORPHAN_COMPENSATION'
    | 'INVALID_ATTEMPT_LIFECYCLE'
    | 'UNKNOWN_TIMER'
    | 'UNKNOWN_COMPENSATION'
    | 'DUPLICATE_TERMINAL'
    | 'UNRESOLVED_AFTER_TERMINAL'
    | 'TRUNCATED'
    | 'MALFORMED_EVENT'
    | 'UNKNOWN_EVENT_TYPE';
  message: string;
}

export interface ReplayNote {
  seq: number;
  kind: 'versionDowngrade' | 'versionBackfill' | 'ignoredTerminal';
  message: string;
}

export type ReplayStatus = 'matches' | 'diverges' | 'corrupt';

export interface Divergence {
  /** History position where new code's command stream stops matching. */
  atSeq: number | null;
  expected: { event?: HistoryEvent; pending?: string };
  /** What the new code actually produced: a code command, a runtime event, or nothing (early end). */
  actual: Command | { kind: 'none' } | { kind: 'runtimeEvent'; event: HistoryEvent };
  message: string;
  contextBefore: HistoryEvent[];
  contextAfter: HistoryEvent[];
}

export interface ReplayReport {
  status: ReplayStatus;
  workflowType: string;
  replayedWithVersion: string;
  /** Commands that matched, in code-emission order, with consumed positions. */
  matches: CommandMatch[];
  divergence: Divergence | null;
  corruption: CorruptionIssue[];
  notes: ReplayNote[];
  result?: JSONValue;
  error?: ErrorPayload;
  determinismViolations: { kind: DeterminismViolationEvent['kind']; message: string }[];
}

export interface WorkflowInfo {
  type: string;
  versions: string[];
  findings: Record<string, { kind: string; message: string; line?: number }[]>;
}
