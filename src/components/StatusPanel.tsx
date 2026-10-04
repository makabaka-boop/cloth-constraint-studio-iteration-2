import type { CheckReport } from '../sim/check';
import { serializeSnapshot } from '../sim/snapshot';
import { MAX_STEPS } from '../sim/types';
import type { Snapshot } from '../sim/types';

interface Props {
  snapshot: Snapshot | null;
  hoveredNode: number | null;
  report: CheckReport | null;
  busy: boolean;
  onRunChecks: () => void;
}

export function StatusPanel({ snapshot, hoveredNode, report, busy, onRunChecks }: Props) {
  const node = hoveredNode !== null ? snapshot?.nodes[hoveredNode] ?? null : null;

  const exportJson = () => {
    if (!snapshot) return;
    // 导出的数据与画面、检查同出一源：直接序列化当前唯一快照。
    const blob = new Blob([serializeSnapshot(snapshot)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloth-snapshot-step${snapshot.step}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel">
      <h3>实验状态（单帧检查）</h3>
      {snapshot ? (
        <>
          <div className="stat-row">
            <Stat label="步数" value={`${snapshot.step} / ${MAX_STEPS}`} />
            <Stat label="固定点" value={snapshot.pinnedCount} />
            <Stat label="撕裂边" value={snapshot.tornCount} />
            <Stat label="操作数" value={snapshot.ops.length} />
          </div>
          <div className="progress">
            <div
              className="progress-bar"
              style={{ width: `${(snapshot.step / MAX_STEPS) * 100}%` }}
            />
          </div>

          <h4>节点检查</h4>
          {node ? (
            <table className="kv">
              <tbody>
                <tr><td>节点 id</td><td>{node.id}</td></tr>
                <tr><td>位置 (x, y)</td><td>{fmt(node.x)}, {fmt(node.y)}</td></tr>
                <tr><td>速度 (vx, vy)</td><td>{fmt(node.vx)}, {fmt(node.vy)}</td></tr>
                <tr><td>固定</td><td>{node.pinned ? '是' : '否'}</td></tr>
                <tr><td>地面以下</td><td>{node.y > snapshot.config.groundY ? '⚠ 是' : '否'}</td></tr>
              </tbody>
            </table>
          ) : (
            <p className="hint">将鼠标悬停到任意节点上查看其逐帧状态。</p>
          )}

          <h4>自动化不变量核对</h4>
          <div className="row">
            <button onClick={onRunChecks} disabled={busy}>
              {busy ? '核对中…' : '▶ 对当前操作日志跑 600 步核对'}
            </button>
            <button onClick={exportJson}>⬇ 导出状态 JSON</button>
          </div>
          {report && <ReportView report={report} />}
        </>
      ) : (
        <p className="hint">等待 Worker 初始化…</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

const LABELS: Record<string, string> = {
  fixedNoDrift: '固定点不漂移',
  ground: '地面边界',
  tearMonotonic: '撕裂不可逆',
  determinism: '分批推进一致',
  pinSemantics: '固定/释放语义',
  cap: '600 步上限',
};

function ReportView({ report }: { report: CheckReport }) {
  return (
    <div className={`report ${report.pass ? 'pass' : 'fail'}`}>
      <div className="report-head">
        {report.pass ? '✔ 全部通过' : '✘ 存在失败项'}（重放到第 {report.step} 步）
      </div>
      <ul>
        {report.items.map((it) => (
          <li key={it.name} className={it.pass ? 'ok' : 'bad'}>
            <b>{it.pass ? '✔' : '✘'} {LABELS[it.name] ?? it.name}</b>
            <span>{it.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmt(v: number): string {
  return v.toFixed(3);
}
