import { randomUUID } from 'node:crypto';
import type {
  ActivityFailureInfo,
  ActivityOptions,
  Command,
  EventType,
  Json,
  WorkflowEvent,
} from '../shared/types';
import { NativeDate } from './nativeGlobals';

let idCounter = 0;

export function runtimeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${NativeDate.now().toString(36)}_${idCounter.toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function makeEvent(
  seq: number,
  type: EventType,
  atMs: number,
  payload: Record<string, Json> = {},
  commandSeq?: number
): WorkflowEvent {
  return { seq, type, atMs, payload, ...(commandSeq === undefined ? {} : { commandSeq }) };
}

export function activityOptions(options?: Partial<ActivityOptions>): ActivityOptions {
  return {
    startToCloseTimeoutMs: options?.startToCloseTimeoutMs ?? 30_000,
    maxAttempts: options?.maxAttempts ?? 1,
    initialIntervalMs: options?.initialIntervalMs ?? 100,
    backoffCoefficient: options?.backoffCoefficient ?? 2,
    maxIntervalMs: options?.maxIntervalMs ?? 5_000,
  };
}

export function activityScheduled(
  seq: number,
  atMs: number,
  commandSeq: number,
  fields: {
    activityId: string;
    activityName: string;
    input: Json;
    options: ActivityOptions;
    attempt: number;
  }
): WorkflowEvent {
  return makeEvent(seq, 'ActivityScheduled', atMs, fields as unknown as Record<string, Json>, commandSeq);
}

export function terminalEvent(
  seq: number,
  type: 'ActivityCompleted' | 'ActivityFailed' | 'ActivityTimedOut' | 'ActivityCancelled',
  atMs: number,
  fields: {
    activityId: string;
    activityName?: string;
    attempt?: number;
    result?: Json;
    error?: ActivityFailureInfo;
    reason?: string;
  }
): WorkflowEvent {
  const payload = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Record<string, Json>;
  return makeEvent(seq, type, atMs, payload);
}
