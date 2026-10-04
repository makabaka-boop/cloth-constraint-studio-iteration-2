import { describe, expect, it } from 'vitest';
import {
  applyOpsAtStep,
  createClothModel,
  createInitialState,
  stepOnce,
  validateMend,
  DEFAULT_CONFIG,
} from './cloth';
import { runChecks } from './check';
import { Stepper, replayOps } from './stepper';
import { buildSnapshot, serializeSnapshot } from './snapshot';
import {
  MAX_STEPS,
  type ClothConfig,
  type ClothModel,
  type ClothOp,
  type ClothState,
} from './types';

function makeConfig(over: Partial<ClothConfig> = {}): ClothConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

function dist(state: ClothState, a: number, b: number): number {
  const dx = state.pos[b * 2] - state.pos[a * 2];
  const dy = state.pos[b * 2 + 1] - state.pos[a * 2 + 1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 手工构造一条确定撕裂的边：顶排固定，把左下角钉到 40 倍间距深处，
 * 下一步最下面那条垂直边 (rows-2,0)-(rows-1,0) 必然超过撕裂倍数。
 * 默认无重力（静止对照便于断言），需要动力学场景时传入 overrides。
 */
function tornEdgeSetup(over: Partial<ClothConfig> = {}) {
  const config = makeConfig({ gravity: 0, ...over });
  const model = createClothModel(config);
  const state = createInitialState(config, model);
  const { cols, rows } = config;
  const corner = (rows - 1) * cols; // 左下角节点
  state.pinned[corner] = 1;
  state.pos[corner * 2] = config.originX;
  state.pos[corner * 2 + 1] = config.originY + config.spacing * 40;
  state.prev[corner * 2] = state.pos[corner * 2];
  state.prev[corner * 2 + 1] = state.pos[corner * 2 + 1];
  const hCount = rows * (cols - 1);
  const edgeId = hCount + (rows - 2); // 垂直边 (rows-2,0)-(rows-1,0)
  stepOnce(config, model, state, []);
  expect(state.torn[edgeId]).toBe(1);
  const a = model.edgeA[edgeId];
  const b = model.edgeB[edgeId];
  return { config, model, state, edgeId, a, b };
}

/** 模拟 Worker 的 mend 路径：先校验，再写日志，最后在当前步立即生效。 */
function mendNow(model: ClothModel, state: ClothState, ops: ClothOp[], a: number, b: number) {
  const rejection = validateMend(model, state, a, b);
  if (rejection) return rejection;
  ops.push({ kind: 'mend', a, b, applyStep: state.step });
  applyOpsAtStep(model, state, ops);
  return null;
}

function expectSameState(x: ClothState, y: ClothState) {
  expect(Array.from(x.pos)).toEqual(Array.from(y.pos));
  expect(Array.from(x.prev)).toEqual(Array.from(y.prev));
  expect(Array.from(x.pinned)).toEqual(Array.from(y.pinned));
  expect(Array.from(x.torn)).toEqual(Array.from(y.torn));
  expect(x.step).toBe(y.step);
  expect(x.seams).toEqual(y.seams);
}

describe('补缝：撕裂后生成新身份缝线', () => {
  it('mend 在当前步、下一次积分前生效；静长取生效时两端实际距离；旧边保持 torn', () => {
    // 重力开启：补缝后缝线真实参与动力学
    const { config, model, state, edgeId, a, b } = tornEdgeSetup({ gravity: 900 });
    const ops: ClothOp[] = [];
    const restExpected = dist(state, a, b);

    expect(mendNow(model, state, ops, a, b)).toBeNull();

    // 新身份缝线：id=0、代次=1、静长=生效时实际距离、创建于当前步
    expect(state.seams).toHaveLength(1);
    const seam = state.seams[0];
    expect(seam.id).toBe(0);
    expect(seam.generation).toBe(1);
    expect(seam.rest).toBe(restExpected);
    expect(seam.createdStep).toBe(1);
    expect(seam.torn).toBe(false);
    expect(seam.a).toBe(a);
    expect(seam.b).toBe(b);
    // 取证轨迹：旧边仍 torn，日志只增一条 mend
    expect(state.torn[edgeId]).toBe(1);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ kind: 'mend', a, b, applyStep: 1 });

    // 继续播放：缝线参与约束（两端距离被保持在静长的撕裂阈值内），且不再撕裂
    const noMend = tornEdgeSetup({ gravity: 900 });
    for (let s = 0; s < 120; s++) {
      stepOnce(config, model, state, ops);
      stepOnce(config, model, noMend.state, []);
    }
    expect(state.seams[0].torn).toBe(false);
    expect(dist(state, a, b)).toBeLessThan(restExpected * config.tearFactor);
    // 缝线确实施加了约束：与未补缝的对照组状态不同
    expect(Array.from(state.pos)).not.toEqual(Array.from(noMend.state.pos));
    // 旧边始终 torn
    expect(state.torn[edgeId]).toBe(1);
  });

  it('快照含缝线代次，Canvas/检查/导出共读同一份；JSON 序列化保留代次', () => {
    const { config, model, state, a, b } = tornEdgeSetup();
    const ops: ClothOp[] = [];
    mendNow(model, state, ops, a, b);
    for (let s = 0; s < 10; s++) stepOnce(config, model, state, ops);

    const snap = buildSnapshot(config, model, state, ops);
    expect(snap.seams).toHaveLength(1);
    expect(snap.seams[0].generation).toBe(1);
    expect(snap.seams[0].restLength).toBe(state.seams[0].rest);
    expect(snap.seams[0].torn).toBe(false);
    expect(snap.activeSeamCount).toBe(1);
    expect(snap.seams[0].strain).not.toBeNull();

    const roundTrip = JSON.parse(serializeSnapshot(snap));
    expect(roundTrip.seams[0].generation).toBe(1);
    expect(roundTrip.seams[0].id).toBe(0);
    expect(roundTrip.ops[0].kind).toBe('mend');
  });
});

