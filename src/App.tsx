import { useState } from 'react';
import { ClothCanvas } from './components/ClothCanvas';
import { ControlPanel } from './components/ControlPanel';
import { StatusPanel } from './components/StatusPanel';
import { useClothSimulation } from './hooks/useClothSimulation';

export default function App() {
  const cloth = useClothSimulation();
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);

  return (
    <div className="app">
      <header>
        <h1>离线二维布料实验台</h1>
        <p>
          React + TypeScript + Canvas + WebWorker · 固定时间步 Verlet 积分 ·
          水平/垂直边长约束 · 一次性撕裂 · 地面碰撞 · 最多 600 步确定性模拟
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
          />
          <p className="legend">
            <span className="dot pin" /> 固定挂点（橙框）
            <span className="dot free" /> 自由节点
            点击节点：固定/释放 ｜ 拖动节点：移动挂点（拖既有挂点松手后锚定，拖自由节点松手脱落）
            边色：绿→红表示应变，红色虚线为已撕裂边
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
