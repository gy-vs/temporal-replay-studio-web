import { describe, it, expect } from 'vitest';
import { eventKind, projectHistory } from './projection.js';
import type { HistoryEvent } from '../shared/types.js';

const history: HistoryEvent[] = [
  { seq: 1, at: 0, type: 'WorkflowStarted', workflowType: 'wf', version: 'v1', input: null },
  { seq: 2, at: 0, type: 'ActivityScheduled', activityId: 1, activityType: 'a', input: null, options: { scheduleToCloseTimeoutMs: 100, retry: { maxAttempts: 1, initialBackoffMs: 1, maxBackoffMs: 1 } } },
  { seq: 3, at: 0, type: 'ActivityStarted', activityId: 1, attempt: 1 },
  { seq: 4, at: 5, type: 'ActivityAttemptFailed', activityId: 1, attempt: 1, kind: 'failure', error: { name: 'E', message: 'x' }, backoffMs: 0 },
  { seq: 5, at: 5, type: 'TimerScheduled', timerId: 1, durationMs: 100 },
  { seq: 6, at: 5, type: 'CompensationRegistered', compensationId: 1, afterActivitySeq: 2, label: 'undo' },
  { seq: 7, at: 105, type: 'TimerFired', timerId: 1 },
  { seq: 8, at: 105, type: 'ActivityCancelled', activityId: 1, attempt: 1, error: { name: 'C', message: 'c' } },
  { seq: 9, at: 105, type: 'ActivityTerminalIgnored', activityId: 1, attempt: 1, ignored: 'timedout', reason: 'late' },
  { seq: 10, at: 105, type: 'CompensationFailed', compensationId: 1, error: { name: 'X', message: 'y' } },
  { seq: 11, at: 105, type: 'WorkflowFailed', error: { name: 'X', message: 'y' } },
];

describe('projection', () => {
  it('sees a running activity before its terminal', () => {
    const p = projectHistory(history, 3);
    expect(p.workflowStatus).toBe('running');
    expect(p.pendingActivities.map((a) => a.activityId)).toEqual([1]);
    expect(p.pendingActivities[0].status).toBe('running');
    expect(p.clock).toBe(0);
  });

  it('treats a final AttemptFailed as failed once no retry follows', () => {
    const p = projectHistory(history, 4);
    expect(p.pendingActivities).toHaveLength(0);
    expect(p.settledActivities[0].status).toBe('failed');
  });

  it('tracks timers and compensations, ignored terminals and final state', () => {
    const p = projectHistory(history, 11);
    expect(p.workflowStatus).toBe('failed');
    expect(p.settledActivities[0].status).toBe('cancelled');
    expect(p.timers[0].status).toBe('fired');
    expect(p.compensations[0].status).toBe('failed');
    expect(p.ignoredTerminals).toEqual([9]);
    expect(p.clock).toBe(105);
  });

  it('splits events into commands and runtime events', () => {
    const p = projectHistory(history, 7);
    expect(p.commandSeqs).toEqual([1, 2, 5, 6]);
    expect(p.runtimeSeqs).toEqual([3, 4, 7]);
    expect(eventKind(history[1])).toBe('command');
    expect(eventKind(history[2])).toBe('runtime');
  });
});
