import { describe, expect, it } from 'vitest';
import {
  applyOpsAtStep,
  createClothModel,
  createInitialState,
  findOriginalEdge,
  prepareMendOp,
  stepOnce,
  DEFAULT_CONFIG,
} from './cloth';
import { runChecks } from './check';
import { Stepper, cloneState } from './stepper';
import { buildSnapshot } from './snapshot';
import {
  MAX_STEPS,
  MIN_NODES_PER_SIDE,
  MAX_NODES_PER_SIDE,
  type ClothConfig,
  type ClothModel,
  type ClothOp,
} from './types';

function makeConfig(over: Partial<ClothConfig> = {}): ClothConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

function setup(over: Partial<ClothConfig> = {}) {
  const config = makeConfig(over);
  const model = createClothModel(config);
  const state = createInitialState(config, model);
  return { config, model, state };
}

/** 连续推进 n 步。 */
function run(config: ClothConfig, model: ClothModel, state: ReturnType<typeof setup>['state'], ops: ClothOp[], n: number) {
  for (let i = 0; i < n; i++) stepOnce(config, model, state, ops);
}

describe('网格拓扑 8～20 节点', () => {
  it('水平边数 = rows*(cols-1)，垂直边数 = (rows-1)*cols，存储先水平后垂直', () => {
    const { model, config } = setup({ cols: 9, rows: 8 });
    expect(model.edgeCount).toBe(8 * (9 - 1) + (8 - 1) * 9);
    const horizontalCount = 8 * (9 - 1);
    for (let e = 0; e < horizontalCount; e++) expect(model.edgeHorizontal[e]).toBe(1);
    for (let e = horizontalCount; e < model.edgeCount; e++) expect(model.edgeHorizontal[e]).toBe(0);
    expect(config.cols).toBeGreaterThanOrEqual(MIN_NODES_PER_SIDE);
    expect(config.rows).toBeGreaterThanOrEqual(MIN_NODES_PER_SIDE);
    expect(MAX_NODES_PER_SIDE).toBe(20);
  });

  it('最大 20×20 网格边数正确', () => {
    const { model } = setup({ cols: 20, rows: 20 });
    expect(model.edgeCount).toBe(20 * 19 * 2);
  });
});

describe('固定点不漂移', () => {
  it('顶排固定点在重力下 600 步位置逐位不变', () => {
    const { config, model, state } = setup();
    const initialX = new Float64Array(state.pos);
    run(config, model, state, [], MAX_STEPS);
    for (let c = 0; c < config.cols; c++) {
      const i = c * 2; // 顶排
      expect(state.pos[i]).toBe(initialX[i]);
      expect(state.pos[i + 1]).toBe(initialX[i + 1]);
    }
  });

  it('约束松弛永远不移动两个端点都固定的边', () => {
    const { config, model, state } = setup({ gravity: 0 });
    // 把全部节点固定，推进后所有坐标必须逐位不变。
    state.pinned.fill(1);
    const before = new Float64Array(state.pos);
    run(config, model, state, [], 50);
    expect(Array.from(state.pos)).toEqual(Array.from(before));
  });

  it('move 操作期间固定点逐位跟随轨迹点，释放后按 releasePinned 决定', () => {
    const { config, model, state } = setup();
    const node = 0; // 顶排本来就固定
    const ops: ClothOp[] = [
      {
        kind: 'move',
        node,
        applyStep: 10,
        releaseStep: 20,
        releasePinned: true,
        points: [
          { step: 10, x: 200, y: 80 },
          { step: 15, x: 260, y: 90 },
        ],
      },
    ];
    run(config, model, state, ops, 20);
    // 最后一个轨迹点 (step 15) 之后保持在 (260,90)
    expect(state.pos[node * 2]).toBe(260);
    expect(state.pos[node * 2 + 1]).toBe(90);
    expect(state.pinned[node]).toBe(1); // releasePinned=true
  });
});

