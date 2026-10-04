import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../sim/cloth';
import { MAX_STEPS, type ClothConfig, type ClothOp, type Snapshot } from '../sim/types';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { responseBelongsToEpoch } from './protocol';

/**
 * Worker 端到端测试：用最小的 self 桩在 Node 里驱动真实的 sim.worker 模块，
 * 覆盖 init / advance 分批 / addOps / finishMove / check / epoch 隔离。
 */
function mockSelf() {
  let handler: ((e: MessageEvent) => void) | null = null;
  const responses: WorkerResponse[] = [];
  const selfObj = {
    postMessage: (msg: WorkerResponse) => responses.push(msg),
    set onmessage(fn: ((e: MessageEvent) => void) | null) {
      handler = fn;
    },
    get onmessage() {
      return handler;
    },
  };
  return {
    responses,
    send: (msg: WorkerRequest) =>
      handler!({ data: msg } as MessageEvent<WorkerRequest>),
    selfObj,
  };
}

async function loadWorker() {
  vi.resetModules();
  const harness = mockSelf();
  (globalThis as unknown as { self: unknown }).self = harness.selfObj;
  await import('./sim.worker');
  return harness;
}

let snapshot1: Snapshot;
let snapshot2: Snapshot;

describe('sim worker 协议', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('init 立即回传初始快照（step=0、顶排固定、无撕裂）', async () => {
    const w = await loadWorker();
    w.send({ type: 'init', epoch: 1, config: DEFAULT_CONFIG });
    expect(w.responses).toHaveLength(1);
    const res = w.responses[0];
    expect(res.type).toBe('snapshot');
    if (res.type !== 'snapshot') throw new Error('unreachable');
    expect(res.epoch).toBe(1);
    expect(res.snapshot.step).toBe(0);
    expect(res.snapshot.pinnedCount).toBe(DEFAULT_CONFIG.cols);
    expect(res.snapshot.tornCount).toBe(0);
  });

  it('同一操作日志：单次 advance(600) 与混合分批 advance 得到完全相同快照', async () => {
    const ops: ClothOp[] = [
      { kind: 'unpin', node: 0, applyStep: 12 },
      {
        kind: 'move',
        node: 4,
        applyStep: 20,
        releaseStep: 80,
        releasePinned: true,
        points: [
          { step: 20, x: 300, y: 100 },
          { step: 50, x: 350, y: 140 },
        ],
      },
    ];

    // Worker A：一口气 600 步。
    const wa = await loadWorker();
    wa.send({ type: 'init', epoch: 1, config: DEFAULT_CONFIG });
    wa.send({ type: 'advance', epoch: 1, count: MAX_STEPS, newOps: clone(ops) });
    snapshot1 = lastSnapshot(wa);

    // Worker B：非均匀分批 + 暂停 addOps，交错推进。
    const wb = await loadWorker();
    wb.send({ type: 'init', epoch: 1, config: DEFAULT_CONFIG });
    wb.send({ type: 'advance', epoch: 1, count: 12 });
    wb.send({ type: 'addOps', epoch: 1, newOps: [clone(ops[0])] }); // step 12 暂停施加
    wb.send({ type: 'advance', epoch: 1, count: 8 }); // 到 20
    wb.send({ type: 'addOps', epoch: 1, newOps: [clone(ops[1])] }); // move 在 step20 立即定位
    wb.send({ type: 'advance', epoch: 1, count: 100 });
    wb.send({ type: 'advance', epoch: 1, count: 73 });
    wb.send({ type: 'advance', epoch: 1, count: 407 }); // 合计 12+8+100+73+407=600
    snapshot2 = lastSnapshot(wb);

    expect(snapshot1.step).toBe(MAX_STEPS);
    expect(snapshot2.step).toBe(MAX_STEPS);
    for (let i = 0; i < snapshot1.nodes.length; i++) {
      expect(snapshot2.nodes[i].x).toBe(snapshot1.nodes[i].x);
      expect(snapshot2.nodes[i].y).toBe(snapshot1.nodes[i].y);
    }
    expect(snapshot2.edges.map((e) => e.torn)).toEqual(snapshot1.edges.map((e) => e.torn));
    expect(snapshot2.pinnedCount).toBe(snapshot1.pinnedCount);
  });

  it('check 请求重放完整日志，所有不变量通过', async () => {
    const w = await loadWorker();
    w.send({ type: 'init', epoch: 1, config: DEFAULT_CONFIG });
    w.send({ type: 'advance', epoch: 1, count: 50 });
    w.send({ type: 'check', epoch: 1 });
    const report = w.responses.find((r) => r.type === 'check');
    expect(report).toBeDefined();
    if (report?.type !== 'check') throw new Error('unreachable');
    for (const item of report.report.items) {
      expect(item.pass, `${item.name}: ${item.detail}`).toBe(true);
    }
  });

  it('epoch 防护：旧 epoch 的回帧语义——Worker 拒绝非本 epoch 消息', async () => {
    const w = await loadWorker();
    w.send({ type: 'init', epoch: 7, config: DEFAULT_CONFIG });
    const before = w.responses.length;
    // 伪装成已终止的旧 Worker（epoch=6）的消息：必须被忽略。
    w.send({ type: 'advance', epoch: 6, count: 10 });
    w.send({ type: 'check', epoch: 6 });
    expect(w.responses.length).toBe(before);
    // 当前 epoch 正常工作。
    w.send({ type: 'advance', epoch: 7, count: 5 });
    expect(lastSnapshot(w).step).toBe(5);
  });

  // —— 补缝（mend）协议 ——

  /** 用一条把节点 b 钉远的 move 撕裂垂直边 (0,0)-(1,0)，推进一步。 */
  async function setupTornEdge(cfg: ClothConfig = DEFAULT_CONFIG): Promise<{
    w: Awaited<ReturnType<typeof loadWorker>>;
    a: number;
    b: number;
  }> {
    const w = await loadWorker();
    w.send({ type: 'init', epoch: 1, config: cfg });
    const cols = cfg.cols;
    const a = 0;
    const b = cols; // (1,0)
    const move: ClothOp = {
      kind: 'move', node: b, applyStep: 0, releaseStep: MAX_STEPS + 1,
      releasePinned: null,
      points: [{ step: 0, x: cfg.originX, y: cfg.originY + cfg.spacing * 3 }],
    };
    w.send({ type: 'advance', epoch: 1, count: 1, newOps: [clone(move)] });
    const snap = lastSnapshot(w);
    expect(snap.edges.find((e) => e.a === a && e.b === b)?.torn).toBe(true);
    expect(snap.step).toBe(1);
    return { w, a, b };
  }

  it('mend：在已撕裂边两端生成新身份缝线（静长=生效时距离），快照含代次', async () => {
    const { w, a, b } = await setupTornEdge();
    w.send({ type: 'mend', epoch: 1, a, b });
    const res = w.responses[w.responses.length - 1];
    expect(res.type).toBe('snapshot');
    if (res.type !== 'snapshot') throw new Error('unreachable');
    expect(res.mend).toEqual({ ok: true });
    expect(res.snapshot.stitchCount).toBe(1);
    expect(res.snapshot.activeStitchCount).toBe(1);
    expect(res.snapshot.stitches[0]).toMatchObject({
      id: 0, generation: 1, a, b,
      restLength: DEFAULT_CONFIG.spacing * 3,
      torn: false, appliedStep: 1, tornStep: null,
    });
    // 旧边仍保持 torn（历史不倒改），且补缝进入操作日志（可随重放复现）。
    expect(res.snapshot.edges.find((e) => e.a === a && e.b === b)?.torn).toBe(true);
    expect(res.snapshot.ops.some((o) => o.kind === 'mend')).toBe(true);
  });

  it('mend：未撕裂边 / 非法端点 / 冻结 被拒绝，状态与日志均不变', async () => {
    const cfg: ClothConfig = { ...DEFAULT_CONFIG };
    const w = await loadWorker();
    w.send({ type: 'init', epoch: 1, config: cfg });

    // 未撕裂边 (0,0)-(1,0)
    w.send({ type: 'mend', epoch: 1, a: 0, b: cfg.cols });
    let res = w.responses[w.responses.length - 1];
    expect(res.type).toBe('snapshot');
    if (res.type !== 'snapshot') throw new Error('unreachable');
    expect(res.mend).toEqual({ ok: false, reason: 'edgeNotTorn' });
    expect(res.snapshot.stitchCount).toBe(0);
    expect(res.snapshot.ops).toHaveLength(0);

    // 非法端点
    w.send({ type: 'mend', epoch: 1, a: 0, b: -3 });
    res = w.responses[w.responses.length - 1];
    if (res.type !== 'snapshot') throw new Error('unreachable');
    expect(res.mend).toEqual({ ok: false, reason: 'badEndpoint' });

    // 冻结：把含撕裂边的实验推到 600 步上限后再补缝，必须拒绝。
    const torn = await setupTornEdge(cfg);
    torn.w.send({ type: 'advance', epoch: 1, count: MAX_STEPS - 1 });
    expect(lastSnapshot(torn.w).reachedMax).toBe(true);
    torn.w.send({ type: 'mend', epoch: 1, a: torn.a, b: torn.b });
    res = torn.w.responses[torn.w.responses.length - 1];
    expect(res.type).toBe('snapshot');
    if (res.type !== 'snapshot') throw new Error('unreachable');
    expect(res.mend).toEqual({ ok: false, reason: 'frozen' });
    expect(res.snapshot.stitchCount).toBe(0);
  });

  it('mend：同对端点已有活动缝线时拒绝；缝线再撕裂后允许新一代补缝', async () => {
    const { w, a, b } = await setupTornEdge();
    w.send({ type: 'mend', epoch: 1, a, b }); // 第 1 代
    w.send({ type: 'mend', epoch: 1, a, b }); // 立即再补：拒绝
    let res = w.responses[w.responses.length - 1];
    expect(res.type).toBe('snapshot');
    if (res.type !== 'snapshot') throw new Error('unreachable');
    expect(res.mend).toEqual({ ok: false, reason: 'alreadyStitched' });
    expect(lastSnapshot(w).stitchCount).toBe(1);

    // 把 b 移到 9*spacing：该轨迹点在 step1 帧合并（暂停立即定位），
    // 随后推进的一步（step1→step2）积分中缝线即按阈值断裂。
    w.send({
      type: 'appendMovePoints',
      epoch: 1,
      node: b,
      points: [{ step: 1, x: DEFAULT_CONFIG.originX, y: DEFAULT_CONFIG.originY + DEFAULT_CONFIG.spacing * 9 }],
    });
    w.send({ type: 'advance', epoch: 1, count: 1 });
    const tornSnap = lastSnapshot(w);
    expect(tornSnap.step).toBe(2);
    expect(tornSnap.stitches[0].torn).toBe(true);
    expect(tornSnap.stitches[0].tornStep).toBe(1);

    // 再次补缝：成功，新身份 id=1、第 2 代，旧代次记录保留。
    w.send({ type: 'mend', epoch: 1, a, b });
    res = w.responses[w.responses.length - 1];
    expect(res.type).toBe('snapshot');
    if (res.type !== 'snapshot') throw new Error('unreachable');
    expect(res.mend).toEqual({ ok: true });
    const snap = res.snapshot;
    expect(snap.stitchCount).toBe(2);
    expect(snap.activeStitchCount).toBe(1);
    expect(snap.stitches.map((s) => [s.id, s.generation, s.torn])).toEqual([
      [0, 1, true],
      [1, 2, false],
    ]);
  });

  it('check：含 mend 的完整日志重放，所有不变量（含 stitchIntegrity）通过', async () => {
    const cfg = DEFAULT_CONFIG;
    const cols = cfg.cols;
    const a = 0;
    const b = cols;
    const ops: ClothOp[] = [
      {
        kind: 'move', node: b, applyStep: 0, releaseStep: MAX_STEPS + 1,
        releasePinned: null,
        points: [
          { step: 0, x: cfg.originX, y: cfg.originY + cfg.spacing * 3 },
          { step: 2, x: cfg.originX, y: cfg.originY + cfg.spacing * 9 },
          { step: 3, x: cfg.originX, y: cfg.originY + cfg.spacing * 9 },
        ],
      },
      { kind: 'mend', a, b, applyStep: 1, stitchId: 0, restLength: cfg.spacing * 3 },
      { kind: 'mend', a, b, applyStep: 3, stitchId: 1, restLength: cfg.spacing * 9 },
    ];
    const w = await loadWorker();
    w.send({ type: 'init', epoch: 1, config: cfg });
    w.send({ type: 'advance', epoch: 1, count: MAX_STEPS, newOps: clone(ops) });
    w.send({ type: 'check', epoch: 1 });
    const report = w.responses.find((r) => r.type === 'check');
    if (report?.type !== 'check') throw new Error('missing check report');
    for (const item of report.report.items) {
      expect(item.pass, `${item.name}: ${item.detail}`).toBe(true);
    }
  });

  it('重置后旧帧迟到：旧 Worker（旧 epoch）的 snapshot/check 一律被主线程判定丢弃', async () => {
    // 模拟主线程视角：新实验 epoch=8，旧 Worker 在 terminate 前/后迟到 epoch=7 的帧。
    const currentEpoch = 8;
    const staleSnap: WorkerResponse = {
      type: 'snapshot',
      epoch: 7,
      snapshot: {} as Snapshot,
    };
    const staleCheck: WorkerResponse = {
      type: 'check',
      epoch: 7,
      report: { pass: false, step: 0, items: [] },
    };
    const freshSnap: WorkerResponse = {
      type: 'snapshot',
      epoch: 8,
      snapshot: {} as Snapshot,
    };
    // 同一份判定被主线程（丢弃旧帧）与 Worker（拒绝旧 epoch 消息）共用。
    expect(responseBelongsToEpoch(staleSnap, currentEpoch)).toBe(false);
    expect(responseBelongsToEpoch(staleCheck, currentEpoch)).toBe(false);
    expect(responseBelongsToEpoch(freshSnap, currentEpoch)).toBe(true);

    // 端到端：旧 Worker 实例仍收到旧 epoch 消息也不会产生任何回帧。
    const w = await loadWorker();
    w.send({ type: 'init', epoch: 7, config: DEFAULT_CONFIG });
    const count = w.responses.length;
    w.send({ type: 'mend', epoch: 7, a: 0, b: DEFAULT_CONFIG.cols }); // 当前实验内合法请求
    expect(w.responses.length).toBe(count + 1);
    // 「重置」后该 Worker 收到 epoch=8 的迟到/错位消息：无响应、不影响旧实例状态。
    w.send({ type: 'advance', epoch: 8, count: 10 });
    w.send({ type: 'mend', epoch: 8, a: 0, b: DEFAULT_CONFIG.cols });
    w.send({ type: 'check', epoch: 8 });
    expect(w.responses.length).toBe(count + 1);
  });
});

function lastSnapshot(w: { responses: WorkerResponse[] }): Snapshot {
  for (let i = w.responses.length - 1; i >= 0; i--) {
    const r = w.responses[i];
    if (r.type === 'snapshot') return r.snapshot;
  }
  throw new Error('no snapshot response');
}

function clone<T>(v: T): T {
  return structuredClone(v);
}
