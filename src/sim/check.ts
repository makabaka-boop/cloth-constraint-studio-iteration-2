import { createInitialState, stepOnce } from './cloth';
import { cloneState } from './stepper';
import {
  MAX_STEPS,
  type ClothConfig,
  type ClothModel,
  type ClothOp,
  type ClothState,
} from './types';

export interface CheckItem {
  name: string;
  pass: boolean;
  detail: string;
}

export interface CheckReport {
  pass: boolean;
  step: number;
  items: CheckItem[];
}

function statesEqual(a: ClothState, b: ClothState): boolean {
  if (a.step !== b.step) return false;
  const n = a.pos.length;
  for (let i = 0; i < n; i++) {
    // 严格逐位相等：分批推进不允许任何浮点路径差异。
    if (a.pos[i] !== b.pos[i] || a.prev[i] !== b.prev[i]) return false;
  }
  for (let i = 0; i < a.pinned.length; i++) {
    if (a.pinned[i] !== b.pinned[i]) return false;
  }
  for (let i = 0; i < a.torn.length; i++) {
    if (a.torn[i] !== b.torn[i]) return false;
  }
  return true;
}

/** 按给定批次大小推进，用于一致性核对。 */
function runBatched(
  config: ClothConfig,
  model: ClothModel,
  ops: readonly ClothOp[],
  batches: number[],
): ClothState {
  const state = createInitialState(config, model);
  for (const b of batches) {
    for (let k = 0; k < b; k++) stepOnce(config, model, state, ops);
  }
  return state;
}

function activeMoveTarget(
  ops: readonly ClothOp[],
  node: number,
  s: number,
): { x: number; y: number } | null {
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind !== 'move' || op.node !== node) continue;
    if (s >= op.applyStep && s < op.releaseStep) {
      let x = op.points[0]?.x ?? 0;
      let y = op.points[0]?.y ?? 0;
      for (let q = 0; q < op.points.length; q++) {
        if (op.points[q].step <= s) {
          x = op.points[q].x;
          y = op.points[q].y;
        } else break;
      }
      return { x, y };
    }
    // 释放步自带定位点（暂停态抓起又松手）：该移动同样是操作意图，不算漂移。
    if (s === op.releaseStep && op.releasePinned) {
      for (let q = op.points.length - 1; q >= 0; q--) {
        if (op.points[q].step === s) return { x: op.points[q].x, y: op.points[q].y };
      }
    }
  }
  return null;
}

/**
 * 对 (config, model, ops) 跑完整 600 步并核对：
 * 1. fixedNoDrift  固定点不漂移（仅可被活动 move 操作精确移动）
 * 2. ground        所有节点始终不在地面之下
 * 3. tearMonotonic 撕裂只增不减、不可逆
 * 4. determinism   同一日志不同分批逐位一致
 * 5. cap           不超过 600 步，超步后状态冻结
 */
