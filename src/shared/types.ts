export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export type JSONObject = { [key: string]: Json };

export type ActivityTerminalKind =
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'cancelled';

export interface RetryPolicy {
  maxAttempts: number;
  initialIntervalMs: number;
  backoffCoefficient: number;
  maxIntervalMs: number;
}

export interface ActivityOptions extends Partial<RetryPolicy> {
  startToCloseTimeoutMs: number;
}

export interface ActivityFailureInfo {
  name: string;
  message: string;
  activityId?: string;
  activityName?: string;
  attempt?: number;
  timeout?: boolean;
  cancellation?: boolean;
  determinism?: boolean;
  [key: string]: Json | undefined;
}

export interface RunOptions {
  startTimeMs?: number;
  seed?: number;
  activityOverrides?: Record<string, ActivityBehaviorConfig>;
}

export type ActivityBehavior = 'success' | 'failure' | 'timeout';

export interface ActivityBehaviorConfig {
  behavior?: ActivityBehavior;
  delayMs?: number;
  failureMessage?: string;
  result?: Json;
  /** Race a cancellation with the terminal result. `lateCancel` wins completion; `lateTerminal` cancels first. */
  race?: 'none' | 'lateCancel' | 'lateTerminal';
}

export type CommandType =
  | 'activity'
  | 'cancel-activity'
  | 'start-timer'
  | 'cancel-timer'
  | 'register-compensation'
  | 'mark-version'
  | 'observe-runtime'
  | 'workflow-result'
  | 'compensation-failure';

export interface Command<T extends Json = Json> {
  type: CommandType;
  payload: T;
}

export type EventType =
  | 'WorkflowStarted'
  | 'ActivityScheduled'
  | 'ActivityStarted'
  | 'ActivityCompleted'
  | 'ActivityFailed'
  | 'ActivityTimedOut'
  | 'ActivityRetryScheduled'
  | 'ActivityCancelRequested'
  | 'ActivityCancelled'
  | 'ActivityTerminalDiscarded'
  | 'TimerStarted'
  | 'TimerFired'
  | 'TimerCancelRequested'
  | 'TimerCancelled'
  | 'TimerCancelIgnored'
  | 'TimerFireDiscarded'
  | 'CompensationRegistered'
  | 'CompensationStarted'
  | 'CompensationCompleted'
  | 'CompensationFailed'
  | 'WorkflowVersionMarked'
  | 'RuntimeObserved'
  | 'WorkflowCompleted'
  | 'WorkflowFailed';

export interface WorkflowEvent {
  seq: number;
  type: EventType;
  atMs: number;
  /** The command sequence which generated this event, when it is an imperative event. */
  commandSeq?: number;
  payload: JSONObject;
}

export type RunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RunRecord {
  runId: string;
  workflowType: string;
  version: string;
  status: RunStatus;
  startedAtMs: number;
  endedAtMs?: number;
  input: Json;
  options: RunOptions;
  events: WorkflowEvent[];
  result?: Json;
  error?: ActivityFailureInfo;
  createdAt: string;
}

export interface WorkflowDefinitionMeta {
  workflowType: string;
  version: string;
  description?: string;
}

export interface CancellationError extends Error {
  readonly isCancellation: true;
}

export interface WorkflowContext {
  activity<T = Json>(
    name: string,
    input?: Json,
    options?: Partial<ActivityOptions>
  ): Promise<T>;
  timer(durationMs: number): Promise<void>;
  cancelActivity(activityId: string, reason?: string): void;
  cancelTimer(timerId: string, reason?: string): boolean;
  registerCompensation(
    name: string,
    fn: (context: CompensationContext) => Promise<void> | void
  ): void;
  getVersion(changeId: string, minSupported: number, maxSupported: number): number;
  now(): number;
  random(): number;
  randomInt(minInclusive: number, maxExclusive: number): number;
}

export interface CompensationContext {
  activity(name: string, input?: Json): Promise<Json>;
  now(): number;
  random(): number;
}

export type WorkflowHandler = (
  input: Json,
  context: WorkflowContext
) => Promise<Json | void> | Json | void;

export interface WorkflowDefinition extends WorkflowDefinitionMeta {
  handler: WorkflowHandler;
}

export interface PendingActivityView {
  activityId: string;
  activityName: string;
  attempt: number;
  input: Json;
  options: ActivityOptions;
  scheduledSeq: number;
}

export interface PendingTimerView {
  timerId: string;
  durationMs: number;
  scheduledForMs: number;
  scheduledSeq: number;
}

export interface CompensationView {
  compensationId: string;
  name: string;
  registeredSeq: number;
}

export interface ReplayStateView {
  status: RunStatus;
  pendingActivities: PendingActivityView[];
  pendingTimers: PendingTimerView[];
  compensations: CompensationView[];
  completed: Array<{ id: string; name: string; result?: Json }>;
  failed: Array<{ id: string; name: string; error: ActivityFailureInfo }>;
  versionMarkers: Record<string, number>;
  result?: Json;
  error?: ActivityFailureInfo;
}

export type ReplayOutcome =
  | 'matched'
  | 'diverged'
  | 'corrupt'
  | 'determinism-violation';

export interface Divergence {
  seq: number;
  expected: Command | null;
  actual: Command | null;
  reason: string;
  before: WorkflowEvent[];
  event: WorkflowEvent | null;
  after: WorkflowEvent[];
}

export interface Corruption {
  seq: number | null;
  reason: string;
  before: WorkflowEvent[];
  event: WorkflowEvent | null;
  after: WorkflowEvent[];
}

export interface ReplayResult {
  id: string;
  sourceRunId: string;
  workflowType: string;
  requestedVersion: string;
  outcome: ReplayOutcome;
  consumedThroughSeq: number;
  divergence: Divergence | null;
  corruption: Corruption | null;
  determinismViolation?: {
    seq: number;
    message: string;
    source?: string;
  } | null;
  actualCommands: Array<{ seq: number; command: Command }>;
  finalState: ReplayStateView | null;
  replayedAt: string;
}
