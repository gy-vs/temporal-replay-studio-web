import type {
  ActivityFailureInfo,
  ActivityOptions,
  Json,
  ReplayStateView,
  RunStatus,
  WorkflowEvent,
} from './types';

interface PendingActivity {
  activityId: string;
  activityName: string;
  attempt: number;
  input: Json;
  options: ActivityOptions;
  scheduledSeq: number;
  terminal?: 'completed' | 'failed' | 'timedOut' | 'cancelled';
}

interface PendingTimer {
  timerId: string;
  durationMs: number;
  scheduledForMs: number;
  scheduledSeq: number;
  terminal?: 'fired' | 'cancelled';
}

interface CompensationEntry {
  compensationId: string;
  name: string;
  registeredSeq: number;
  status: 'registered' | 'started' | 'completed' | 'failed';
  error?: ActivityFailureInfo;
}

export interface WorkflowReductionState {
  status: RunStatus;
  pendingActivities: Map<string, PendingActivity>;
  pendingTimers: Map<string, PendingTimer>;
  compensations: CompensationEntry[];
  completed: Array<{ id: string; name: string; result?: Json }>;
  failed: Array<{ id: string; name: string; error: ActivityFailureInfo }>;
  versionMarkers: Record<string, number>;
  result?: Json;
  error?: ActivityFailureInfo;
}

const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeoutMs: 30_000,
  maxAttempts: 1,
  initialIntervalMs: 100,
  backoffCoefficient: 2,
  maxIntervalMs: 5_000,
};

export function initialReductionState(): WorkflowReductionState {
  return {
    status: 'running',
    pendingActivities: new Map(),
    pendingTimers: new Map(),
    compensations: [],
    completed: [],
    failed: [],
    versionMarkers: {},
  };
}

function payload(event: WorkflowEvent): Record<string, Json> {
  return event.payload && typeof event.payload === 'object' ? event.payload : {};
}

function asFailure(value: Json | undefined): ActivityFailureInfo {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as unknown as ActivityFailureInfo;
  }
  return { name: 'Error', message: 'missing failure payload' };
}