describe('补缝：缝线再次撕裂与再次补缝', () => {
  it('缝线按同一阈值断裂且不可逆；再次补缝产生新身份（新 id、代次+1），旧缝线与旧边都保留', () => {
    const { config, model, state, edgeId, a, b } = tornEdgeSetup();
    const ops: ClothOp[] = [];
    mendNow(model, state, ops, a, b);
    const seam1 = state.seams[0];

    // 推进几步（无重力、位置不变），再用 move 把端点 a 拖到 rest*tearFactor 之外一步：
    // 拖动发生在补缝之后的步，缝线应在该步按同一阈值断裂
    for (let s = 0; s < 5; s++) stepOnce(config, model, state, ops);
    const s0 = state.step;
    const bx = state.pos[b * 2];
    const by = state.pos[b * 2 + 1];
    const farX = bx + seam1.rest * config.tearFactor * 2;
    ops.push({
      kind: 'move',
      node: a,
      applyStep: s0,
      releaseStep: s0 + 1,
      releasePinned: false,
      points: [{ step: s0, x: farX, y: by }],
    });
    stepOnce(config, model, state, ops);
    expect(state.seams[0].torn).toBe(true);

    // 断裂不可逆
    for (let s = 0; s < 30; s++) stepOnce(config, model, state, ops);
    expect(state.seams[0].torn).toBe(true);

    // 再次补缝：新 id、代次 2、新静长；旧缝线保持 torn，旧边仍 torn
    const rest2 = dist(state, a, b);
    expect(mendNow(model, state, ops, a, b)).toBeNull();
    expect(state.seams).toHaveLength(2);
    expect(state.seams[0].torn).toBe(true);
    expect(state.seams[1].id).toBe(1);
    expect(state.seams[1].generation).toBe(2);
    expect(state.seams[1].rest).toBe(rest2);
    expect(state.seams[1].torn).toBe(false);
    expect(state.torn[edgeId]).toBe(1);

    // 两条缝线的身份互不复用
    expect(state.seams[1].id).not.toBe(state.seams[0].id);
  });
});