describe('地面边界', () => {
  it('任意时刻没有节点位于地面之下（含无挂点自由落体场景）', () => {
    const { config, model, state } = setup({ pinMode: 'none' });
    for (let s = 0; s < MAX_STEPS; s++) {
      stepOnce(config, model, state, []);
      for (let p = 0; p < state.pinned.length; p++) {
        expect(state.pos[p * 2 + 1]).toBeLessThanOrEqual(config.groundY);
      }
    }
  });

  it('底排节点最终贴地，布料堆积时上层节点由边约束支撑也不穿透地面', () => {
    const { config, model, state } = setup({ pinMode: 'none' });
    run(config, model, state, [], MAX_STEPS);
    // 底排 12 个节点全部落在地面高度上。
    for (let c = 0; c < config.cols; c++) {
      const p = (config.rows - 1) * config.cols + c;
      expect(state.pos[p * 2 + 1]).toBeCloseTo(config.groundY, 9);
    }
  });
});

describe('撕裂不可逆', () => {
  it('边一旦超过撕裂倍数即标记，后续步骤不再施加该约束且永不恢复', () => {
    // 较小撕裂倍数 + 单次约束迭代：悬垂布料在重力下必然有边被拉长并撕裂。
    const { config, model, state } = setup({ tearFactor: 1.15, iterations: 1 });
    const tornAt = new Int32Array(model.edgeCount).fill(-1);
    for (let s = 0; s < MAX_STEPS; s++) {
      stepOnce(config, model, state, []);
      for (let e = 0; e < model.edgeCount; e++) {
        if (state.torn[e] === 1) {
          if (tornAt[e] === -1) tornAt[e] = s;
        } else {
          expect(tornAt[e]).toBe(-1); // 撕裂过的边不得变回完好
        }
      }
    }
    const anyTorn = Array.from(tornAt).some((t) => t >= 0);
    expect(anyTorn).toBe(true);
  });

  it('撕裂边不产生约束修正：手动构造超两倍边后端点不再受该边拉回', () => {
    const { config, model, state } = setup({ gravity: 0 });
    // 顶排固定，把底排某节点移到很远，下一步拉伸垂直边超过 tearFactor。
    const cols = config.cols;
    const rows = config.rows;
    const node = (rows - 1) * cols; // 左下角
    state.pinned[node] = 1;
    state.pos[node * 2] = config.originX;
    state.pos[node * 2 + 1] = config.originY + config.spacing * 40;
    state.prev[node * 2] = state.pos[node * 2];
    state.prev[node * 2 + 1] = state.pos[node * 2 + 1];
    // 该垂直边 id 位于垂直段：水平段总数 rows*(cols-1)，列 0 第 rows-2 条
    const hCount = rows * (cols - 1);
    const edgeId = hCount + (rows - 2); // (rows-2,0)-(rows-1,0)
    stepOnce(config, model, state, []);
    expect(state.torn[edgeId]).toBe(1);
    const snapshot = buildSnapshot(config, model, state, []);
    expect(snapshot.edges[edgeId].torn).toBe(true);
    expect(snapshot.edges[edgeId].strain).toBeNull();
  });
});

