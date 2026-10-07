import type { Command, WorkflowEvent } from '../shared/types';

const IMPERATIVE_EVENTS = new Set<WorkflowEvent['type']>([
  'ActivityScheduled',
  'ActivityCancelRequested',
  'TimerStarted',
  'TimerCancelRequested',
  'CompensationRegistered',
  'WorkflowVersionMarked',
  'RuntimeObserved',
]);

export function isImperativeEvent(event: WorkflowEvent | undefined): boolean {
  return Boolean(event && IMPERATIVE_EVENTS.has(event.type));
}

export function commandForEvent(event: WorkflowEvent): Command | null {
  const p = event.payload;
  switch (event.type) {
    case 'ActivityScheduled':
      return {
        type: 'activity',
        payload: {
          activityId: p.activityId,
          activityName: p.activityName,
          input: p.input,
          options: p.options,
        },
      };
    case 'ActivityCancelRequested':
      return {
        type: 'cancel-activity',
        payload: { activityId: p.activityId, reason: p.reason ?? null },
      };
    case 'TimerStarted':
      return {
        type: 'start-timer',
        payload: { timerId: p.timerId, durationMs: p.durationMs },
      };
    case 'TimerCancelRequested':
      return {
        type: 'cancel-timer',
        payload: { timerId: p.timerId, reason: p.reason ?? null },
      };
    case 'CompensationRegistered':
      return {
        type: 'register-compensation',
        payload: { compensationId: p.compensationId, name: p.name },
      };
    case 'WorkflowVersionMarked':
      return {
        type: 'mark-version',
        payload: {
          changeId: p.changeId,
          minSupported: p.minSupported,
          maxSupported: p.maxSupported,
          version: p.version,
        },
      };
    case 'RuntimeObserved': {
      const payload: Record<string, unknown> = { kind: p.kind };
      if (p.min !== undefined) payload.min = p.min;
      if (p.max !== undefined) payload.max = p.max;
      return {
        type: 'observe-runtime',
        payload: payload as Command['payload'],
      };
    }
    default:
      return null;
  }
}