describe('补缝：同一步操作次序', () => {
  it('mend 排在本步 move 之后：静长取移动后的实际距离，与日志书写顺序无关', () => {
    const tear = tornEdgeSetup();
    const { model, edgeId, a, b } = tear;
    const s = tear.state.step;
    const target = { x: 400, y: 200 };
    const moveOp: ClothOp = {
      kind: 'move',
      node: a,
      applyStep: s,
      releaseStep: s + 1,
      releasePinned: false,
      points: [{ step: s, x: target.x, y: target.y }],
    };
    const mendOp: ClothOp = { kind: 'mend', a, b, applyStep: s };

    // 两种日志顺序：move 在前 / mend 在前
    const runWithOps = (ops: ClothOp[]) => {
      const st = tornEdgeSetup().state;
      applyOpsAtStep(model, st, ops);
      return st;
    };
    const st1 = runWithOps([moveOp, mendOp]);
    const st2 = runWithOps([mendOp, moveOp]);

    expectSameState(st1, st2);
    // 静长 = move 定位之后两端 (target, pos_b) 的实际距离
    const expectedRest = Math.hypot(
      target.x - st1.pos[b * 2],
      target.y - st1.pos[b * 2 + 1],
    );
    expect(st1.seams).toHaveLength(1);
    expect(st1.seams[0].rest).toBe(expectedRest);
    expect(st1.torn[edgeId]).toBe(1);
  });

  it('暂停态同一冻结步先补缝后拖动：实机逐步追加与从日志一次重放逐位一致', () => {
    // 实机路径：推进到撕裂 → 暂停 → mend 立即生效 → 同一步又来一个 move → 继续推进
    const tear = tornEdgeSetup();
    const { config, model, a, b } = tear;
    const s = tear.state.step;
    const live = new Stepper(config, model, tear.state, []);
    const mendOp: ClothOp = { kind: 'mend', a, b, applyStep: s };
    live.ops.push(mendOp);
    applyOpsAtStep(model, live.state, live.ops); // mend 先生效（rest=移动前距离）
    const restBeforeMove = live.state.seams[0].rest;

    const moveOp: ClothOp = {
      kind: 'move',
      node: a,
      applyStep: s,
      releaseStep: s + 5,
      releasePinned: true,
      points: [{ step: s, x: 250, y: 120 }],
    };
    live.ops.push(moveOp);
    applyOpsAtStep(model, live.state, live.ops); // 同一步后到的 move：本步缝线重建
    expect(live.state.seams[0].rest).not.toBe(restBeforeMove);
    live.advance(200);

    // 重放路径：同一日志从同一撕裂状态一次性推进相同步数
    const initial = tornEdgeSetup().state;
    const replay = replayOps(
      config,
      model,
      initial,
      [mendOp, moveOp],
      live.state.step - initial.step,
    );
    expectSameState(replay, live.state);
    // 静长取 move 定位后的距离（与重放一致的关键）
    const expectedRest = Math.hypot(
      250 - live.state.pos[b * 2],
      120 - live.state.pos[b * 2 + 1],
    );
    expect(live.state.seams[0].rest).toBe(expectedRest);
  });

  it('同一步 pin/unpin 与 mend 任意交错，结果一致', () => {
    const tear = tornEdgeSetup();
    const { model, a, b } = tear;
    const s = tear.state.step;
    const pinOp: ClothOp = { kind: 'pin', node: b, applyStep: s };
    const mendOp: ClothOp = { kind: 'mend', a, b, applyStep: s };

    const runWithOps = (ops: ClothOp[]) => {
      const st = tornEdgeSetup().state;
      applyOpsAtStep(model, st, ops);
      for (let i = 0; i < 20; i++) stepOnce(tear.config, model, st, ops);
      return st;
    };
    expectSameState(runWithOps([pinOp, mendOp]), runWithOps([mendOp, pinOp]));
  });
});

