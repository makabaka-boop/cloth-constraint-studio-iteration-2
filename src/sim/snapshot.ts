import type { ClothConfig, ClothModel, ClothOp, ClothState, Snapshot } from './types';
import { MAX_STEPS } from './types';

/**
 * 从当前模拟状态构建唯一快照。
 * Canvas 渲染、单步检查面板、JSON 导出都只读取这同一个对象，
 * 杜绝多个时间点的数据互相混用。
 */
export function buildSnapshot(
  config: ClothConfig,
  model: ClothModel,
  state: ClothState,
  ops: readonly ClothOp[],
): Snapshot {
  const n = model.cols * model.rows;
  const nodes = new Array<Snapshot['nodes'][number]>(n);
  const dt = config.dt;
  for (let p = 0; p < n; p++) {
    const i = p * 2;
    nodes[p] = {
      id: p,
      x: state.pos[i],
      y: state.pos[i + 1],
      vx: (state.pos[i] - state.prev[i]) / dt,
      vy: (state.pos[i + 1] - state.prev[i + 1]) / dt,
      pinned: state.pinned[p] === 1,
    };
  }

  const edges = new Array<Snapshot['edges'][number]>(model.edgeCount);
  let tornCount = 0;
  let pinnedCount = 0;
  for (let e = 0; e < model.edgeCount; e++) {
    const torn = state.torn[e] === 1;
    if (torn) tornCount++;
    let strain: number | null = null;
    if (!torn) {
      const ia = model.edgeA[e] * 2;
      const ib = model.edgeB[e] * 2;
      const dx = state.pos[ib] - state.pos[ia];
      const dy = state.pos[ib + 1] - state.pos[ia + 1];
      strain = Math.sqrt(dx * dx + dy * dy) / model.edgeRest[e];
    }
    edges[e] = {
      id: e,
      a: model.edgeA[e],
      b: model.edgeB[e],
      horizontal: model.edgeHorizontal[e] === 1,
      torn,
      strain,
    };
  }
  for (let p = 0; p < n; p++) if (state.pinned[p]) pinnedCount++;

  // 补缝缝线：与边同一快照、同一时间点的数据，含代次（generation）。
  const seams = new Array<Snapshot['seams'][number]>(state.seams.length);
  let activeSeamCount = 0;
  for (let k = 0; k < state.seams.length; k++) {
    const sm = state.seams[k];
    let strain: number | null = null;
    if (!sm.torn) {
      activeSeamCount++;
      const dx = state.pos[sm.b * 2] - state.pos[sm.a * 2];
      const dy = state.pos[sm.b * 2 + 1] - state.pos[sm.a * 2 + 1];
      strain = Math.sqrt(dx * dx + dy * dy) / sm.rest;
    }
    seams[k] = {
      id: sm.id,
      a: sm.a,
      b: sm.b,
      restLength: sm.rest,
      generation: sm.generation,
      createdStep: sm.createdStep,
      torn: sm.torn,
      strain,
    };
  }

  return {
    step: state.step,
    nodes,
    edges,
    seams,
    tornCount,
    pinnedCount,
    activeSeamCount,
    reachedMax: state.step >= MAX_STEPS,
    config,
    ops: ops.slice(),
  };
}

export function serializeSnapshot(s: Snapshot): string {
  return JSON.stringify(s, null, 2);
}