describe('分批推进一致性', () => {
  const ops: ClothOp[] = [
    { kind: 'unpin', node: 2, applyStep: 5 },
    { kind: 'pin', node: 5 * 12 + 6, applyStep: 30 },
    {
      kind: 'move',
      node: 6,
      applyStep: 40,
      releaseStep: 90,
      releasePinned: false,
      points: [
        { step: 40, x: 420, y: 120 },
        { step: 50, x: 460, y: 180 },
        { step: 80, x: 380, y: 240 },
      ],
    },
    { kind: 'unpin', node: 5 * 12 + 6, applyStep: 120 },
  ];

  function states(): { config: ClothConfig; model: ClothModel } {
    const config = makeConfig({});
    const model = createClothModel(config);
    return { config, model };
  }

  function advanceInBatches(batches: number[]) {
    const { config, model } = states();
    const stepper = new Stepper(config, model, createInitialState(config, model), ops.map((o) => structuredClone(o)));
    for (const b of batches) stepper.advance(b);
    return stepper.state;
  }

  it('一次性 600 步 == 非均匀分批 == 逐 1 步', () => {
    const one = advanceInBatches([600]);
    const uneven = advanceInBatches([1, 3, 17, 42, 100, 237, 200]);
    const fine = advanceInBatches(Array.from({ length: 600 }, () => 1));
    for (let i = 0; i < one.pos.length; i++) {
      expect(uneven.pos[i]).toBe(one.pos[i]);
      expect(fine.pos[i]).toBe(one.pos[i]);
      expect(uneven.prev[i]).toBe(one.prev[i]);
      expect(fine.prev[i]).toBe(one.prev[i]);
    }
    expect(Array.from(uneven.torn)).toEqual(Array.from(one.torn));
    expect(Array.from(fine.torn)).toEqual(Array.from(one.torn));
    expect(Array.from(uneven.pinned)).toEqual(Array.from(one.pinned));
  });

  it('每个中间步数上不同分批的快照也相同（边界采样）', () => {
    const targets = [0, 1, 2, 7, 15, 16, 31, 64, 127, 255, 599];
    for (const t of targets) {
      const a = advanceInBatches([t]);
      const parts: number[] = [];
      let remaining = t;
      for (const p of [3, 5, 8, 13]) {
        const take = Math.min(p, remaining);
        if (take > 0) parts.push(take);
        remaining -= take;
      }
      if (remaining > 0) parts.push(remaining);
      const b = advanceInBatches(parts);
      for (let i = 0; i < a.pos.length; i++) expect(b.pos[i]).toBe(a.pos[i]);
      expect(b.step).toBe(t);
    }
  });

  it('Stepper 多次 advance 与单次等价（clone 后对比）', () => {
    const { config, model } = states();
    const s1 = new Stepper(config, model, createInitialState(config, model), ops.map((o) => structuredClone(o)));
    const s2 = new Stepper(config, model, createInitialState(config, model), ops.map((o) => structuredClone(o)));
    s1.advance(600);
    s2.advance(250);
    const saved = cloneState(s2.state);
    s2.advance(350);
    expect(s2.state.pos).toEqual(s1.state.pos);
    expect(saved.step).toBe(250);
  });

  it('暂停态在同一冻结步抓起并松手：实机路径与从初始日志重放逐位一致', () => {
    const config = makeConfig({});
    const model = createClothModel(config);

    // 实机：先推进到第 40 步（冻结在那里），再 addOps 并 applyOpsAtStep（暂停立即生效），
    // 然后继续推进到 600。
    const live = new Stepper(config, model, createInitialState(config, model), []);
    live.advance(40);
    const op: ClothOp = {
      kind: 'move',
      node: 3,
      applyStep: 40,
      releaseStep: 40,
      releasePinned: true,
      points: [{ step: 40, x: 300, y: 50 }],
    };
    live.ops.push(op);
    applyOpsAtStep(live.state, live.ops); // Worker addOps 的暂停路径
    live.advance(560);

    // 重放：同一操作日志一开始就存在，连续 600 步。
    const replay = new Stepper(config, model, createInitialState(config, model), [op]);
    replay.advance(600);

    expect(Array.from(replay.state.pos)).toEqual(Array.from(live.state.pos));
    expect(Array.from(replay.state.prev)).toEqual(Array.from(live.state.prev));
    expect(Array.from(replay.state.pinned)).toEqual(Array.from(live.state.pinned));
    expect(Array.from(replay.state.torn)).toEqual(Array.from(live.state.torn));
    expect(replay.state.pinned[3]).toBe(1);
    expect(replay.state.pos[3 * 2]).toBe(300);
    expect(replay.state.pos[3 * 2 + 1]).toBe(50);
  });

  it('runChecks 端到端核对全部通过', () => {
    const { config, model } = states();
    const report = runChecks(config, model, ops.map((o) => structuredClone(o)));
    for (const item of report.items) {
      expect(item.pass, `${item.name}: ${item.detail}`).toBe(true);
    }
    expect(report.pass).toBe(true);
  });
});

