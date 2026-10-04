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

  // 缝线快照：按 id 升序全部输出（含已再次撕裂的代次），代次 = 同一对端点上的补缝次数。
  // 与原始 edges 同源构建，Canvas / 检查面板 / JSON 导出读到的代次必然一致。
  const pairGen = new Map<number, number>();
  const pairKey = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const stitches: Snapshot['stitches'] = state.stitches.map((st) => {
    const key = pairKey(st.a, st.b);
    const generation = (pairGen.get(key) ?? 0) + 1;
    pairGen.set(key, generation);
    let strain: number | null = null;
    if (!st.torn) {
      const dx = state.pos[st.b * 2] - state.pos[st.a * 2];
      const dy = state.pos[st.b * 2 + 1] - state.pos[st.a * 2 + 1];
      strain = Math.sqrt(dx * dx + dy * dy) / st.restLength;
    }
    return {
      id: st.id,
      generation,
      a: st.a,
      b: st.b,
      restLength: st.restLength,
      torn: st.torn === 1,
      appliedStep: st.appliedStep,
      tornStep: st.tornStep < 0 ? null : st.tornStep,
      strain,
    };
  });
  const activeStitchCount = state.stitches.reduce((acc, st) => acc + (st.torn ? 0 : 1), 0);

  return {
    step: state.step,
    nodes,
    edges,
    stitches,
    tornCount,
    activeStitchCount,
    stitchCount: state.stitches.length,
    pinnedCount,
    reachedMax: state.step >= MAX_STEPS,
    config,
    ops: ops.slice(),
  };
}

export function serializeSnapshot(s: Snapshot): string {
  return JSON.stringify(s, null, 2);
}
