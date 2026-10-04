import {
  MAX_STEPS,
  type ClothConfig,
  type ClothModel,
  type ClothOp,
  type ClothState,
  type MendResult,
  type PinMode,
} from './types';

export const DEFAULT_CONFIG: ClothConfig = {
  cols: 12,
  rows: 10,
  spacing: 36,
  originX: 120,
  originY: 60,
  gravity: 900,
  damping: 0.99,
  stiffness: 1,
  iterations: 4,
  tearFactor: 2.2,
  dt: 1 / 60,
  groundY: 560,
  groundFriction: 0.9,
  canvasWidth: 900,
  canvasHeight: 600,
  pinMode: 'top-row',
};

export function clampNodesPerSide(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.cols;
  return Math.max(8, Math.min(20, Math.round(n)));
}

export function nodeIndex(cols: number, r: number, c: number): number {
  return r * cols + c;
}

/** 根据配置建立网格拓扑（水平边在前、垂直边在后）与初始挂点。 */
export function createClothModel(config: ClothConfig): ClothModel {
  const { cols, rows, spacing, originX, originY, pinMode } = config;
  const horizontalCount = rows * (cols - 1);
  const verticalCount = (rows - 1) * cols;
  const edgeCount = horizontalCount + verticalCount;

  const edgeA = new Int32Array(edgeCount);
  const edgeB = new Int32Array(edgeCount);
  const edgeRest = new Float64Array(edgeCount);
  const edgeHorizontal = new Uint8Array(edgeCount);

  let e = 0;
  // 水平边：每行从左到右。
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      edgeA[e] = nodeIndex(cols, r, c);
      edgeB[e] = nodeIndex(cols, r, c + 1);
      edgeRest[e] = spacing;
      edgeHorizontal[e] = 1;
      e++;
    }
  }
  // 垂直边：每列从上到下。
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows - 1; r++) {
      edgeA[e] = nodeIndex(cols, r, c);
      edgeB[e] = nodeIndex(cols, r + 1, c);
      edgeRest[e] = spacing;
      edgeHorizontal[e] = 0;
      e++;
    }
  }

  const initialPins = computeInitialPins(cols, rows, pinMode);
  void originX;
  void originY;

  return { cols, rows, edgeA, edgeB, edgeRest, edgeHorizontal, edgeCount, initialPins };
}

function computeInitialPins(cols: number, rows: number, mode: PinMode): Int32Array {
  if (mode === 'none') return new Int32Array(0);
  if (mode === 'corners') {
    const pins = new Int32Array(Math.min(4, cols * rows));
    let n = 0;
    pins[n++] = nodeIndex(cols, 0, 0);
    pins[n++] = nodeIndex(cols, 0, cols - 1);
    if (rows > 1) {
      pins[n++] = nodeIndex(cols, rows - 1, 0);
      pins[n++] = nodeIndex(cols, rows - 1, cols - 1);
    }
    return pins.slice(0, n);
  }
  // top-row
  const pins = new Int32Array(cols);
  for (let c = 0; c < cols; c++) pins[c] = nodeIndex(cols, 0, c);
  return pins;
}

/** 创建初始状态：节点静止排布在网格上。 */
export function createInitialState(config: ClothConfig, model: ClothModel): ClothState {
  const n = config.cols * config.rows;
  const pos = new Float64Array(n * 2);
  for (let r = 0; r < config.rows; r++) {
    for (let c = 0; c < config.cols; c++) {
      const i = nodeIndex(config.cols, r, c) * 2;
      pos[i] = config.originX + c * config.spacing;
      pos[i + 1] = config.originY + r * config.spacing;
    }
  }
  const pinned = new Uint8Array(n);
  for (let k = 0; k < model.initialPins.length; k++) pinned[model.initialPins[k]] = 1;
  return {
    pos,
    prev: new Float64Array(pos), // 初始速度为 0
    pinned,
    torn: new Uint8Array(model.edgeCount),
    stitches: [],
    step: 0,
  };
}

/** 找两端点（顺序不敏感）对应的原始边 id；不是任何网格边的端点对返回 -1。 */
export function findOriginalEdge(model: ClothModel, a: number, b: number): number {
  const { edgeA, edgeB, edgeCount } = model;
  for (let e = 0; e < edgeCount; e++) {
    if ((edgeA[e] === a && edgeB[e] === b) || (edgeA[e] === b && edgeB[e] === a)) return e;
  }
  return -1;
}

