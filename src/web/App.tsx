import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ReplayReport, type RunSummary, type WorkflowInfo } from './api.js';
import { EventRow } from './EventRow.js';
import { StatePanel } from './StatePanel.js';
import { projectHistory } from './projection.js';
import type { HistoryEvent } from '../shared/types.js';

const POSITION_KEY = 'trs.playback';
const RUN_KEY = 'trs.selectedRun';

type SavedPositions = Record<string, number>;

function loadPositions(): SavedPositions {
  try {
    return JSON.parse(localStorage.getItem(POSITION_KEY) ?? '{}') as SavedPositions;
  } catch {
    return {};
  }
}

export function App() {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>(() => localStorage.getItem(RUN_KEY) ?? '');
  const [run, setRun] = useState<RunSummary | null>(null);
  const [targetVersion, setTargetVersion] = useState('');
  const [replay, setReplay] = useState<ReplayReport | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positions, setPositions] = useState<SavedPositions>(loadPositions);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  // Initial load.
  useEffect(() => {
    Promise.all([api.listWorkflows(), api.listRuns()]).then(([w, r]) => {
      setWorkflows(w);
      setRuns(r);
      if (!selectedRunId && r.length > 0) setSelectedRunId(r[0].runId);
    }).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load selected run.
  useEffect(() => {
    if (!selectedRunId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    localStorage.setItem(RUN_KEY, selectedRunId);
    api.getRun(selectedRunId).then((r) => {
      if (cancelled) return;
      setRun(r);
      setReplay(null);
      setPlaying(false);
      const wf = workflows.find((x) => x.type === r.workflowType);
      if (wf) setTargetVersion(wf.versions[wf.versions.length - 1]);
    }).catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  const history: HistoryEvent[] = run?.history ?? [];
  const maxSeq = history.length;
  const position = selectedRunId ? positions[selectedRunId] ?? maxSeq : 0;

  const jump = useCallback((seq: number) => {
    if (!selectedRunId) return;
    const clamped = Math.max(1, Math.min(seq, maxSeq || 1));
    setPositions((prev) => {
      const next = { ...prev, [selectedRunId]: clamped };
      localStorage.setItem(POSITION_KEY, JSON.stringify(next));
      return next;
    });
  }, [selectedRunId, maxSeq]);

  // Autoplay.
  useEffect(() => {
    if (!playing || !selectedRunId) return;
    if (position >= maxSeq) {
      setPlaying(false);
      return;
    }
    timerRef.current = window.setTimeout(() => jump(position + 1), 380);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [playing, position, maxSeq, jump, selectedRunId]);

  const projection = useMemo(
    () => (history.length ? projectHistory(history, position) : null),
    [history, position],
  );

  const divergenceSeq = replay?.divergence?.atSeq ?? null;

  const runReplay = useCallback(async () => {
    if (!run || !targetVersion) return;
    setError(null);
    try {
      const report = await api.replay(run.runId, targetVersion);
      setReplay(report);
      if (report.divergence?.atSeq) jump(report.divergence.atSeq);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [run, targetVersion, jump]);

  const workflowVersions = useMemo(
    () => workflows.find((w) => w.type === run?.workflowType)?.versions ?? [],
    [workflows, run?.workflowType],
  );
  const findings = useMemo(() => {
    const w = workflows.find((x) => x.type === run?.workflowType);
    return (w?.findings[targetVersion] ?? []);
  }, [workflows, run?.workflowType, targetVersion]);

  const currentEvent = history.find((e) => e.seq === position) ?? null;

  return (
    <div className="app">
      <div className="topbar">
        <h1>
          Temporal Replay Studio
          <span className="sub">订单履约重放工作台</span>
        </h1>
        <select value={selectedRunId} onChange={(e) => setSelectedRunId(e.target.value)}>
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.workflowType}@{r.version} · {r.status} · {r.eventCount} 事件 · {r.runId.slice(0, 8)}
            </option>
          ))}
        </select>

        <span className="muted">用版本</span>
        <select value={targetVersion} onChange={(e) => setTargetVersion(e.target.value)}>
          {workflowVersions.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <button className="primary" onClick={runReplay} disabled={!run}>
          重放
        </button>
        {replay && <span className={`badge ${replay.status}`}>{statusText(replay.status)}</span>}
        {error && <span style={{ color: 'var(--red)' }}>{error}</span>}
      </div>

      <div className="main">
        <div className="timeline-pane">
          <div className="transport">
            <button onClick={() => setPlaying((p) => !p)} disabled={!run}>
              {playing ? '⏸ 暂停' : '▶ 播放'}
            </button>
            <button onClick={() => jump(position - 1)} disabled={!run || position <= 1}>⏮ 单步后退</button>
            <button onClick={() => jump(position + 1)} disabled={!run || position >= maxSeq}>单步前进 ⏭</button>
            <button onClick={() => jump(1)} disabled={!run}>⏮ 起点</button>
            <button
              className="danger"
              onClick={() => divergenceSeq && jump(divergenceSeq)}
              disabled={!divergenceSeq}
              title="直接跳到第一个分歧点"
            >
              ⚠ 跳到第一个分歧点
            </button>
            <span className="pos" style={{ marginLeft: 'auto' }}>
              {position} / {maxSeq}
            </span>
          </div>
          <div className="timeline">
            {history.map((ev) => (
              <EventRow
                key={ev.seq}
                ev={ev}
                current={ev.seq === position}
                beyond={ev.seq > position}
                marked={ev.seq === divergenceSeq}
                onClick={() => { setPlaying(false); jump(ev.seq); }}
              />
            ))}
            {history.length === 0 && <div className="empty">选择一次运行查看事件时间线</div>}
          </div>
        </div>

        <div className="state-pane">
          {projection && run && (
            <StatePanel
              projection={projection}
              replay={replay}
              findings={findings}
              currentEvent={currentEvent}
            />
          )}
          {!run && <div className="empty">左侧选择一次历史运行，右侧会显示当前状态与待执行命令</div>}
        </div>
      </div>
    </div>
  );
}

function statusText(s: ReplayReport['status']): string {
  if (s === 'matches') return '✓ 重放一致';
  if (s === 'diverges') return '✗ 存在分歧';
  return '历史损坏';
}
