import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../sim/cloth';
import { MAX_STEPS, type ClothOp, type Snapshot } from '../sim/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

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
    w.send({ type: 'mend', epoch: 6, a: 0, b: 1 });
    expect(w.responses.length).toBe(before);
    // 当前 epoch 正常工作。
    w.send({ type: 'advance', epoch: 7, count: 5 });
    expect(lastSnapshot(w).step).toBe(5);
  });

  it('重置后旧帧迟到：旧 Worker 的迟到回帧带旧 epoch，主线程据此丢弃，新实验不受影响', async () => {
    // 旧实验：epoch 1，推进若干步并产生操作日志。
    const oldWorker = await loadWorker();
    oldWorker.send({ type: 'init', epoch: 1, config: DEFAULT_CONFIG });
    oldWorker.send({ type: 'advance', epoch: 1, count: 30 });

    // 重置 = 新 Worker + 新 epoch（主线程 terminate 旧 Worker，这里保留它模拟迟到帧）。
    const fresh = await loadWorker();
    fresh.send({ type: 'init', epoch: 2, config: DEFAULT_CONFIG });

    // 旧 Worker 的迟到回帧（advance / mend 拒绝）都携带旧 epoch：
    // 主线程的 epoch 过滤（res.epoch !== epochRef.current）会丢弃它们。
    oldWorker.send({ type: 'advance', epoch: 1, count: 5 });
    oldWorker.send({ type: 'mend', epoch: 1, a: 0, b: 1 });
    const late = oldWorker.responses.slice(-2);
    expect(late.every((r) => r.epoch === 1)).toBe(true);

    // 新实验未被污染：步数 0、无操作、无缝线。
    const snap = lastSnapshot(fresh);
    expect(snap.step).toBe(0);
    expect(snap.ops).toHaveLength(0);
    expect(snap.seams).toHaveLength(0);
    expect(fresh.responses.every((r) => r.epoch === 2)).toBe(true);
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

describe('sim worker 补缝协议', () => {
  /** 易撕裂配置：推进到出现第一条撕裂边，返回其端点。 */
  async function workerWithTornEdge() {
    const w = await loadWorker();
    const config = { ...DEFAULT_CONFIG, tearFactor: 1.15, iterations: 1 };
    w.send({ type: 'init', epoch: 1, config });
    let snap = lastSnapshot(w);
    while (snap.tornCount === 0 && !snap.reachedMax) {
      w.send({ type: 'advance', epoch: 1, count: 10 });
      snap = lastSnapshot(w);
    }
    const edge = snap.edges.find((e) => e.torn);
    if (!edge) throw new Error('no torn edge');
    return { w, snap, edge };
  }

  it('mend 接受：生成含代次的新缝线，旧边保持 torn，日志追加一条 mend', async () => {
    const { w, snap, edge } = await workerWithTornEdge();
    const opsBefore = snap.ops.length;
    w.send({ type: 'mend', epoch: 1, a: edge.a, b: edge.b });
    const res = w.responses[w.responses.length - 1];
    expect(res.type).toBe('snapshot');
    const after = lastSnapshot(w);
    expect(after.seams).toHaveLength(1);
    expect(after.seams[0].generation).toBe(1);
    expect(after.seams[0].id).toBe(0);
    expect(after.seams[0].a).toBe(edge.a);
    expect(after.seams[0].b).toBe(edge.b);
    expect(after.seams[0].restLength).toBeGreaterThan(0);
    expect(after.activeSeamCount).toBe(1);
    // 取证：旧边仍 torn，日志只多一条 mend
    expect(after.edges[edge.id].torn).toBe(true);
    expect(after.ops).toHaveLength(opsBefore + 1);
    expect(after.ops[after.ops.length - 1]).toEqual({
      kind: 'mend',
      a: edge.a,
      b: edge.b,
      applyStep: snap.step,
    });

    // 继续播放：缝线出现在后续每一帧快照里
    w.send({ type: 'advance', epoch: 1, count: 20 });
    expect(lastSnapshot(w).seams).toHaveLength(1);
  });

  it('同一消息序列两个 Worker 的含缝线快照逐位一致', async () => {
    const first = await workerWithTornEdge();
    const second = await workerWithTornEdge();
    expect(second.edge.id).toBe(first.edge.id);
    for (const w of [first.w, second.w]) {
      w.send({ type: 'mend', epoch: 1, a: first.edge.a, b: first.edge.b });
      w.send({ type: 'advance', epoch: 1, count: 137 });
    }
    const s1 = lastSnapshot(first.w);
    const s2 = lastSnapshot(second.w);
    expect(s2.seams).toEqual(s1.seams);
    expect(s2.nodes.map((n) => [n.x, n.y])).toEqual(s1.nodes.map((n) => [n.x, n.y]));
    expect(s2.edges.map((e) => e.torn)).toEqual(s1.edges.map((e) => e.torn));
  });

  it('mend 拒绝：未撕裂边 / 非法端点 / 已有活动缝线 / 冻结，均不改变状态与日志', async () => {
    const { w, snap, edge } = await workerWithTornEdge();

    // 未撕裂边（取一条完好边的两端）
    const intact = snap.edges.find((e) => !e.torn);
    if (!intact) throw new Error('no intact edge');
    w.send({ type: 'mend', epoch: 1, a: intact.a, b: intact.b });
    expect(w.responses[w.responses.length - 1].type).toBe('mendRejected');

    // 非法端点（不相邻节点）
    w.send({ type: 'mend', epoch: 1, a: 0, b: 5 });
    expect(w.responses[w.responses.length - 1].type).toBe('mendRejected');

    // 合法 mend 一次，然后重复补缝同一对端点 → 拒绝
    w.send({ type: 'mend', epoch: 1, a: edge.a, b: edge.b });
    expect(w.responses[w.responses.length - 1].type).toBe('snapshot');
    w.send({ type: 'mend', epoch: 1, a: edge.a, b: edge.b });
    expect(w.responses[w.responses.length - 1].type).toBe('mendRejected');

    // 状态与日志只反映那一次成功的 mend
    w.send({ type: 'advance', epoch: 1, count: 0 });
    const after = lastSnapshot(w);
    expect(after.seams).toHaveLength(1);
    expect(after.ops.filter((o) => o.kind === 'mend')).toHaveLength(1);
    expect(after.step).toBe(snap.step); // 拒绝不会推进或改变状态

    // 600 步冻结后：任何 mend 都被拒绝
    w.send({ type: 'advance', epoch: 1, count: MAX_STEPS });
    const frozenSnap = lastSnapshot(w);
    expect(frozenSnap.reachedMax).toBe(true);
    const opsAtFreeze = frozenSnap.ops.length;
    w.send({ type: 'mend', epoch: 1, a: edge.a, b: edge.b });
    expect(w.responses[w.responses.length - 1].type).toBe('mendRejected');
    w.send({ type: 'advance', epoch: 1, count: 0 });
    const still = lastSnapshot(w);
    expect(still.ops).toHaveLength(opsAtFreeze);
    expect(still.seams).toHaveLength(1); // 没有新缝线
    expect(still.step).toBe(MAX_STEPS);
  });

  it('mend 拒绝：响应携带可读原因，且拒绝前后快照节点逐位一致', async () => {
    const w = await loadWorker();
    w.send({ type: 'init', epoch: 1, config: DEFAULT_CONFIG });
    w.send({ type: 'advance', epoch: 1, count: 25 });
    const before = lastSnapshot(w);
    w.send({ type: 'mend', epoch: 1, a: 0, b: 1 }); // 完好边
    const rej = w.responses[w.responses.length - 1];
    expect(rej.type).toBe('mendRejected');
    if (rej.type !== 'mendRejected') throw new Error('unreachable');
    expect(rej.reason.length).toBeGreaterThan(0);
    w.send({ type: 'advance', epoch: 1, count: 0 });
    const after = lastSnapshot(w);
    expect(after.step).toBe(before.step);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.ops).toEqual(before.ops);
    expect(after.seams).toEqual(before.seams);
  });
});