/** 该端点对之间是否已有活动（未再次撕裂）的缝线。 */
export function hasActiveStitch(state: ClothState, a: number, b: number): boolean {
  for (const st of state.stitches) {
    if (st.torn === 0 && ((st.a === a && st.b === b) || (st.a === b && st.b === a))) return true;
  }
  return false;
}

/**
 * 在当前已提交步 state.step 上准备一条补缝操作（布景师在暂停/播放时请求补缝）。
 *
 * 纯校验 + 静长测量：不修改状态、不写日志。被拒绝时返回 { ok:false, reason }。
 * 通过时返回 mend op —— 它必须在「下一次积分之前」经 applyOpsAtStep 生效；
 * 静长取操作生效时两端的实际距离（在当前步测量，与重放时同一步开始的测量逐位相同）。
 */
export function prepareMendOp(
  model: ClothModel,
  state: ClothState,
  a: number,
  b: number,
): MendResult {
  // 600 步冻结后一律拒绝。
  if (state.step >= MAX_STEPS) return { ok: false, reason: 'frozen' };
  // 非法端点：非整数、越界、选到自身。
  const nodeCount = model.cols * model.rows;
  if (
    !Number.isInteger(a) || !Number.isInteger(b) ||
    a < 0 || b < 0 || a >= nodeCount || b >= nodeCount || a === b
  ) {
    return { ok: false, reason: 'badEndpoint' };
  }
  // 两端点必须是某条「当前已撕裂」原始边的端点。
  const edge = findOriginalEdge(model, a, b);
  if (edge < 0 || state.torn[edge] !== 1) return { ok: false, reason: 'edgeNotTorn' };
  // 同一对端点同时最多一条活动缝线。
  if (hasActiveStitch(state, a, b)) return { ok: false, reason: 'alreadyStitched' };
  // 静长取当前实际距离；零距离（含退化/NaN）拒绝。
  const ia = a * 2;
  const ib = b * 2;
  const dx = state.pos[ib] - state.pos[ia];
  const dy = state.pos[ib + 1] - state.pos[ia + 1];
  const restLength = Math.sqrt(dx * dx + dy * dy);
  if (!(restLength > 0)) return { ok: false, reason: 'zeroDistance' };

  // 缝线身份（代次）= 当前缝线总数；恒按创建顺序追加，再次补缝必为新 id。
  return {
    ok: true,
    op: {
      kind: 'mend',
      a,
      b,
      applyStep: state.step,
      stitchId: state.stitches.length,
      restLength,
    },
  };
}

/**
 * 把第 state.step 步开始时生效的操作施加到状态上。
 * pin / unpin 是瞬时标记；move 在其活动区间内每步把节点钉到目标位置；
 * mend 在生效步生成一条新身份的缝线（静长随日志）。
 * 操作在「积分之前」应用，因此固定点绝不会在该步发生漂移。
 *
 * 对 mend 做防御性重校验（正常路径已由 prepareMendOp 拒绝非法请求）：
 * 冻结、非撕裂边、零距离、端点间已有活动缝线的 mend 一律跳过。
 * 缝线 id 在准备时已按创建顺序确定，重复施加同一条日志幂等（不产生重复缝线），
 * 因此暂停态立即生效一次、之后随推进重放，与从头重放逐位一致。
 */