describe('600 步上限', () => {
  it('达到 600 步后继续推进状态冻结', () => {
    const { config, model, state } = setup();
    run(config, model, state, [], MAX_STEPS);
    const frozen = new Float64Array(state.pos);
    const step = new Stepper(config, model, state, []);
    expect(step.advance(50)).toBe(0);
    expect(state.step).toBe(MAX_STEPS);
    expect(Array.from(state.pos)).toEqual(Array.from(frozen));
  });

  it('初始状态快照正确导出 pin / torn 统计', () => {
    const { config, model, state } = setup();
    const snap = buildSnapshot(config, model, state, []);
    expect(snap.step).toBe(0);
    expect(snap.pinnedCount).toBe(config.cols);
    expect(snap.tornCount).toBe(0);
    expect(snap.nodes.length).toBe(config.cols * config.rows);
    expect(snap.nodes[0].vx).toBe(0);
    expect(snap.nodes[0].vy).toBe(0);
  });
});

/**
 * 撕裂一条垂直边：gravity=0、tearFactor=1.8，把 b=(1,0) 钉到 a=(0,0) 正下方
 * 3 倍间距处，推进一步使该边撕裂（a 为顶排挂点，天然固定）。
 * 返回 { edge, a, b, config, model, state }。
 */
function tearAway(over: Partial<ClothConfig> = {}) {
  const { config, model, state } = setup({ gravity: 0, tearFactor: 1.8, ...over });
  const cols = config.cols;
  const rows = config.rows;
  const a = nodeId(0, 0, cols);
  const b = nodeId(1, 0, cols);
  const edge = findOriginalEdge(model, a, b);
  expect(edge).toBe(rows * (cols - 1)); // 垂直段首条：列 0 第 0 条
  state.pinned[b] = 1; // a 顶排本就固定
  place(state, b, config.originX, config.originY + config.spacing * 3);
  stepOnce(config, model, state, []);
  expect(state.torn[edge]).toBe(1);
  return { config, model, state, edge, a, b };
}

function nodeId(r: number, c: number, cols: number): number {
  return r * cols + c;
}

function place(state: ReturnType<typeof setup>['state'], node: number, x: number, y: number) {
  state.pos[node * 2] = x;
  state.pos[node * 2 + 1] = y;
  state.prev[node * 2] = x;
  state.prev[node * 2 + 1] = y;
}

/** 在当前步对 (a,b) 补缝并立即生效（模拟 Worker mend 路径），返回日志 op。 */
function mendNow(
  model: ClothModel,
  state: ReturnType<typeof setup>['state'],
  ops: ClothOp[],
  a: number,
  b: number,
): Extract<ClothOp, { kind: 'mend' }> {
  const result = prepareMendOp(model, state, a, b);
  expect(result.ok).toBe(true);
  const op = result.op!;
  ops.push(op);
  applyOpsAtStep(state, ops, model);
  return op;
}


/**
 * 隔离 b：把 b 的其余两条邻边（水平 (1,0)-(1,1) 与垂直 (1,0)-(2,0)）预先撕掉，
 * 使 b 只通过 (a,b) 一条约束与布料相连 —— 这样它的补缝力学只由缝线决定。
 * 调用时机：原边已撕裂、b 仍钉在远点（a、b 都固定，距离精确已知）。
 */
function isolateB(
  config: ClothConfig,
  model: ClothModel,
  state: ReturnType<typeof setup>['state'],
  b: number,
) {
  const cols = config.cols;
  const horiz = findOriginalEdge(model, b, b + 1)!; // (1,0)-(1,1)
  const vert = findOriginalEdge(model, b, b + cols)!; // (1,0)-(2,0)
  state.torn[horiz] = 1;
  state.torn[vert] = 1;
}