export function runChecks(
  config: ClothConfig,
  model: ClothModel,
  ops: readonly ClothOp[],
): CheckReport {
  const items: CheckItem[] = [];

  // —— 1/2/3：逐帧推进并记录不变量 ——
  const state = createInitialState(config, model);
  let driftFail = '';
  let groundFail = '';
  let tearFail = '';
  const tornHistory = new Uint8Array(model.edgeCount);
  const nodeCount = model.cols * model.rows;

  while (state.step < MAX_STEPS) {
    const s = state.step;
    const beforeX = new Float64Array(state.pos.length / 2);
    const beforeY = new Float64Array(state.pos.length / 2);
    for (let p = 0; p < nodeCount; p++) {
      beforeX[p] = state.pos[p * 2];
      beforeY[p] = state.pos[p * 2 + 1];
    }

    stepOnce(config, model, state, ops);

    for (let p = 0; p < nodeCount; p++) {
      const x = state.pos[p * 2];
      const y = state.pos[p * 2 + 1];

      if (state.pinned[p]) {
        const target = activeMoveTarget(ops, p, s);
        const ex = target ? target.x : beforeX[p];
        const ey = target ? target.y : beforeY[p];
        if (x !== ex || y !== ey) {
          driftFail = `step ${s} node ${p}: 期望 (${ex},${ey}) 实际 (${x},${y})`;
        }
      }
      if (y > config.groundY) {
        groundFail = `step ${s} node ${p}: y=${y} > groundY=${config.groundY}`;
      }
    }

    for (let e = 0; e < model.edgeCount; e++) {
      if (tornHistory[e] === 1 && state.torn[e] !== 1) {
        tearFail = `step ${s} edge ${e}: 撕裂后被复原`;
      }
      tornHistory[e] = state.torn[e];
    }
    if (driftFail && groundFail && tearFail) break;
  }

  items.push({
    name: 'fixedNoDrift',
    pass: !driftFail,
    detail: driftFail || '600 步内固定点位置逐位精确，仅响应活动 move 操作',
  });
  items.push({
    name: 'ground',
    pass: !groundFail,
    detail: groundFail || `所有节点 y ≤ groundY(${config.groundY})`,
  });
  items.push({
    name: 'tearMonotonic',
    pass: !tearFail,
    detail: tearFail || `撕裂不可逆，最终撕裂边数 ${countTorn(state)}`,
  });

  // —— 4：分批一致性 ——
  // 批次 A：一次性 600 步（带随机感的非均匀拆分由批次 B 承担）。
  const oneShot = runBatched(config, model, ops, [MAX_STEPS]);
  // 批次 B：非均匀拆分，和恰好 600。
  const pattern = [1, 7, 13, 31, 64, 128];
  const sumPattern = pattern.reduce((a, b) => a + b, 0); // 244
  const batches = [...pattern, MAX_STEPS - sumPattern]; // 余下 356 一步
  const batched = runBatched(config, model, ops, batches);
  // 批次 C：每步一批（最细粒度），只比较到一个中间步以控制开销。
  const midStep = 233;
  const fineA = runBatched(
    config, model, ops,
    Array.from({ length: midStep }, () => 1),
  );
  const fineB = runBatched(config, model, ops, [100, 73, 60]);
  const detPass =
    statesEqual(oneShot, state) &&
    statesEqual(batched, oneShot) &&
    statesEqual(fineA, fineB);
  items.push({
    name: 'determinism',
    pass: detPass,
    detail: detPass
      ? `一次性[600] / 非均匀分批${JSON.stringify(batches)} / 逐步[1×233] 三种推进逐位一致`
      : '不同分批的状态存在差异',
  });

  // —— 5：600 步上限 ——
  const frozen = cloneState(oneShot);
  for (let k = 0; k < 5; k++) stepOnce(config, model, oneShot, ops);
  const capPass = oneShot.step === MAX_STEPS && statesEqual(frozen, oneShot);
  items.push({
    name: 'cap',
    pass: capPass,
    detail: capPass ? '达到 600 步后状态冻结' : '超过 600 步后状态仍变化',
  });

  // 顺手确认：用一套独立的标量回放核对最终 pinned 标记与日志语义一致。
  const expectedPinned = expectedFinalPinned(model, ops);
  let pinSemanticsOk = true;
  let pinSemanticsDetail = '';
  for (let p = 0; p < nodeCount; p++) {
    if (expectedPinned[p] !== state.pinned[p]) {
      pinSemanticsOk = false;
      pinSemanticsDetail = `node ${p}: 期望 pinned=${expectedPinned[p]} 实际=${state.pinned[p]}`;
      break;
    }
  }
  items.push({
    name: 'pinSemantics',
    pass: pinSemanticsOk,
    detail: pinSemanticsOk
      ? 'pin/unpin/move（含释放语义）回放与最终固定态一致'
      : pinSemanticsDetail,
  });

  return {
    pass: items.every((i) => i.pass),
    step: state.step,
    items,
  };
}

function countTorn(state: ClothState): number {
  let n = 0;
  for (let i = 0; i < state.torn.length; i++) if (state.torn[i]) n++;
  return n;
}

/**
 * 独立于主模拟的标量回放：只跟踪 pinned 0/1 标记，
 * 验证主模拟最终固定态完全由操作日志决定。
 */
function expectedFinalPinned(model: ClothModel, ops: readonly ClothOp[]): Uint8Array {
  const n = model.cols * model.rows;
  const pinned = new Uint8Array(n);
  for (let k = 0; k < model.initialPins.length; k++) pinned[model.initialPins[k]] = 1;

  for (let s = 0; s < MAX_STEPS; s++) {
    for (const op of ops) {
      if (op.applyStep !== s) continue;
      if (op.kind === 'pin') pinned[op.node] = 1;
      else if (op.kind === 'unpin') pinned[op.node] = 0;
    }
    for (const op of ops) {
      if (op.kind !== 'move') continue;
      if (s >= op.applyStep && s < op.releaseStep) pinned[op.node] = 1;
      else if (s === op.releaseStep) pinned[op.node] = op.releasePinned ? 1 : 0;
    }
  }
  return pinned;
}
