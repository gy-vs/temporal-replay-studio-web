import type { HistoryEvent } from '../shared/types.js';

/** A scheduled activity's lifecycle as derivable from a history prefix. */
export interface ActivityState {
  activityId: number;
  activityType: string;
  attempt: number;
  status: 'scheduled' | 'running' | 'retrying' | 'completed' | 'failed' | 'timedout' | 'cancelled';
  compensationOf?: number;
  compensationId?: number;
  at: number;
}

export interface TimerState {
  timerId: number;
  durationMs: number;
  status: 'waiting' | 'fired' | 'cancelled';
  fireAt: number;
}

export interface CompensationState {
  compensationId: number;
  label: string;
  afterActivitySeq: number;
  status: 'registered' | 'running' | 'succeeded' | 'failed';
}

export interface Projection {
  /** Activities still awaiting an outcome at this prefix position. */
  pendingActivities: ActivityState[];
  /** Activities that have settled. */
  settledActivities: ActivityState[];
  timers: TimerState[];
  pendingTimers: TimerState[];
  compensations: CompensationState[];
  workflowStatus: 'running' | 'completed' | 'failed';
  /** Command events (what the code asked for), in order. */
  commandSeqs: number[];
  /** Runtime events (what happened), in order. */
  runtimeSeqs: number[];
  /** Latest virtual clock value. */
  clock: number;
  result?: unknown;
  error?: unknown;
  ignoredTerminals: number[];
  versionMarkers: { seq: number; changeId: string; version: number }[];
}

const COMMAND_TYPES = new Set([
  'WorkflowStarted',
  'WorkflowCompleted',
  'WorkflowFailed',
  'ActivityScheduled',
  'TimerScheduled',
  'CompensationRegistered',
  'VersionMarker',
  'RandomConsumed',
  'NowSampled',
  'DeterminismViolation',
]);

export function projectHistory(history: HistoryEvent[], upToSeq: number): Projection {
  const activities = new Map<number, ActivityState>();
  const order: number[] = [];
  const timers = new Map<number, TimerState>();
  const compensations = new Map<number, CompensationState>();
  const ignoredTerminals: number[] = [];
  const versionMarkers: Projection['versionMarkers'] = [];
  const commandSeqs: number[] = [];
  const runtimeSeqs: number[] = [];
  let workflowStatus: Projection['workflowStatus'] = 'running';
  let clock = 0;
  let result: unknown;
  let error: unknown;

  const prefix = history.filter((e) => e.seq <= upToSeq);

  for (const ev of prefix) {
    clock = Math.max(clock, ev.at);
    if (COMMAND_TYPES.has(ev.type)) commandSeqs.push(ev.seq);
    else runtimeSeqs.push(ev.seq);

    switch (ev.type) {
      case 'WorkflowStarted':
        break;
      case 'WorkflowCompleted':
        workflowStatus = 'completed';
        result = ev.result;
        break;
      case 'WorkflowFailed':
        workflowStatus = 'failed';
        error = ev.error;
        break;

      case 'ActivityScheduled': {
        const a: ActivityState = {
          activityId: ev.activityId,
          activityType: ev.activityType,
          attempt: 0,
          status: 'scheduled',
          at: ev.at,
          ...(ev.compensationOf !== undefined ? { compensationOf: ev.compensationOf } : {}),
          ...(ev.compensationId !== undefined ? { compensationId: ev.compensationId } : {}),
        };
        activities.set(ev.activityId, a);
        order.push(ev.activityId);
        if (ev.compensationId !== undefined) {
          const c = compensations.get(ev.compensationId);
          if (c) c.status = 'running';
        }
        break;
      }
      case 'ActivityStarted': {
        const a = activities.get(ev.activityId);
        if (a) {
          a.attempt = ev.attempt;
          a.status = 'running';
        }
        break;
      }
      case 'ActivityAttemptFailed': {
        const a = activities.get(ev.activityId);
        if (a) a.status = 'retrying'; // tentatively; settled if no retry follows
        break;
      }
      case 'ActivityCompleted': {
        const a = activities.get(ev.activityId);
        if (a) a.status = 'completed';
        break;
      }
      case 'ActivityTimedOut': {
        const a = activities.get(ev.activityId);
        if (a) a.status = 'timedout';
        break;
      }
      case 'ActivityCancelled': {
        const a = activities.get(ev.activityId);
        if (a) a.status = 'cancelled';
        break;
      }
      case 'ActivityTerminalIgnored':
        ignoredTerminals.push(ev.seq);
        break;

      case 'TimerScheduled':
        timers.set(ev.timerId, {
          timerId: ev.timerId,
          durationMs: ev.durationMs,
          status: 'waiting',
          fireAt: ev.at + ev.durationMs,
        });
        break;
      case 'TimerFired': {
        const t = timers.get(ev.timerId);
        if (t) t.status = 'fired';
        break;
      }
      case 'TimerCancelled': {
        const t = timers.get(ev.timerId);
        if (t) t.status = 'cancelled';
        break;
      }

      case 'CompensationRegistered':
        compensations.set(ev.compensationId, {
          compensationId: ev.compensationId,
          label: ev.label,
          afterActivitySeq: ev.afterActivitySeq,
          status: 'registered',
        });
        break;
      case 'CompensationSucceeded': {
        const c = compensations.get(ev.compensationId);
        if (c) c.status = 'succeeded';
        break;
      }
      case 'CompensationFailed': {
        const c = compensations.get(ev.compensationId);
        if (c) c.status = 'failed';
        break;
      }

      case 'VersionMarker':
        versionMarkers.push({ seq: ev.seq, changeId: ev.changeId, version: ev.version });
        break;
    }
  }

  // An ActivityAttemptFailed with no later Started is a settled failure.
  for (const ev of prefix) {
    if (ev.type !== 'ActivityAttemptFailed') continue;
    const a = activities.get(ev.activityId);
    if (!a || a.status !== 'retrying') continue;
    const hasLaterStart = prefix.some(
      (x) =>
        x.type === 'ActivityStarted' &&
        x.activityId === ev.activityId &&
        x.attempt > ev.attempt,
    );
    const hasTerminal = prefix.some(
      (x) =>
        (x.type === 'ActivityTimedOut' || x.type === 'ActivityCancelled' || x.type === 'ActivityCompleted') &&
        x.activityId === ev.activityId &&
        x.seq > ev.seq,
    );
    if (!hasLaterStart && !hasTerminal) a.status = 'failed';
  }

  const allActivities = order.map((id) => activities.get(id)!);
  const settledActivities = allActivities.filter((a) =>
    ['completed', 'failed', 'timedout', 'cancelled'].includes(a.status),
  );
  const pendingActivities = allActivities.filter((a) =>
    ['scheduled', 'running', 'retrying'].includes(a.status),
  );
  const allTimers = [...timers.values()];
  const pendingTimers = allTimers.filter((t) => t.status === 'waiting');

  return {
    pendingActivities,
    settledActivities,
    timers: allTimers,
    pendingTimers,
    compensations: [...compensations.values()],
    workflowStatus,
    commandSeqs,
    runtimeSeqs,
    clock,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ignoredTerminals,
    versionMarkers,
  };
}

export function eventKind(ev: HistoryEvent): 'command' | 'runtime' {
  return COMMAND_TYPES.has(ev.type) ? 'command' : 'runtime';
}