export function applyOpsAtStep(
  state: ClothState,
  ops: readonly ClothOp[],
  model?: ClothModel,
): void {
  const s = state.step;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.applyStep !== s) continue;
    if (op.kind === 'pin') {
      state.pinned[op.node] = 1;
    } else if (op.kind === 'unpin') {
      state.pinned[op.node] = 0;
    }
  }
  // move 操作的区间与释放单独成趟，固定排在瞬时 pin/unpin 之后（同步冲突时 move 生效）。
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind !== 'move') continue;
    if (s >= op.applyStep && s < op.releaseStep) {
      // 取 step <= s 的最后一个轨迹点（轨迹点按 step 升序）。
      let x = op.points[0]?.x ?? 0;
      let y = op.points[0]?.y ?? 0;
      for (let q = 0; q < op.points.length; q++) {
        if (op.points[q].step <= s) {
          x = op.points[q].x;
          y = op.points[q].y;
        } else break;
      }
      state.pinned[op.node] = 1;
      const i = op.node * 2;
      state.pos[i] = x;
      state.pos[i + 1] = y;
      state.prev[i] = x;
      state.prev[i + 1] = y;
    } else if (s === op.releaseStep) {
      // 释放步若带轨迹点（暂停态在同一冻结步抓起又松手），先把节点定位到终点，
      // 保证实机所见与从初始状态重放完全一致；随后按 releasePinned 决定固定/脱落。
      for (let q = op.points.length - 1; q >= 0; q--) {
        if (op.points[q].step === s) {
          const pt = op.points[q];
          state.pos[op.node * 2] = pt.x;
          state.pos[op.node * 2 + 1] = pt.y;
          state.prev[op.node * 2] = pt.x;
          state.prev[op.node * 2 + 1] = pt.y;
          break;
        }
      }
      state.pinned[op.node] = op.releasePinned ? 1 : 0;
    }
  }
  // mend 固定最后成趟：缝线在 pin/unpin/move 定位完成之后生成，
  // 静长与扫描顺序都不再受同步其他操作扰动。
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind !== 'mend' || op.applyStep !== s) continue;
    applyMend(state, op, model);
  }
}

/** 让一条已校验通过的 mend 日志在当前步生效（追加缝线）；幂等、防御性跳过非法项。 */
function applyMend(
  state: ClothState,
  op: Extract<ClothOp, { kind: 'mend' }>,
  model?: ClothModel,
): void {
  if (state.step >= MAX_STEPS) return;
  const { a, b } = op;
  const nodeCount = state.pinned.length;
  if (a < 0 || b < 0 || a >= nodeCount || b >= nodeCount || a === b) return;
  if (!(op.restLength > 0)) return;
  if (model && (state.torn[findOriginalEdge(model, a, b)] !== 1)) return;
  if (hasActiveStitch(state, a, b)) return;
  // 幂等：同一条 mend 日志重复施加（暂停立即生效 + 之后重放）不得产生第二条缝线。
  for (const st of state.stitches) if (st.id === op.stitchId) return;
  state.stitches.push({
    id: op.stitchId,
    a,
    b,
    restLength: op.restLength,
    torn: 0,
    appliedStep: op.applyStep,
    tornStep: -1,
  });
}

/** 单个时间步：操作 → Verlet 积分 → 约束松弛（含一次性撕裂）→ 地面碰撞。 */
export function stepOnce(
  config: ClothConfig,
  model: ClothModel,
  state: ClothState,
  ops: readonly ClothOp[] = [],
): void {
  if (state.step >= MAX_STEPS) return;

  applyOpsAtStep(state, ops, model);
  integrate(config, state);
  satisfyConstraints(config, model, state);
  collideGround(config, state);

  state.step++;
}

function integrate(config: ClothConfig, state: ClothState): void {
  const { gravity, damping, dt } = config;
  const dt2 = dt * dt;
  const n = state.pinned.length;
  for (let p = 0; p < n; p++) {
    if (state.pinned[p]) continue;
    const i = p * 2;
    const x = state.pos[i];
    const y = state.pos[i + 1];
    const vx = (x - state.prev[i]) * damping;
    const vy = (y - state.prev[i + 1]) * damping;
    state.prev[i] = x;
    state.prev[i + 1] = y;
    state.pos[i] = x + vx + 0 * dt2; // x 方向无外力，保留位置以明确公式
    state.pos[i + 1] = y + vy + gravity * dt2;
  }
}

/**
 * 固定迭代次数的位置型约束（Jakobsen）松弛。
 * 每次迭代顺序固定：先扫全部水平边、再全部垂直边、最后按 id（创建顺序）扫活动缝线。
 * 原始边首次检测到 strain > tearFactor 时标记撕裂（只撕裂一次），
 * 此后所有步骤直接跳过，不再施加该边约束；补缝不倒改该标记。
 *
 * 缝线是独立新身份的约束，静长在补缝生效时固定，之后按同一 tearFactor 阈值断裂：
 * 断裂只置该缝线自己的 torn（并记录撕裂步），删除式跳过，不影响原始边取证。
 */