describe('补缝：非法请求拒绝且不改变状态', () => {
  it('未撕裂边 / 非法端点 / 零距离 / 冻结 / 已有活动缝线分别给出对应拒绝原因', () => {
    const { config, model, state, a, b } = tornEdgeSetup();

    // 未撕裂边：相邻但完好的边
    expect(validateMend(model, state, 0, 1)).toBe('edge-not-torn');
    // 非法端点：不相邻、相同、越界
    expect(validateMend(model, state, 0, 5)).toBe('invalid-endpoints');
    expect(validateMend(model, state, a, a)).toBe('invalid-endpoints');
    expect(validateMend(model, state, -1, b)).toBe('invalid-endpoints');
    expect(validateMend(model, state, a, config.cols * config.rows)).toBe('invalid-endpoints');

    // 零距离：把两端位置压成同一点
    const zero = tornEdgeSetup();
    zero.state.pos[zero.a * 2] = zero.state.pos[zero.b * 2];
    zero.state.pos[zero.a * 2 + 1] = zero.state.pos[zero.b * 2 + 1];
    expect(validateMend(zero.model, zero.state, zero.a, zero.b)).toBe('zero-distance');

    // 已有活动缝线
    const dup = tornEdgeSetup();
    const dupOps: ClothOp[] = [];
    expect(mendNow(dup.model, dup.state, dupOps, dup.a, dup.b)).toBeNull();
    expect(validateMend(dup.model, dup.state, dup.a, dup.b)).toBe('active-seam-exists');

    // 600 步冻结后
    const frozen = tornEdgeSetup();
    for (let s = 0; s < MAX_STEPS; s++) stepOnce(config, model, frozen.state, []);
    expect(frozen.state.step).toBe(MAX_STEPS);
    expect(validateMend(model, frozen.state, a, b)).toBe('frozen');
  });

  it('非法 mend 操作即使进入日志，核心应用时也不改变状态（幂等防御）', () => {
    const { config, model, state, a, b } = tornEdgeSetup();
    const before = {
      pos: Array.from(state.pos),
      prev: Array.from(state.prev),
      pinned: Array.from(state.pinned),
      torn: Array.from(state.torn),
    };
    // 手工塞入非法 mend：未撕裂边、不相邻端点、相同端点
    const ops: ClothOp[] = [
      { kind: 'mend', a: 0, b: 1, applyStep: state.step }, // 边未撕裂
      { kind: 'mend', a: 0, b: 5, applyStep: state.step }, // 不相邻
      { kind: 'mend', a, b: a, applyStep: state.step }, // 相同端点
    ];
    applyOpsAtStep(model, state, ops);
    expect(state.seams).toHaveLength(0);
    expect(Array.from(state.pos)).toEqual(before.pos);
    expect(Array.from(state.prev)).toEqual(before.prev);
    expect(Array.from(state.pinned)).toEqual(before.pinned);
    expect(Array.from(state.torn)).toEqual(before.torn);

    // 零距离：两端压到同一点后，日志里的 mend 同样被跳过
    const zero = tornEdgeSetup();
    zero.state.pos[zero.a * 2] = zero.state.pos[zero.b * 2];
    zero.state.pos[zero.a * 2 + 1] = zero.state.pos[zero.b * 2 + 1];
    applyOpsAtStep(zero.model, zero.state, [
      { kind: 'mend', a: zero.a, b: zero.b, applyStep: zero.state.step },
    ]);
    expect(zero.state.seams).toHaveLength(0);

    // 冻结步：applyStep=600 的 mend 永不生效（stepOnce 不再运行该步）
    const frozen = tornEdgeSetup();
    for (let s = 0; s < MAX_STEPS; s++) stepOnce(config, model, frozen.state, []);
    applyOpsAtStep(model, frozen.state, [
      { kind: 'mend', a, b, applyStep: MAX_STEPS },
    ]);
    expect(frozen.state.seams).toHaveLength(0);

    // 对照：合法 mend 正常生效
    expect(mendNow(model, state, [], a, b)).toBeNull();
    expect(state.seams).toHaveLength(1);
  });
});