describe('补缝：撕裂 → 新身份缝线', () => {
  it('在已撕裂边两端生成缝线：静长=生效时实际距离，旧边保持 torn', () => {
    const { config, model, state, edge, a, b } = tearAway();
    const ops: ClothOp[] = [];
    const expectedRest = config.spacing * 3;

    const op = mendNow(model, state, ops, a, b);
    expect(op.stitchId).toBe(0);
    expect(op.applyStep).toBe(1);
    expect(op.restLength).toBe(expectedRest);

    expect(state.stitches).toHaveLength(1);
    const st = state.stitches[0];
    expect(st).toMatchObject({
      id: 0, a, b, restLength: expectedRest, torn: 0, appliedStep: 1, tornStep: -1,
    });
    // 旧边仍保持 torn —— 历史不可倒改。
    expect(state.torn[edge]).toBe(1);

    // b 已与其余邻边隔离，释放后只受缝线约束：无重力下必须停在缝线静长上。
    isolateB(config, model, state, b);
    state.pinned[b] = 0;
    for (let k = 0; k < 30; k++) stepOnce(config, model, state, ops);

    const dist = Math.hypot(
      state.pos[b * 2] - state.pos[a * 2],
      state.pos[b * 2 + 1] - state.pos[a * 2 + 1],
    );
    expect(dist).toBeCloseTo(expectedRest, 9); // 刚度 1 × 4 次迭代：逐位收敛
    expect(state.stitches[0].torn).toBe(0);
    expect(state.torn[edge]).toBe(1); // 旧边依旧未复原
  });

  it('快照含缝线代次：Canvas/检查/JSON 导出读同一份 stitches', () => {
    const { config, model, state, a, b } = tearAway();
    const ops: ClothOp[] = [];
    mendNow(model, state, ops, a, b);
    const snap = buildSnapshot(config, model, state, ops);
    expect(snap.stitchCount).toBe(1);
    expect(snap.activeStitchCount).toBe(1);
    expect(snap.stitches).toHaveLength(1);
    expect(snap.stitches[0]).toMatchObject({
      id: 0,
      generation: 1,
      a,
      b,
      restLength: config.spacing * 3,
      torn: false,
      appliedStep: 1,
      tornStep: null,
    });
    // JSON 导出（序列化往返）保留缝线与代次字段。
    const parsed = JSON.parse(JSON.stringify(snap));
    expect(parsed.stitches[0].generation).toBe(1);
    expect(parsed.stitches[0].id).toBe(0);
    expect(parsed.activeStitchCount).toBe(1);
  });

  it('稳定的约束扫描位置：缝线在水平/垂直边之后按 id 追加，活动缝线不扰动旧边求值', () => {
    // 两条路径初始状态逐位相同；base 多一条活动缝线，但 b 始终固定，
    // 因此缝线不产生任何位置修正 —— 两条路径所有节点、旧边撕裂态必须完全相同。
    const base = tearAway();
    const ref = tearAway();
    const ops: ClothOp[] = [];
    mendNow(base.model, base.state, ops, base.a, base.b); // b 仍钉住，缝线存在但惰性
    expect(base.state.pinned[base.b]).toBe(1);
    for (let k = 0; k < 53; k++) {
      stepOnce(base.config, base.model, base.state, ops);
      stepOnce(ref.config, ref.model, ref.state, []);
    }
    expect(Array.from(base.state.pos)).toEqual(Array.from(ref.state.pos));
    expect(Array.from(base.state.prev)).toEqual(Array.from(ref.state.prev));
    expect(Array.from(base.state.torn)).toEqual(Array.from(ref.state.torn));
    expect(base.state.step).toBe(ref.state.step);
  });
});

