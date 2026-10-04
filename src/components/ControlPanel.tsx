import { useEffect, useState } from 'react';
import type { ClothConfig, PinMode, Snapshot } from '../sim/types';
import { MAX_STEPS, MIN_NODES_PER_SIDE, MAX_NODES_PER_SIDE } from '../sim/types';

interface Props {
  config: ClothConfig;
  snapshot: Snapshot | null;
  playing: boolean;
  mendMode: boolean;
  mendError: string | null;
  onApplyConfig: (cfg: ClothConfig) => void;
  onTogglePlay: () => void;
  onStep: (count: number) => void;
  onReset: () => void;
  onSetMendMode: (on: boolean) => void;
}

const numberField = (
  label: string,
  value: number,
  set: (v: number) => void,
  opts: { min?: number; max?: number; step?: number; disabled?: boolean } = {},
) => (
  <label className="field">
    <span>{label}</span>
    <input
      type="number"
      value={value}
      min={opts.min}
      max={opts.max}
      step={opts.step}
      disabled={opts.disabled}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) set(v);
      }}
    />
  </label>
);

export function ControlPanel({
  config,
  snapshot,
  playing,
  mendMode,
  mendError,
  onApplyConfig,
  onTogglePlay,
  onStep,
  onReset,
  onSetMendMode,
}: Props) {
  const [draft, setDraft] = useState<ClothConfig>(config);
  const [batch, setBatch] = useState(10);

  // 外部重置（点击「重置」）后把表单同步回实际生效配置。
  useEffect(() => {
    setDraft(config);
  }, [config]);

  const set = <K extends keyof ClothConfig>(key: K, value: ClothConfig[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const apply = () => {
    const cfg: ClothConfig = {
      ...draft,
      cols: clampInt(draft.cols, MIN_NODES_PER_SIDE, MAX_NODES_PER_SIDE),
      rows: clampInt(draft.rows, MIN_NODES_PER_SIDE, MAX_NODES_PER_SIDE),
      spacing: Math.max(8, draft.spacing),
      gravity: draft.gravity,
      damping: Math.max(0, Math.min(1, draft.damping)),
      stiffness: Math.max(0, Math.min(1, draft.stiffness)),
      iterations: clampInt(draft.iterations, 1, 20),
      tearFactor: Math.max(1.01, draft.tearFactor),
      groundFriction: Math.max(0, Math.min(1, draft.groundFriction)),
    };
    setDraft(cfg);
    onApplyConfig(cfg);
  };

  const reachedMax = snapshot?.reachedMax ?? false;

  return (
    <div className="panel">
      <h3>模拟控制</h3>
      <div className="row">
        <button className="primary" onClick={onTogglePlay} disabled={reachedMax}>
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button onClick={() => onStep(1)} disabled={playing || reachedMax}>
          单步 +1
        </button>
        <button onClick={() => onStep(batch)} disabled={playing || reachedMax}>
          推进 {batch} 步
        </button>
        <input
          type="number"
          min={1}
          max={MAX_STEPS}
          value={batch}
          style={{ width: 64 }}
          onChange={(e) => setBatch(Math.max(1, Number(e.target.value) || 1))}
        />
        <button onClick={onReset}>↺ 重置</button>
      </div>
      <div className="row">
        <button
          className={mendMode ? 'primary' : ''}
          onClick={() => onSetMendMode(!mendMode)}
          disabled={reachedMax}
        >
          {mendMode ? '🪡 补缝模式：开' : '🪡 补缝模式'}
        </button>
        {mendMode && (
          <span className="hint" style={{ margin: 0 }}>
            依次点击一条已撕裂边的两个端点
          </span>
        )}
      </div>
      {mendError && <p className="mend-error">✘ {mendError}</p>}
      <p className="hint">
        提示：单步 +1 连续点 600 次与「推进 N 步」分批推进，结果逐位一致。
        补缝会在下一次积分前生成新缝线（静长取两端当前距离），旧撕裂边保留作取证轨迹。
      </p>

      <h3>布料与约束参数</h3>
      <div className="grid2">
        {numberField('水平节点数 (8–20)', draft.cols, (v) => set('cols', v), {
          min: MIN_NODES_PER_SIDE,
          max: MAX_NODES_PER_SIDE,
        })}
        {numberField('垂直节点数 (8–20)', draft.rows, (v) => set('rows', v), {
          min: MIN_NODES_PER_SIDE,
          max: MAX_NODES_PER_SIDE,
        })}
        {numberField('节点间距 px', draft.spacing, (v) => set('spacing', v), { min: 8, step: 2 })}
        {numberField('重力 px/s²', draft.gravity, (v) => set('gravity', v), { step: 50 })}
        {numberField('阻尼 (0–1)', draft.damping, (v) => set('damping', v), {
          min: 0,
          max: 1,
          step: 0.005,
        })}
        {numberField('刚度 (0–1)', draft.stiffness, (v) => set('stiffness', v), {
          min: 0,
          max: 1,
          step: 0.05,
        })}
        {numberField('每步约束迭代', draft.iterations, (v) => set('iterations', v), {
          min: 1,
          max: 20,
        })}
        {numberField('撕裂倍数', draft.tearFactor, (v) => set('tearFactor', v), {
          min: 1.01,
          step: 0.1,
        })}
        {numberField('地面 y', draft.groundY, (v) => set('groundY', v), { step: 10 })}
        {numberField('地面摩擦', draft.groundFriction, (v) => set('groundFriction', v), {
          min: 0,
          max: 1,
          step: 0.05,
        })}
        <label className="field">
          <span>初始挂点</span>
          <select
            value={draft.pinMode}
            onChange={(e) => set('pinMode', e.target.value as PinMode)}
          >
            <option value="top-row">顶排全挂</option>
            <option value="corners">四角</option>
            <option value="none">无</option>
          </select>
        </label>
      </div>
      <button className="primary" onClick={apply}>
        应用参数并重置实验
      </button>
      <p className="hint">
        编辑约束会终止旧 Worker 并以新 epoch 启动新实验，旧帧一律丢弃，不可能覆盖新状态。
      </p>
    </div>
  );
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}