export function satisfyConstraints(
  config: ClothConfig,
  model: ClothModel,
  state: ClothState,
): void {
  const { iterations, stiffness, tearFactor } = config;
  const { edgeA, edgeB, edgeRest, edgeHorizontal, edgeCount } = model;
  const { pos, prev, pinned, torn, stitches } = state;

  // edgeHorizontal 只有 0/1 两种值，天然分成水平段在前、垂直段在后。
  for (let it = 0; it < iterations; it++) {
    // 先水平边，后垂直边：利用存储顺序（水平在前）。
    let lastHorizontal = 0;
    while (lastHorizontal < edgeCount && edgeHorizontal[lastHorizontal] === 1) lastHorizontal++;

    for (let pass = 0; pass < 2; pass++) {
      const start = pass === 0 ? 0 : lastHorizontal;
      const end = pass === 0 ? lastHorizontal : edgeCount;
      for (let e = start; e < end; e++) {
        if (torn[e]) continue;
        const a = edgeA[e];
        const b = edgeB[e];
        const dist = edgeDistance(pos, a, b);
        if (dist > edgeRest[e] * tearFactor) {
          torn[e] = 1; // 只撕裂一次：之后该边恒被跳过；补缝永不倒改它
          continue;
        }
        if (dist === 0) continue;
        applyCorrection(pos, pinned, a, b, dist, edgeRest[e], stiffness);
      }
    }

    // 第三趟：补缝缝线。位置固定（水平、垂直之后），按 id 升序（数组即创建顺序），
    // 因此缝线的加入不改变任何原始边的扫描次序 —— 旧挂点和旧边行为不变。
    for (let k = 0; k < stitches.length; k++) {
      const st = stitches[k];
      if (st.torn) continue;
      const dist = edgeDistance(pos, st.a, st.b);
      if (dist > st.restLength * tearFactor) {
        st.torn = 1; // 缝线断裂：只动缝线自己的标记，取证轨迹保留
        st.tornStep = state.step;
        continue;
      }
      if (dist === 0) continue;
      applyCorrection(pos, pinned, st.a, st.b, dist, st.restLength, stiffness);
    }
  }
  // prev 不随约束修正改变 —— Verlet 速度（pos-prev）自然吸收约束冲量。
  void prev;
}

/** 两端点当前欧氏距离。 */
function edgeDistance(pos: Float64Array, a: number, b: number): number {
  const ia = a * 2;
  const ib = b * 2;
  const dx = pos[ib] - pos[ia];
  const dy = pos[ib + 1] - pos[ia + 1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** Jakobsen 位置修正：使当前长度回到静止长度，按动度（固定点动度为 0）分配。 */
function applyCorrection(
  pos: Float64Array,
  pinned: Uint8Array,
  a: number,
  b: number,
  dist: number,
  rest: number,
  stiffness: number,
): void {
  const ia = a * 2;
  const ib = b * 2;
  const dx = pos[ib] - pos[ia];
  const dy = pos[ib + 1] - pos[ia + 1];
  const wa = pinned[a] ? 0 : 1;
  const wb = pinned[b] ? 0 : 1;
  const wsum = wa + wb;
  if (wsum === 0) return;
  const m = ((dist - rest) / dist) * stiffness;
  const ca = m * (wa / wsum);
  const cb = m * (wb / wsum);
  pos[ia] += dx * ca;
  pos[ia + 1] += dy * ca;
  pos[ib] -= dx * cb;
  pos[ib + 1] -= dy * cb;
}

/** 水平地面碰撞：位置夹回地面之上，落地速度清零并施加切向摩擦。 */
export function collideGround(config: ClothConfig, state: ClothState): void {
  const { groundY, groundFriction } = config;
  const n = state.pinned.length;
  for (let p = 0; p < n; p++) {
    // 固定点位置逐位精确，地面不改动它（UI 侧已将拖动位置限制在地面之上）。
    if (state.pinned[p]) continue;
    const i = p * 2;
    if (state.pos[i + 1] >= groundY) {
      // 消除法向（竖直）速度分量；切向施加摩擦。
      state.prev[i] = state.pos[i] - (state.pos[i] - state.prev[i]) * groundFriction;
      state.prev[i + 1] = groundY;
      state.pos[i + 1] = groundY;
    }
  }
}
