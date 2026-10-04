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
    expect(w.responses.length).toBe(before);
    // 当前 epoch 正常工作。
    w.send({ type: 'advance', epoch: 7, count: 5 });
    expect(lastSnapshot(w).step).toBe(5);
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