export function applyEvent(
  state: WorkflowReductionState,
  event: WorkflowEvent
): WorkflowReductionState {
  if (event.type === 'WorkflowStarted') return initialReductionState();

  const next: WorkflowReductionState = {
    ...state,
    pendingActivities: new Map(state.pendingActivities),
    pendingTimers: new Map(state.pendingTimers),
    compensations: state.compensations.map((item) => ({ ...item })),
    completed: [...state.completed],
    failed: [...state.failed],
    versionMarkers: { ...state.versionMarkers },
  };
  const p = payload(event);

  switch (event.type) {
    case 'ActivityScheduled': {
      const id = String(p.activityId);
      const options = {
        ...DEFAULT_ACTIVITY_OPTIONS,
        ...((p.options as unknown as ActivityOptions | undefined) ?? {}),
      };
      next.pendingActivities.set(id, {
        activityId: id,
        activityName: String(p.activityName),
        attempt: Number(p.attempt ?? 1),
        input: p.input,
        options,
        scheduledSeq: event.seq,
      });
      break;
    }
    case 'ActivityStarted':
    case 'ActivityRetryScheduled': {
      const id = String(p.activityId);
      const activity = next.pendingActivities.get(id);
      if (activity) {
        activity.attempt = Number(p.attempt ?? activity.attempt);
        activity.terminal = undefined;
      }
      break;
    }
    case 'ActivityCompleted': {
      const id = String(p.activityId);
      const activity = next.pendingActivities.get(id);
      if (activity && !activity.terminal) {
        activity.terminal = 'completed';
        next.pendingActivities.delete(id);
        next.completed.push({ id, name: activity.activityName, result: p.result });
      }
      break;
    }
    case 'ActivityFailed':
    case 'ActivityTimedOut': {
      const id = String(p.activityId);
      const activity = next.pendingActivities.get(id);
      if (activity && !activity.terminal) {
        activity.terminal = event.type === 'ActivityTimedOut' ? 'timedOut' : 'failed';
        next.pendingActivities.delete(id);
        next.failed.push({
          id,
          name: activity.activityName,
          error: asFailure(p.error),
        });
      }
      break;
    }
    case 'ActivityCancelRequested':
      break;
    case 'ActivityCancelled': {
      const id = String(p.activityId);
      const activity = next.pendingActivities.get(id);
      if (activity && !activity.terminal) {
        activity.terminal = 'cancelled';
        next.pendingActivities.delete(id);
        next.failed.push({
          id,
          name: activity.activityName,
          error: {
            name: 'CancellationError',
            message: String(p.reason ?? 'activity cancelled'),
            activityId: id,
            activityName: activity.activityName,
            cancellation: true,
          },
        });
      }
      break;
    }
    case 'ActivityTerminalDiscarded':
      break;
    case 'TimerStarted': {
      const id = String(p.timerId);
      next.pendingTimers.set(id, {
        timerId: id,
        durationMs: Number(p.durationMs),
        scheduledForMs: Number(p.scheduledForMs),
        scheduledSeq: event.seq,
      });
      break;
    }
    case 'TimerFired': {
      const timer = next.pendingTimers.get(String(p.timerId));
      if (timer && !timer.terminal) {
        timer.terminal = 'fired';
        next.pendingTimers.delete(timer.timerId);
      }
      break;
    }
    case 'TimerCancelRequested':
      break;
    case 'TimerCancelled': {
      const timer = next.pendingTimers.get(String(p.timerId));
      if (timer && !timer.terminal) {
        timer.terminal = 'cancelled';
        next.pendingTimers.delete(timer.timerId);
      }
      break;
    }
    case 'TimerCancelIgnored':
    case 'TimerFireDiscarded':
      break;
    case 'CompensationRegistered':
      next.compensations.push({
        compensationId: String(p.compensationId),
        name: String(p.name),
        registeredSeq: event.seq,
        status: 'registered',
      });
      break;
    case 'CompensationStarted': {
      const item = next.compensations.find(
        (entry) => entry.compensationId === String(p.compensationId)
      );
      if (item) item.status = 'started';
      break;
    }
    case 'CompensationCompleted': {
      const item = next.compensations.find(
        (entry) => entry.compensationId === String(p.compensationId)
      );
      if (item) item.status = 'completed';
      break;
    }
    case 'CompensationFailed': {
      const item = next.compensations.find(
        (entry) => entry.compensationId === String(p.compensationId)
      );
      if (item) {
        item.status = 'failed';
        item.error = asFailure(p.error);
      }
      break;
    }
    case 'WorkflowVersionMarked':
      next.versionMarkers[String(p.changeId)] = Number(p.version);
      break;
    case 'RuntimeObserved':
      break;
    case 'WorkflowCompleted':
      next.status = 'completed';
      next.result = p.result;
      break;
    case 'WorkflowFailed':
      next.status = 'failed';
      next.error = asFailure(p.error);
      break;
  }
  return next;
}

export function reduceEvents(events: WorkflowEvent[]): WorkflowReductionState {
  return events.reduce(
    (state, event) => applyEvent(state, event),
    initialReductionState()
  );
}

export function toStateView(state: WorkflowReductionState): ReplayStateView {
  return {
    status: state.status,
    pendingActivities: [...state.pendingActivities.values()]
      .filter((activity) => !activity.terminal)
      .map(({ activityId, activityName, attempt, input, options, scheduledSeq }) => ({
        activityId,
        activityName,
        attempt,
        input,
        options,
        scheduledSeq,
      })),
    pendingTimers: [...state.pendingTimers.values()]
      .filter((timer) => !timer.terminal)
      .map(({ timerId, durationMs, scheduledForMs, scheduledSeq }) => ({
        timerId,
        durationMs,
        scheduledForMs,
        scheduledSeq,
      })),
    compensations: state.compensations
      .filter((item) => item.status === 'registered')
      .map(({ compensationId, name, registeredSeq }) => ({
        compensationId,
        name,
        registeredSeq,
      })),
    completed: state.completed,
    failed: state.failed,
    versionMarkers: state.versionMarkers,
    result: state.result,
    error: state.error,
  };
}

export function viewEvents(events: WorkflowEvent[]): ReplayStateView {
  return toStateView(reduceEvents(events));
}
