import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { viewEvents } from '../shared/reducer';
import type {
  ReplayResult,
  RunOptions,
  RunRecord,
  WorkflowDefinitionMeta,
  WorkflowEvent,
} from '../shared/types';
import './styles.css';

interface RunSummary {
  runId: string;
  workflowType: string;
  version: string;
  status: string;
  createdAt: string;
  eventCount: number;
}

const storageKey = (runId: string): string => `trs:position:${runId}`;

function loadPosition(runId: string, max: number): number {
  const raw = window.localStorage.getItem(storageKey(runId));
  const parsed = raw === null ? max : Number(raw);
  if (!Number.isFinite(parsed)) return max;
  return Math.max(0, Math.min(max, Math.trunc(parsed)));
}

function eventTone(event: WorkflowEvent): string {
  if (event.type.includes('Failed') || event.type.includes('TimedOut') || event.type.includes('Discarded')) {
    return 'danger';
  }
  if (event.type.includes('Cancelled') || event.type.includes('Ignored')) return 'warning';
  if (event.type.includes('Completed') || event.type === 'TimerFired') return 'success';
  if (event.type.includes('Scheduled') || event.type.includes('Started')) return 'info';
  return 'muted';
}

function JsonBlock({ value }: { value: unknown }): React.JSX.Element {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export default function App(): React.JSX.Element {
  const [workflows, setWorkflows] = useState<WorkflowDefinitionMeta[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replayVersion, setReplayVersion] = useState('v2');
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState('success');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    api.workflows().then((data) => setWorkflows(data.workflows)).catch(setErrorSafe);
    refreshRuns();
    return () => stopPlayback();
  }, []);

  useEffect(() => {
    if (!run) return;
    window.localStorage.setItem(storageKey(run.runId), String(position));
  }, [run, position]);

  useEffect(() => {
    if (!playing || !run) return;
    timerRef.current = window.setInterval(() => {
      setPosition((current) => {
        if (current >= run.events.length) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 450);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [playing, run]);

  function setErrorSafe(value: unknown): void {
    setError(value instanceof Error ? value.message : String(value));
  }

  function stopPlayback(): void {
    setPlaying(false);
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
  }

  async function refreshRuns(): Promise<void> {
    const data = await api.runs();
    setRuns(data.runs);
  }

  async function selectRun(runId: string): Promise<void> {
    stopPlayback();
    setReplay(null);
    const data = await api.run(runId);
    setRun(data.run);
    setPosition(loadPosition(runId, data.run.events.length));
  }

  async function createRun(): Promise<void> {
    if (!workflows.length) return;
    setBusy(true);
    setError(null);
    try {
      const orderId = `order-${scenario}-${Math.random().toString(36).slice(2, 7)}`;
      const options: RunOptions =
        scenario === 'timeout'
          ? {
              startTimeMs: 1_700_000_000_000,
              activityOverrides: { shipOrder: { behavior: 'timeout' as const } },
            }
          : scenario === 'race-cancel'
            ? {
                startTimeMs: 1_700_000_000_000,
                activityOverrides: {
                  shipOrder: { behavior: 'success' as const, delayMs: 300, race: 'lateCancel' as const },
                },
              }
            : scenario === 'nondeterministic'
              ? { startTimeMs: 1_700_000_000_000 }
              : { startTimeMs: 1_700_000_000_000 };
      const payload =
        scenario === 'nondeterministic'
          ? {
              workflowType: 'nondeterministicDemo',
              version: 'v1',
              input: { orderId },
              options,
            }
          : {
              workflowType: 'orderFulfillment',
              version: 'v1',
              input: { orderId, amount: 4200 },
              options,
            };
      const data = await api.createRun({
        ...payload,
        input: { orderId, amount: 4200 },
      });
      await refreshRuns();
      await selectRun(data.run.runId);
    } catch (cause) {
      setErrorSafe(cause);
    } finally {
      setBusy(false);
    }
  }

  async function runReplay(): Promise<void> {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.replay(run.runId, replayVersion);
      setReplay(data.replay);
      if (data.replay.outcome === 'diverged' && data.replay.divergence) {
        setPosition(data.replay.divergence.seq);
        stopPlayback();
      }
    } catch (cause) {
      setErrorSafe(cause);
    } finally {
      setBusy(false);
    }
  }

  const visibleEvents = useMemo(() => run?.events.slice(0, position) ?? [], [run, position]);
  const state = useMemo(() => viewEvents(visibleEvents), [visibleEvents]);
  const selectedEvent = run && position > 0 ? run.events[position - 1] : null;
  const divergenceSeq = replay?.divergence?.seq ?? null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>订单履约重放工作台</h1>
          <p>比较旧历史与新版本工作流代码发出的确定性命令</p>
        </div>
        <div className="scenario-bar">
          <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
            <option value="success">成功履约历史</option>
            <option value="timeout">活动超时/补偿历史</option>
            <option value="race-cancel">完成与取消竞争</option>
            <option value="nondeterministic">非确定性 API 示例</option>
          </select>
          <button onClick={createRun} disabled={busy}>生成 v1 历史</button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main className="layout">
        <section className="panel timeline-panel">
          <div className="panel-heading">
            <h2>事件时间线</h2>
            <div className="run-picker">
              <select
                value={run?.runId ?? ''}
                onChange={(event) => void selectRun(event.target.value)}
              >
                <option value="" disabled>选择历史</option>
                {runs.map((item) => (
                  <option key={item.runId} value={item.runId}>
                    {item.workflowType} {item.version} · {item.eventCount} events · {item.runId.slice(-6)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="controls">
            <button onClick={() => setPlaying(true)} disabled={!run || playing || position === run?.events.length}>播放</button>
            <button onClick={() => setPlaying(false)} disabled={!playing}>暂停</button>
            <button onClick={() => setPosition((value) => Math.max(0, value - 1))} disabled={!run || position === 0}>单步后退</button>
            <button onClick={() => setPosition((value) => Math.min(run?.events.length ?? 0, value + 1))} disabled={!run || position === run?.events.length}>单步前进</button>
            <button
              onClick={() => divergenceSeq && setPosition(divergenceSeq)}
              disabled={divergenceSeq === null}
            >
              跳到首个分歧{divergenceSeq === null ? '' : ` #${divergenceSeq}`}
            </button>
            <span className="position">{position}/{run?.events.length ?? 0}</span>
          </div>

          <div className="timeline">
            {(run?.events ?? []).map((event) => {
              const consumed = event.seq <= position;
              const isDivergence = replay?.divergence?.seq === event.seq;
              return (
                <button
                  key={event.seq}
                  className={`timeline-item ${consumed ? 'consumed' : 'future'} ${eventTone(event)} ${isDivergence ? 'divergence' : ''}`}
                  onClick={() => {
                    stopPlayback();
                    setPosition(event.seq);
                  }}
                >
                  <span className="seq">#{event.seq}</span>
                  <span className="event-type">{event.type}</span>
                  <span className="event-time">{event.atMs}</span>
                </button>
              );
            })}
            {!run && <div className="empty">生成或选择一段运行历史开始。</div>}
          </div>
        </section>

        <section className="panel state-panel">
          <div className="panel-heading">
            <h2>当前状态与待执行命令</h2>
            {run && <span className={`status ${state.status}`}>{state.status}</span>}
          </div>

          {!run && <div className="empty">左侧选择历史后，这里显示逐步归约出的工作流状态。</div>}

          {run && (
            <>
              <div className="state-grid">
                <div>
                  <h3>待执行活动</h3>
                  {state.pendingActivities.length === 0 && <p className="muted-text">无</p>}
                  {state.pendingActivities.map((activity) => (
                    <div className="card" key={activity.activityId}>
                      <strong>{activity.activityName}</strong>
                      <span>{activity.activityId} · attempt {activity.attempt}</span>
                      <small>timeout {activity.options.startToCloseTimeoutMs}ms · retries {activity.options.maxAttempts}</small>
                    </div>
                  ))}
                </div>
                <div>
                  <h3>待触发计时器</h3>
                  {state.pendingTimers.length === 0 && <p className="muted-text">无</p>}
                  {state.pendingTimers.map((timer) => (
                    <div className="card" key={timer.timerId}>
                      <strong>{timer.timerId}</strong>
                      <span>{timer.durationMs}ms</span>
                      <small>fires at {timer.scheduledForMs}</small>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3>已登记补偿（失败时倒序执行）</h3>
                <div className="chip-row">
                  {state.compensations.length === 0 && <span className="muted-text">无</span>}
                  {state.compensations.map((item) => (
                    <span className="chip" key={item.compensationId}>{item.name}</span>
                  ))}
                </div>
              </div>

              <div>
                <h3>版本标记</h3>
                <JsonBlock value={state.versionMarkers} />
              </div>

              <div>
                <h3>当前事件详情</h3>
                {selectedEvent ? <JsonBlock value={selectedEvent} /> : <p className="muted-text">尚未播放事件。</p>}
              </div>

              <div className="replay-box">
                <h3>重放判定</h3>
                <div className="scenario-bar">
                  <select value={replayVersion} onChange={(event) => setReplayVersion(event.target.value)}>
                    {workflows
                      .filter((item) => item.workflowType === run.workflowType)
                      .map((item) => (
                        <option key={item.version} value={item.version}>{item.version}</option>
                      ))}
                  </select>
                  <button onClick={() => void runReplay()} disabled={busy}>用 {replayVersion} 重放</button>
                </div>

                {replay && (
                  <div className={`replay-result ${replay.outcome}`}>
                    <strong>{replay.outcome}</strong>
                    <span>consumed through #{replay.consumedThroughSeq}</span>
                    {replay.divergence && (
                      <div>
                        <h4>首个分歧点 #{replay.divergence.seq}</h4>
                        <p>{replay.divergence.reason}</p>
                        <div className="diff-grid">
                          <div><h5>历史期望</h5><JsonBlock value={replay.divergence.expected} /></div>
                          <div><h5>新代码实际</h5><JsonBlock value={replay.divergence.actual} /></div>
                        </div>
                        <h5>分歧前后事件</h5>
                        <JsonBlock value={{
                          before: replay.divergence.before,
                          event: replay.divergence.event,
                          after: replay.divergence.after,
                        }} />
                      </div>
                    )}
                    {replay.corruption && (
                      <div>
                        <h4>损坏历史 #{replay.corruption.seq ?? 'EOF'}</h4>
                        <p>{replay.corruption.reason}</p>
                        <JsonBlock value={{
                          before: replay.corruption.before,
                          event: replay.corruption.event,
                          after: replay.corruption.after,
                        }} />
                      </div>
                    )}
                    {replay.determinismViolation && (
                      <div>
                        <h4>确定性违例</h4>
                        <p>{replay.determinismViolation.message}</p>
                        <small>{replay.determinismViolation.source}</small>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
