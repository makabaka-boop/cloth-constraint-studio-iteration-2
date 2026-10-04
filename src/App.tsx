import { useEffect, useState } from 'react';
import { ClothCanvas } from './components/ClothCanvas';
import { ControlPanel } from './components/ControlPanel';
import { StatusPanel } from './components/StatusPanel';
import { useClothSimulation } from './hooks/useClothSimulation';
import type { MendRejectReason } from './sim/types';

const REJECT_TEXT: Record<MendRejectReason, string> = {
  frozen: '已达 600 步冻结，不能补缝',
  badEndpoint: '端点非法',
  edgeNotTorn: '只能选择当前已撕裂边的两个端点',
  zeroDistance: '两端点距离为零，无法建立缝线',
  alreadyStitched: '这对端点之间已有活动缝线',
};

export default function App() {
  const cloth = useClothSimulation();
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);

  // 补缝反馈短暂展示后自动清除。
  useEffect(() => {
    if (!cloth.mendNotice) return;
    const t = setTimeout(() => cloth.clearMendNotice(), 2600);
    return () => clearTimeout(t);
  }, [cloth.mendNotice, cloth.clearMendNotice]);

  return (
    <div className="app">
      <header>
        <h1>离线二维布料实验台</h1>
        <p>
          React + TypeScript + Canvas + WebWorker · 固定时间步 Verlet 积分 ·
          水平/垂直边长约束 · 一次性撕裂与补缝缝线（新身份/新代次）· 地面碰撞 · 最多 600 步确定性模拟
        </p>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <ControlPanel
            config={cloth.config}
            snapshot={cloth.snapshot}
            playing={cloth.playing}
            onApplyConfig={(cfg) => cloth.reset(cfg)}
            onTogglePlay={cloth.togglePlay}
            onStep={cloth.step}
            onReset={() => cloth.reset()}
          />
        </aside>
        <main className="stage">
          <ClothCanvas
            snapshot={cloth.snapshot}
            onTogglePin={cloth.togglePin}
            onBeginDrag={cloth.beginDrag}
            onUpdateDrag={cloth.updateDrag}
            onEndDrag={cloth.endDrag}
            onHover={setHoveredNode}
            onMend={cloth.mend}
          />
          {cloth.mendNotice && (
            <p className={`mend-notice ${cloth.mendNotice.ok ? 'ok' : 'bad'}`}>
              {cloth.mendNotice.ok
                ? `✔ 已在第 ${cloth.mendNotice.step} 步补缝（下一次积分前生效，新缝线身份）`
                : `✘ 补缝被拒绝：${cloth.mendNotice.reason ? REJECT_TEXT[cloth.mendNotice.reason] : ''}（状态与日志未改变）`}
            </p>
          )}
          <p className="legend">
            <span className="dot pin" /> 固定挂点（橙框）
            <span className="dot free" /> 自由节点
            点击节点：固定/释放 ｜ 拖动节点：移动挂点（拖既有挂点松手后锚定，拖自由节点松手脱落）
            ｜ <b>点击红色虚线撕裂边：当前步补缝</b>（青线为缝线，橙虚线为再撕裂代次）
            边色：绿→红表示应变，缝线以后仍按撕裂倍数断裂
          </p>
        </main>
        <aside className="sidebar">
          <StatusPanel
            snapshot={cloth.snapshot}
            hoveredNode={hoveredNode}
            report={cloth.report}
            busy={cloth.busy}
            onRunChecks={cloth.runChecks}
          />
        </aside>
      </div>
    </div>
  );
}
