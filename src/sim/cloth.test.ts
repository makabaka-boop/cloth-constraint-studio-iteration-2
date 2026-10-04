import { describe, expect, it } from 'vitest';
import {
  applyOpsAtStep,
  createClothModel,
  createInitialState,
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
