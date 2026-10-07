import { CancellationErrorImpl, ActivityFailure } from '../shared/errors';
import type {
  ActivityFailureInfo,
  ActivityOptions,
  Command,
  Json,
  WorkflowContext,
} from '../shared/types';
import { activityOptions } from './events';

export type ActivityTerminal =
  | { kind: 'completed'; result: Json }
  | { kind: 'failed'; error: ActivityFailureInfo }
  | { kind: 'timedOut'; error: ActivityFailureInfo }
  | { kind: 'cancelled'; reason: string };

export interface RuntimeHost {
  emit(command: Command): number;
  resolveVersion(commandSeq: number): number;
  observeValue(commandSeq: number, command: Command): number;
  activity(command: Command, commandSeq: number): Promise<ActivityTerminal>;
  timer(command: Command, commandSeq: number): Promise<{ cancelled: boolean; reason?: string }>;
  cancelActivity(command: Command, commandSeq: number): void;
  cancelTimer(command: Command, commandSeq: number): boolean;
}

interface CompensationRegistration {
  compensationId: string;
  name: string;
  fn: WorkflowContext['registerCompensation'] extends (
    _name: string,
    fn: infer F
  ) => void
    ? F
    : never;
}

export class DeterministicRuntime implements WorkflowContext {
  private activityCounter = 0;
  private timerCounter = 0;
  private compensationCounter = 0;
  readonly compensations: CompensationRegistration[] = [];

  constructor(private readonly host: RuntimeHost) {}

  async activity<T = Json>(
    name: string,
    input: Json = null,
    partialOptions: Partial<ActivityOptions> = {}
  ): Promise<T> {
    this.activityCounter += 1;
    const activityId = `activity-${this.activityCounter}`;
    const options = activityOptions(partialOptions);
    const command: Command = {
      type: 'activity',
      payload: { activityId, activityName: name, input, options } as unknown as Json,
    };
    const commandSeq = this.host.emit(command);
    const terminal = await this.host.activity(command, commandSeq);
    if (terminal.kind === 'completed') return terminal.result as T;
    if (terminal.kind === 'cancelled') {
      throw new CancellationErrorImpl(terminal.reason);
    }
    throw new ActivityFailure(terminal.error);
  }

  async timer(durationMs: number): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(`Invalid timer duration: ${durationMs}`);
    }
    this.timerCounter += 1;
    const timerId = `timer-${this.timerCounter}`;
    const command: Command = {
      type: 'start-timer',
      payload: { timerId, durationMs },
    };
    const commandSeq = this.host.emit(command);
    const result = await this.host.timer(command, commandSeq);
    if (result.cancelled) throw new CancellationErrorImpl(result.reason);
  }

  cancelActivity(activityId: string, reason = 'cancelled by workflow'): void {
    const command: Command = {
      type: 'cancel-activity',
      payload: { activityId, reason },
    };
    const commandSeq = this.host.emit(command);
    this.host.cancelActivity(command, commandSeq);
  }

  cancelTimer(timerId: string, reason = 'timer cancelled by workflow'): boolean {
    const command: Command = {
      type: 'cancel-timer',
      payload: { timerId, reason },
    };
    const commandSeq = this.host.emit(command);
    return this.host.cancelTimer(command, commandSeq);
  }

  registerCompensation(
    name: string,
    fn: CompensationRegistration['fn']
  ): void {
    this.compensationCounter += 1;
    const compensationId = `compensation-${this.compensationCounter}`;
    const command: Command = {
      type: 'register-compensation',
      payload: { compensationId, name },
    };
    this.host.emit(command);
    this.compensations.push({ compensationId, name, fn });
  }

  getVersion(changeId: string, minSupported: number, maxSupported: number): number {
    if (!Number.isInteger(minSupported) || !Number.isInteger(maxSupported)) {
      throw new Error('getVersion versions must be integers');
    }
    if (minSupported > maxSupported) {
      throw new Error(`Unsupported version range for ${changeId}: ${minSupported} > ${maxSupported}`);
    }
    const command: Command = {
      type: 'mark-version',
      payload: { changeId, minSupported, maxSupported, version: maxSupported },
    };
    const commandSeq = this.host.emit(command);
    return this.host.resolveVersion(commandSeq);
  }

  now(): number {
    const commandSeq = this.host.emit({
      type: 'observe-runtime',
      payload: { kind: 'now' },
    });
    return this.host.observeValue(commandSeq, {
      type: 'observe-runtime',
      payload: { kind: 'now' },
    });
  }

  random(): number {
    const commandSeq = this.host.emit({
      type: 'observe-runtime',
      payload: { kind: 'random' },
    });
    return this.host.observeValue(commandSeq, {
      type: 'observe-runtime',
      payload: { kind: 'random' },
    });
  }

  randomInt(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
      throw new Error('randomInt bounds must be integers');
    }
    if (maxExclusive <= minInclusive) {
      throw new Error('randomInt requires maxExclusive > minInclusive');
    }
    const command: Command = {
      type: 'observe-runtime',
      payload: { kind: 'randomInt', min: minInclusive, max: maxExclusive },
    };
    const commandSeq = this.host.emit(command);
    const value = this.host.observeValue(commandSeq, command);
    return minInclusive + (value % (maxExclusive - minInclusive));
  }
}
