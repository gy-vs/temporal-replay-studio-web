import type {
  ActivityScheduledEvent,
  Command,
  Divergence,
  HistoryEvent,
  ReplayNote,
  VersionMarkerEvent,
} from '../../shared/types.js';
import { deepEqual, eventsEquivalent, type MachineHost, PendingActivity, QueuedSignal } from './machine.js';

interface ReconstructedAttempt {
  /** Signals in history order; ties keep history ordering (first terminal wins). */
  signals: (QueuedSignal & { order: number })[];
  backoffMs?: number;
}

const CONTEXT = 3;

/**
 * Drives the workflow machine from a recorded history instead of from live
 * simulation. Every event the new code produces is matched against the next
 * history event; the first mismatch is returned with surrounding context.
 */
export class ReplayHost implements MachineHost {
  readonly mode = 'replay' as const;
  private cursor = 0;
  private attempts = new Map<string, ReconstructedAttempt>();
  notes: ReplayNote[] = [];
  divergence: Divergence | null = null;

  constructor(private history: HistoryEvent[]) {
    this.indexAttempts();
  }

  private key(activityId: number, attempt: number) {
    return `${activityId}:${attempt}`;
  }

  private indexAttempts() {
    // Signals are read off the attempt's runtime events. ActivityTimedOut is
    // machine-generated (consequence of an exhausted timeout failure) and is
    // therefore not queued.
    let order = 0;
    for (const ev of this.history) {
      switch (ev.type) {
        case 'ActivityCompleted':
          this.put(ev.activityId, ev.attempt, {
            at: ev.at,
            kind: 'completed',
            result: ev.result,
            order: order++,
          });
          break;
        case 'ActivityCancelled':
          this.put(ev.activityId, ev.attempt, {
            at: ev.at,
            kind: 'cancelled',
            error: ev.error,
            order: order++,
          });
          break;
        case 'ActivityAttemptFailed':
          this.record(ev.activityId, ev.attempt).backoffMs = ev.backoffMs;
          if (ev.kind === 'timeout') {
            this.put(ev.activityId, ev.attempt, { at: ev.at, kind: 'timeout', order: order++ });
          } else {
            this.put(ev.activityId, ev.attempt, {
              at: ev.at,
              kind: 'failed',
              error: ev.error,
              order: order++,
            });
          }
          break;
        case 'ActivityTerminalIgnored': {
          // The dropped payload itself is not retained; only kind/time/order
          // matter because it will be dropped again during replay. The
          // recorded vocabulary spells the terminal 'timedout'.
          const kind: QueuedSignal['kind'] = ev.ignored === 'timedout' ? 'timeout' : ev.ignored;
          this.put(ev.activityId, ev.attempt, {
            at: ev.at,
            kind,
            order: order++,
          });
          break;
        }
      }
    }
  }

  private record(activityId: number, attempt: number): ReconstructedAttempt {
    const k = this.key(activityId, attempt);
    let rec = this.attempts.get(k);
    if (!rec) {
      rec = { signals: [] };
      this.attempts.set(k, rec);
    }
    return rec;
  }

  private put(activityId: number, attempt: number, sig: QueuedSignal & { order: number }) {
    this.record(activityId, attempt).signals.push(sig);
  }

  note(n: ReplayNote) {
    this.notes.push(n);
  }

  onActivityScheduled(_ev: ActivityScheduledEvent, _p: PendingActivity) {}

  queueCancel() {
    // Cancellation is already part of the reconstructed attempt signals.
  }

  signalsForAttempt(p: PendingActivity, attemptNo: number): QueuedSignal[] {
    const rec = this.attempts.get(this.key(p.id, attemptNo));
    if (!rec) return [];
    // Earliest first; equal timestamps keep the history's arrival order, which
    // is exactly what determines the winning terminal.
    return rec.signals
      .slice()
      .sort((a, b) => a.at - b.at || a.order - b.order)
      .map(({ order: _order, ...sig }) => sig);
  }

  backoffAfterFailure(p: PendingActivity, attemptNo: number): number {
    return this.attempts.get(this.key(p.id, attemptNo))?.backoffMs ?? 0;
  }

  // ---- event matching ----------------------------------------------------

  private expected(): HistoryEvent | undefined {
    return this.history[this.cursor];
  }

  private buildDivergence(
    message: string,
    actual: Divergence['actual'],
    expectedEvent?: HistoryEvent,
  ): Divergence {
    const pivot = expectedEvent ? this.history.indexOf(expectedEvent) : this.cursor;
    const before = this.history.slice(Math.max(0, pivot - CONTEXT), pivot);
    const after = this.history.slice(pivot, pivot + CONTEXT + 1);
    return {
      atSeq: expectedEvent?.seq ?? this.expected()?.seq ?? null,
      expected: expectedEvent ? { event: expectedEvent } : { pending: this.describeExpected() },
      actual,
      message,
      contextBefore: before,
      contextAfter: after,
    };
  }

  private describeExpected(): string | undefined {
    const e = this.expected();
    return e ? `历史还期望事件 ${e.type}（#${e.seq}）` : '历史已经全部消费完';
  }

