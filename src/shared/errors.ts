import type { ActivityFailureInfo } from './types';

export class DeterminismViolationError extends Error {
  readonly isDeterminismViolation = true;

  constructor(message: string, readonly source?: string) {
    super(message);
    this.name = 'DeterminismViolationError';
  }
}

export class CancellationErrorImpl extends Error {
  readonly isCancellation = true as const;

  constructor(message = 'operation cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

export class ActivityFailure extends Error {
  readonly info: ActivityFailureInfo;

  constructor(info: ActivityFailureInfo) {
    super(info.message);
    this.name = info.name || 'ActivityFailure';
    this.info = info;
  }
}

export class CorruptHistoryError extends Error {
  readonly seq: number | null;

  constructor(message: string, seq: number | null = null) {
    super(message);
    this.name = 'CorruptHistoryError';
    this.seq = seq;
  }
}

export function isCancellation(value: unknown): value is { isCancellation: true } {
  return Boolean(value && typeof value === 'object' && 'isCancellation' in value);
}

export function isDeterminismViolation(
  value: unknown
): value is { isDeterminismViolation: true; message: string; source?: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'isDeterminismViolation' in value &&
      (value as { isDeterminismViolation?: unknown }).isDeterminismViolation === true
  );
}

export function failureInfo(error: unknown): ActivityFailureInfo {
  if (isDeterminismViolation(error)) {
    return {
      name: 'DeterminismViolationError',
      message: error.message,
      source: error.source,
      determinism: true,
    };
  }
  if (error instanceof ActivityFailure) return error.info;
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
}