describe('补缝：再次撕裂与再次补缝（新身份）', () => {
  it('缝线以后仍按 tearFactor 阈值断裂；断裂只动缝线，旧边仍 torn；可再补出新一代', () => {
    const { config, model, state, edge, a, b } = tearAway();
    const ops: ClothOp[] = [];
    mendNow(model, state, ops, a, b); // 第 1 代：静长 3s

    // b 已钉在 3s 处；再移到 9s（3 倍缝线静长 > 2.5），下一步缝线断裂，原始边依旧 torn。
    place(state, b, config.originX, config.originY + config.spacing * 9);
    state.step = 2;
    stepOnce(config, model, state, ops);
    expect(state.step).toBe(3);
    expect(state.stitches[0].torn).toBe(1);
    expect(state.stitches[0].tornStep).toBe(2);
    expect(state.torn[edge]).toBe(1);

    // 再次补缝：必须是新身份（id=1，第 2 代），旧缝线记录保留。
    const result2 = prepareMendOp(model, state, a, b);
    expect(result2.ok).toBe(true);
    expect(result2.op!.stitchId).toBe(1);
    expect(result2.op!.restLength).toBe(config.spacing * 9);
    expect(result2.op!.applyStep).toBe(3);
    ops.push(result2.op!);
    applyOpsAtStep(state, ops, model);

    expect(state.stitches).toHaveLength(2);
    expect(state.stitches[0]).toMatchObject({ id: 0, torn: 1, tornStep: 2, restLength: config.spacing * 3 });
    expect(state.stitches[1]).toMatchObject({ id: 1, torn: 0, tornStep: -1, restLength: config.spacing * 9 });

    const snap = buildSnapshot(config, model, state, ops);
    expect(snap.stitchCount).toBe(2);
    expect(snap.activeStitchCount).toBe(1);
    expect(snap.stitches[0].generation).toBe(1);
    expect(snap.stitches[1].generation).toBe(2);
    expect(snap.stitches[0].tornStep).toBe(2);
    expect(snap.stitches[1].tornStep).toBeNull();
  });

  it('同一对端点之间已有活动缝线时补缝被拒绝，状态与日志不变', () => {
    const { model, state, a, b } = tearAway();
    const ops: ClothOp[] = [];
    mendNow(model, state, ops, a, b);
    const before = cloneState(state);
    const opsBefore = ops.length;

    const again = prepareMendOp(model, state, a, b);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('alreadyStitched');
    expect(prepareMendOp(model, state, b, a).reason).toBe('alreadyStitched'); // 顺序不敏感
    expect(state.stitches.length).toBe(before.stitches.length);
    expect(ops.length).toBe(opsBefore);
    expect(Array.from(state.pos)).toEqual(Array.from(before.pos));
  });
});

describe('补缝：拒绝场景不改变状态或日志', () => {
  it('零距离拒绝', () => {
    const { model, state, a, b } = tearAway();
    place(state, b, state.pos[a * 2], state.pos[a * 2 + 1]); // 两端重合
    const before = cloneState(state);
    const r = prepareMendOp(model, state, a, b);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('zeroDistance');
    expect(state.stitches).toEqual(before.stitches);
    expect(state.pos[b * 2]).toBe(before.pos[b * 2]);
  });

  it('非法端点拒绝（越界 / 自身 / 非整数）', () => {
    const { model, state, a } = tearAway();
    const n = model.cols * model.rows;
    expect(prepareMendOp(model, state, -1, a).reason).toBe('badEndpoint');
    expect(prepareMendOp(model, state, a, n).reason).toBe('badEndpoint');
    expect(prepareMendOp(model, state, a, a).reason).toBe('badEndpoint');
    expect(prepareMendOp(model, state, a, a + 0.5).reason).toBe('badEndpoint');
    expect(state.stitches).toHaveLength(0);
  });

  it('未撕裂边拒绝（含不是任何边的端点对）', () => {
    const { model, state } = setup({ gravity: 0 });
    const cols = model.cols;
    const a = nodeId(0, 0, cols); // 相邻但完好的垂直边
    const b = nodeId(1, 0, cols);
    expect(state.torn[findOriginalEdge(model, a, b)!]).toBe(0);
    expect(prepareMendOp(model, state, a, b).reason).toBe('edgeNotTorn');
    const c = nodeId(1, 1, cols); // 对角点：根本不是网格边
    expect(prepareMendOp(model, state, a, c).reason).toBe('edgeNotTorn');
    expect(state.stitches).toHaveLength(0);
  });

  it('600 步冻结后补缝拒绝；伪造的冻结步 mend 日志也不生效，状态与日志不变', () => {
    const { config, model, state, a, b } = tearAway();
    const ops: ClothOp[] = [];
    while (state.step < MAX_STEPS) stepOnce(config, model, state, ops);
    const frozen = cloneState(state);

    const r = prepareMendOp(model, state, a, b);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('frozen');
    const fake: ClothOp = {
      kind: 'mend', a, b, applyStep: MAX_STEPS, stitchId: 0,
      restLength: config.spacing * 3,
    };
    ops.push(fake);
    applyOpsAtStep(state, ops, model);
    expect(state.stitches).toHaveLength(frozen.stitches.length);
    expect(Array.from(state.pos)).toEqual(Array.from(frozen.pos));
  });
});