  private runtimeActual(ev: HistoryEvent): { kind: 'runtimeEvent'; event: HistoryEvent } {
    return { kind: 'runtimeEvent', event: ev };
  }

  private compare(ev: HistoryEvent): Divergence | null {
    const expected = this.expected();
    if (!expected) {
      return this.buildDivergence(
        `新代码又发出了 ${ev.type}（#${ev.seq}），但历史已经消费完`,
        this.runtimeActual(ev),
      );
    }
    if (ev.type !== expected.type) {
      return this.buildDivergence(
        `命令/事件类型不一致：历史期望 ${expected.type}，新代码发出 ${ev.type}`,
        this.runtimeActual(ev),
        expected,
      );
    }
    if (ev.at !== expected.at) {
      return this.buildDivergence(
        `事件发生时间不一致：历史 t=${expected.at}ms，新代码 t=${ev.at}ms`,
        this.runtimeActual(ev),
        expected,
      );
    }
    if (!eventsEquivalent(ev, expected)) {
      const field = this.firstDifferentField(ev, expected);
      return this.buildDivergence(
        `事件 ${ev.type} 的参数不一致${field ? `（字段 ${field}）` : ''}`,
        this.runtimeActual(ev),
        expected,
      );
    }
    return null;
  }

  private firstDifferentField(a: HistoryEvent, b: HistoryEvent): string | null {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (k === 'seq' || k === 'at') continue;
      if (
        !deepEqual(
          (a as unknown as Record<string, unknown>)[k],
          (b as unknown as Record<string, unknown>)[k],
        )
      )
        return k;
    }
    return null;
  }

  onRuntimeEvent(ev: HistoryEvent) {
    const d = this.compare(ev);
    if (d) return { divergence: d };
    this.cursor++;
    return {};
  }

  onCommand(ev: HistoryEvent, command: Command) {
    // Version markers are the one explicit escape hatch:
    //  - history carries the marker: code takes the historical version
    //    (downgrade walks the old branch; not a divergence)
    //  - history has no marker here: backfill with 0 (oldest) and do not
    //    consume a history position
    if (ev.type === 'VersionMarker') {
      return this.handleVersion(ev as VersionMarkerEvent, command);
    }

    const expected = this.expected();

    // Random VALUES always come from history (the seed may differ); only the
    // presence of the consumption must line up.
    if (ev.type === 'RandomConsumed' && expected?.type === 'RandomConsumed') {
      this.cursor++;
      return { randomValue: expected.value };
    }

    if (!expected) {
      return {
        divergence: this.buildDivergence(
          `新代码发出命令 ${command.kind}，但历史已经消费完`,
          command,
        ),
      };
    }
    if (ev.type !== expected.type) {
      return {
        divergence: this.buildDivergence(
          `命令类型不一致：历史期望 ${expected.type}，新代码发出命令 ${command.kind}（${ev.type}）`,
          command,
          expected,
        ),
      };
    }
    if (ev.at !== expected.at) {
      return {
        divergence: this.buildDivergence(
          `命令发生时间不一致：历史 t=${expected.at}ms，新代码 t=${ev.at}ms`,
          command,
          expected,
        ),
      };
    }
    if (!eventsEquivalent(ev, expected)) {
      const field = this.firstDifferentField(ev, expected);
      return {
        divergence: this.buildDivergence(
          `命令参数不一致${field ? `（字段 ${field}）` : ''}：历史期望的 ${ev.type} 与新代码发出的不同`,
          command,
          expected,
        ),
      };
    }
    this.cursor++;
    return {};
  }

  private handleVersion(ev: VersionMarkerEvent, command: Command) {
    const expected = this.expected();
    if (expected && expected.type === 'VersionMarker') {
      if (expected.changeId === ev.changeId) {
        if (expected.version > ev.version) {
          return {
            divergence: this.buildDivergence(
              `版本标记 ${ev.changeId}：历史记录版本 ${expected.version} 比当前代码版本 ${ev.version} 更新，旧代码无法重放更新版本的历史`,
              command,
              expected,
            ),
          };
        }
        this.cursor++;
        if (expected.version < ev.version) {
          this.notes.push({
            seq: expected.seq,
            kind: 'versionDowngrade',
            message: `版本标记 ${ev.changeId}：历史版本 ${expected.version}，当前代码 ${ev.version}，按历史走旧分支（不算分歧）`,
          });
        }
        return { versionValue: expected.version };
      }
      // A different change's marker sits in history: it predates this change,
      // so backfill the oldest version without consuming it.
    }

    // No marker (or an unrelated marker) in history: this change didn't exist
    // when history was made.
    this.notes.push({
      seq: expected?.seq ?? this.history[this.history.length - 1]?.seq ?? 0,
      kind: 'versionBackfill',
      message: `版本标记 ${ev.changeId} 在历史中不存在，回填最旧版本 0（走旧分支，不消费历史位置）`,
    });
    return { versionValue: 0, skip: true };
  }

  onFinished() {
    if (this.cursor < this.history.length) {
      const expected = this.history[this.cursor];
      return {
        divergence: this.buildDivergence(
          `新代码提前结束，但历史还剩 ${this.history.length - this.cursor} 个事件未被消费`,
          { kind: 'none' },
          expected,
        ),
      };
    }
    return {};
  }
}

