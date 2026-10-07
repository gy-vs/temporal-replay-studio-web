import type {
  ActivityBehaviour,
  ActivityScheduledEvent,
  Command,
  HistoryEvent,
  ReplayNote,
} from '../../shared/types.js';
import type { MachineHost, PendingActivity, QueuedSignal } from './machine.js';

/**
 * Live host: turns registered activity *behaviours* into terminal signals on
 * the virtual clock. In race mode every terminal signal is queued (even the
 * late ones) — the machine decides the winner and records the dropped ones,
 * so replay must reach exactly the same conclusion.
 */
export class LiveHost implements MachineHost {
  readonly mode = 'live' as const;

  constructor(private behaviours: Record<string, ActivityBehaviour>) {}

  onCommand(_ev: HistoryEvent, _command: Command) {
    return {};
  }
  onRuntimeEvent(_ev: HistoryEvent) {
    return {};
  }
  onActivityScheduled(_ev: ActivityScheduledEvent, _p: PendingActivity) {}
  note(_n: ReplayNote) {}
  onFinished() {
    return {};
  }

  queueCancel(_p: PendingActivity, _attemptNo: number, at: number, queue: (sig: QueuedSignal) => void) {
    queue({ at, kind: 'cancelled' });
  }

  signalsForAttempt(p: PendingActivity, attemptNo: number): QueuedSignal[] {
    const state = p.attempts[attemptNo - 1];
    const behaviour = this.behaviours[p.type];
    if (!behaviour) {
      return [{ at: state.startedAt + 50, kind: 'completed', result: null }];
    }

    if (behaviour.mode === 'succeed') {
      return [
        {
          at: state.startedAt + (behaviour.afterMs ?? 50),
          kind: 'completed',
          result: behaviour.result ?? null,
        },
      ];
    }

    if (behaviour.mode === 'fail') {
      // Only the first attempt fails; configured retries then succeed, which
      // is the common "transient failure" shape. Use mode 'race'/retry 0 for
      // permanent failures.
      if (attemptNo === 1) {
        return [
          { at: state.startedAt + (behaviour.afterMs ?? 50), kind: 'failed', error: behaviour.error },
        ];
      }
      return [{ at: state.startedAt + 50, kind: 'completed', result: null }];
    }

    if (behaviour.mode === 'timeout') {
      const after = behaviour.afterMs ?? p.options.scheduleToCloseTimeoutMs;
      return [{ at: state.startedAt + after, kind: 'timeout' }];
    }

    // race: all signals arrive in the order configured (stable for ties);
    // the machine keeps only the first terminal and ignores the rest.
    if (attemptNo === 1) {
      return behaviour.signals
        .map((s) => ({
          at: s.atMs,
          kind: s.kind,
          ...(s.kind === 'completed' ? { result: s.result ?? null } : {}),
          ...(s.kind === 'failed' ? { error: s.error } : {}),
        }))
        .slice()
        .sort((a, b) => a.at - b.at);
    }
    // Retries of a raced activity settle successfully.
    return [{ at: state.startedAt + 50, kind: 'completed', result: null }];
  }

  backoffAfterFailure(_p: PendingActivity, _attemptNo: number, computed: number): number {
    return computed;
  }
}