describe('补缝：分批推进与重放一致', () => {
  // 低撕裂倍数让边自然撕裂，从运行中发现第一条撕裂边与时刻
  function discoverTear() {
    const config = makeConfig({ tearFactor: 1.15, iterations: 1 });
    const model = createClothModel(config);
    const state = createInitialState(config, model);
    while (state.step < MAX_STEPS) {
      stepOnce(config, model, state, []);
      for (let e = 0; e < model.edgeCount; e++) {
        if (state.torn[e]) {
          return { config, model, edge: e, step: state.step };
        }
      }
    }
    throw new Error('no tear found');
  }

  function buildOps(model: ClothModel, edge: number, t0: number): ClothOp[] {
    const a = model.edgeA[edge];
    const b = model.edgeB[edge];
    return [
      { kind: 'mend', a, b, applyStep: t0 },
      // 把 a 拖远一步，让缝线再次撕裂
      {
        kind: 'move',
        node: a,
        applyStep: t0 + 10,
        releaseStep: t0 + 11,
        releasePinned: false,
        points: [{ step: t0 + 10, x: 30, y: 30 }],
      },
      { kind: 'mend', a, b, applyStep: t0 + 20 }, // 再次补缝 → 新身份
    ];
  }

  it('含补缝/再撕裂/再补缝的日志：一次性 == 非均匀分批 == 逐步，且实机暂停补缝路径 == 重放', () => {
    const { config, model, edge, step: t0 } = discoverTear();
    const ops = buildOps(model, edge, t0);

    const run = (batches: number[]) => {
      const stepper = new Stepper(
        config,
        model,
        createInitialState(config, model),
        ops.map((o) => structuredClone(o)),
      );
      for (const n of batches) stepper.advance(n);
      return stepper.state;
    };

    const one = run([MAX_STEPS]);
    const uneven = run([1, 3, 17, 42, 100, 237, 200]);
    const fine = run(Array.from({ length: MAX_STEPS }, () => 1));
    expectSameState(uneven, one);
    expectSameState(fine, one);

    // 缝线确实生成过两条（撕裂→补缝→再撕裂→再补缝）
    expect(one.seams.length).toBe(2);
    expect(one.seams[0].generation).toBe(1);
    expect(one.seams[1].generation).toBe(2);
    expect(one.seams[0].torn).toBe(true);
    expect(one.seams[1].id).toBe(1);

    // 实机路径：推进到 t0 暂停 → mend 立即生效 → 推进 → 暂停追加 move → 推进 → 再 mend
    const live = new Stepper(config, model, createInitialState(config, model), []);
    live.advance(t0);
    const [mend1, moveOp, mend2] = ops.map((o) => structuredClone(o));
    expect(validateMend(model, live.state, (mend1 as { a: number }).a, (mend1 as { b: number }).b)).toBeNull();
    live.ops.push(mend1);
    applyOpsAtStep(model, live.state, live.ops);
    live.advance(10);
    live.ops.push(moveOp);
    applyOpsAtStep(model, live.state, live.ops);
    live.advance(10);
    live.ops.push(mend2);
    applyOpsAtStep(model, live.state, live.ops);
    live.advance(MAX_STEPS - t0 - 20);
    expectSameState(live.state, one);
  });

  it('runChecks 对含补缝日志全部通过（含缝线不变量）', () => {
    const { config, model, edge, step: t0 } = discoverTear();
    const ops = buildOps(model, edge, t0);
    const report = runChecks(config, model, ops);
    for (const item of report.items) {
      expect(item.pass, `${item.name}: ${item.detail}`).toBe(true);
    }
    expect(report.pass).toBe(true);
    const seamItem = report.items.find((i) => i.name === 'seamIntegrity');
    expect(seamItem).toBeDefined();
  });
});