describe('补缝：同一步操作次序、重放与分批一致', () => {
  it('同一步连续补两条不同撕裂边：按请求顺序确定 id，立即施加幂等，暂停路径与重放一致', () => {
    const config = makeConfig({ gravity: 0 });
    const model = createClothModel(config);
    const cols = config.cols;
    // 顶排两条垂直边：a0-a? 取 (0,0)-(1,0) 与 (0,1)-(1,1)，上端都是顶排固定点。
    const a0 = nodeId(0, 0, cols), b0 = nodeId(1, 0, cols);
    const a1 = nodeId(0, 1, cols), b1 = nodeId(1, 1, cols);
    function tearBoth() {
      const s = createInitialState(config, model);
      s.pinned[b0] = 1;
      s.pinned[b1] = 1;
      place(s, b0, config.originX, config.originY + config.spacing * 3);
      place(s, b1, config.originX + config.spacing, config.originY + config.spacing * 3);
      stepOnce(config, model, s, []);
      expect(s.torn[findOriginalEdge(model, a0, b0)!]).toBe(1);
      expect(s.torn[findOriginalEdge(model, a1, b1)!]).toBe(1);
      return s;
    }

    // 实机：第 1 步暂停，两条 mend 消息按序到达（每条在 Worker 内即时校验→入日志→生效，
    // 下一条 prepare 时已能看到上一条缝线，故 id 按消息次序确定），随后推进 120 步。
    const live = new Stepper(config, model, tearBoth(), []);
    const r0 = prepareMendOp(model, live.state, a0, b0);
    expect(r0.op!.stitchId).toBe(0);
    live.ops.push(r0.op!);
    applyOpsAtStep(live.state, live.ops, model);
    const r1 = prepareMendOp(model, live.state, a1, b1);
    expect(r1.op!.stitchId).toBe(1);
    live.ops.push(r1.op!);
    applyOpsAtStep(live.state, live.ops, model);
    applyOpsAtStep(live.state, live.ops, model); // 同帧重复施加：幂等，不得多出缝线
    expect(live.state.stitches.map((s) => s.id)).toEqual([0, 1]);
    live.advance(120);

    // 重放：日志一开始就存在，非均匀分批 [13,47,60]（合计 120）到同一终点 121 步。
    const replay = new Stepper(
      config, model, tearBoth(),
      [structuredClone(r0.op!), structuredClone(r1.op!)],
    );
    replay.advance(13);
    replay.advance(47);
    replay.advance(60);

    expect(replay.state.step).toBe(live.state.step);
    expect(Array.from(replay.state.pos)).toEqual(Array.from(live.state.pos));
    expect(Array.from(replay.state.prev)).toEqual(Array.from(live.state.prev));
    expect(Array.from(replay.state.torn)).toEqual(Array.from(live.state.torn));
    expect(Array.from(replay.state.pinned)).toEqual(Array.from(live.state.pinned));
    expect(replay.state.stitches).toEqual(live.state.stitches);
  });

  it('撕裂→补缝→再次撕裂→再次补缝：身份严格递增，一次性[600]与非均匀分批逐位一致', () => {
    const config = makeConfig({ gravity: 0 });
    const model = createClothModel(config);
    const cols = config.cols;
    const a = nodeId(0, 0, cols);
    const b = nodeId(1, 0, cols);
    // 用一条 move 日志确定性地驱动：step0 钉到 3s（原边撕裂），step2 钉到 9s（缝线断裂）。
    const move: ClothOp = {
      kind: 'move', node: b, applyStep: 0, releaseStep: MAX_STEPS + 1,
      releasePinned: null,
      points: [
        { step: 0, x: config.originX, y: config.originY + config.spacing * 3 },
        { step: 2, x: config.originX, y: config.originY + config.spacing * 9 },
        { step: 3, x: config.originX, y: config.originY + config.spacing * 9 },
      ],
    };
    const mend1: ClothOp = {
      kind: 'mend', a, b, applyStep: 1, stitchId: 0, restLength: config.spacing * 3,
    };
    const mend2: ClothOp = {
      kind: 'mend', a, b, applyStep: 3, stitchId: 1, restLength: config.spacing * 9,
    };
    const ops = [move, mend1, mend2].map((o) => structuredClone(o));

    const oneShot = new Stepper(config, model, createInitialState(config, model), ops.map((o) => structuredClone(o)));
    oneShot.advance(MAX_STEPS);

    // 关键中间步核对（纯重放中 applyStep=s 的操作在 s→s+1 这一步开始时施加，
    // 与 pin/move 的冻结帧语义一致；暂停态则靠同帧再 applyOpsAtStep 立即看到，见上一用例）。
    const probe = new Stepper(config, model, createInitialState(config, model), ops.map((o) => structuredClone(o)));
    probe.advance(2); // 完成 step0（原边撕裂）与 step1（第 1 代缝线在该步开始生成，本步仍活动）
    expect(probe.state.step).toBe(2);
    expect(probe.state.stitches.map((s) => [s.id, s.torn])).toEqual([[0, 0]]);
    probe.advance(1); // 完成 step2：缝线在该步积分中按阈值断裂
    expect(probe.state.step).toBe(3);
    expect(probe.state.stitches.map((s) => [s.id, s.torn, s.tornStep])).toEqual([[0, 1, 2]]);
    probe.advance(1); // 完成 step3：第 2 代缝线在该步开始时生成
    expect(probe.state.step).toBe(4);
    expect(probe.state.stitches.map((s) => [s.id, s.torn])).toEqual([[0, 1], [1, 0]]);

    const batched = new Stepper(config, model, createInitialState(config, model), ops.map((o) => structuredClone(o)));
    for (const n of [1, 7, 13, 31, 64, 128, MAX_STEPS - 244]) batched.advance(n);

    expect(oneShot.state.stitches.map((s) => [s.id, s.torn, s.appliedStep, s.tornStep])).toEqual([
      [0, 1, 1, 2],
      [1, 0, 3, -1],
    ]);
    expect(Array.from(batched.state.pos)).toEqual(Array.from(oneShot.state.pos));
    expect(Array.from(batched.state.prev)).toEqual(Array.from(oneShot.state.prev));
    expect(Array.from(batched.state.torn)).toEqual(Array.from(oneShot.state.torn));
    expect(batched.state.stitches).toEqual(oneShot.state.stitches);
  });

  it('runChecks：含撕裂/补缝/再撕裂/再补日志的 600 步不变量全部通过', () => {
    const config = makeConfig({ gravity: 0 });
    const model = createClothModel(config);
    const cols = config.cols;
    const a = nodeId(0, 0, cols);
    const b = nodeId(1, 0, cols);
    const ops: ClothOp[] = [
      {
        kind: 'move', node: b, applyStep: 0, releaseStep: MAX_STEPS + 1,
        releasePinned: null,
        points: [
          { step: 0, x: config.originX, y: config.originY + config.spacing * 3 },
          { step: 2, x: config.originX, y: config.originY + config.spacing * 9 },
          { step: 3, x: config.originX, y: config.originY + config.spacing * 9 },
        ],
      },
      { kind: 'mend', a, b, applyStep: 1, stitchId: 0, restLength: config.spacing * 3 },
      { kind: 'mend', a, b, applyStep: 3, stitchId: 1, restLength: config.spacing * 9 },
    ];
    const report = runChecks(config, model, ops.map((o) => structuredClone(o)));
    for (const item of report.items) {
      expect(item.pass, `${item.name}: ${item.detail}`).toBe(true);
    }
    expect(report.pass).toBe(true);
  });
});
