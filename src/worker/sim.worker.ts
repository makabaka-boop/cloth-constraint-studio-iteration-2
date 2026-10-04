/// <reference lib="webworker" />
import { runChecks } from '../sim/check';
import {
  createClothModel,
  createInitialState,
  applyOpsAtStep,
  validateMend,
  type MendRejection,
} from '../sim/cloth';
import { buildSnapshot } from '../sim/snapshot';
import { Stepper } from '../sim/stepper';
import { MAX_STEPS, type ClothConfig, type ClothOp, type MovePoint } from '../sim/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * 模拟 Worker：单一事实源（模型 + 状态 + 操作日志）都在这里。
 *
 * 「编辑约束或重置」= 主线程 terminate 本 Worker 并用新 epoch 启动新 Worker，
 * 旧 Worker 的任何后续消息都会被主线程按 epoch 丢弃，旧帧不可能覆盖新实验。
 */

let epoch = -1;
let config: ClothConfig | null = null;
let stepper: Stepper | null = null;

// 模块加载时绑定所属 Worker 全局作用域（真实 Worker 中 self 恒定；
// 测试中每个模块实例各自捕获当时的 self，旧 Worker 的回帧不会串到新实例）。
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function send(msg: WorkerResponse): void {
  workerScope.postMessage(msg);
}

function currentSnapshot() {
  if (!config || !stepper) throw new Error('simulation not initialized');
  return buildSnapshot(config, stepper.model, stepper.state, stepper.ops);
}

/** 找到某节点仍进行中的 move 操作（releaseStep 为 MAX_STEPS+1）。 */
function findActiveMove(ops: ClothOp[], node: number): ClothOp | undefined {
  for (let k = ops.length - 1; k >= 0; k--) {
    const op = ops[k];
    if (op.kind === 'move' && op.node === node && op.releaseStep > MAX_STEPS) return op;
  }
  return undefined;
}

/** 在当前步立即回放操作日志（暂停态追加操作后调用）。 */
function applyOpsNow(): void {
  if (!stepper) return;
  applyOpsAtStep(stepper.model, stepper.state, stepper.ops);
}

const MEND_REJECTION_TEXT: Record<MendRejection, string> = {
  frozen: '已达 600 步上限，实验冻结，拒绝补缝',
  'invalid-endpoints': '端点非法：两个端点必须是一条原始边的两端',
  'edge-not-torn': '该边尚未撕裂，不能补缝',
  'active-seam-exists': '两端点间已有一条活动缝线',
  'zero-distance': '两端点距离为 0，无法定义缝线静长',
};

/** 向 move 轨迹合并点：同 step 覆盖，整体保持按 step 升序。 */
function mergePoints(existing: MovePoint[], added: MovePoint[]): void {
  for (const p of added) {
    let lo = 0;
    let hi = existing.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (existing[mid].step < p.step) lo = mid + 1;
      else hi = mid;
    }
    if (lo < existing.length && existing[lo].step === p.step) existing[lo] = p;
    else existing.splice(lo, 0, p);
  }
}

function handle(msg: WorkerRequest): void {
  // 过期 Worker 的消息（理论上 terminate 后不会到达）双重保险：直接忽略。
  if (msg.epoch !== epoch) return;
  if (!stepper || !config) {
    if (msg.type !== 'init') {
      send({ type: 'error', epoch, message: 'simulation not initialized' });
      return;
    }
  }

  switch (msg.type) {
    case 'init': {
      config = msg.config;
      const model = createClothModel(config);
      const state = createInitialState(config, model);
      stepper = new Stepper(config, model, state, []);
      send({ type: 'snapshot', epoch, snapshot: currentSnapshot() });
      return;
    }
    case 'advance': {
      if (!stepper) return;
      if (msg.newOps) stepper.ops.push(...msg.newOps);
      if (msg.moveUpdates) {
        for (const u of msg.moveUpdates) {
          const op = findActiveMove(stepper.ops, u.node);
          if (op && op.kind === 'move') mergePoints(op.points, u.points);
        }
      }
      stepper.advance(msg.count);
      send({ type: 'snapshot', epoch, snapshot: currentSnapshot() });
      return;
    }
    case 'addOps': {
      if (!stepper) return;
      stepper.ops.push(...msg.newOps);
      // 暂停时追加：在「当前步」立即生效一次（同一 op 在将来推进时幂等重放）。
      applyOpsNow();
      send({ type: 'snapshot', epoch, snapshot: currentSnapshot() });
      return;
    }
    case 'appendMovePoints': {
      if (!stepper) return;
      const op = findActiveMove(stepper.ops, msg.node);
      if (op && op.kind === 'move') {
        mergePoints(op.points, msg.points);
        applyOpsNow();
      }
      send({ type: 'snapshot', epoch, snapshot: currentSnapshot() });
      return;
    }
    case 'finishMove': {
      if (!stepper) return;
      const op = findActiveMove(stepper.ops, msg.node);
      if (op && op.kind === 'move') {
        op.releaseStep = msg.releaseStep;
        op.releasePinned = msg.releasePinned;
        if (msg.point) mergePoints(op.points, [msg.point]);
        // 在释放步立刻应用释放语义（暂停状态下也能看到正确的固定态）。
        applyOpsNow();
      }
      send({ type: 'snapshot', epoch, snapshot: currentSnapshot() });
      return;
    }
    case 'mend': {
      if (!stepper) return;
      // 先校验再写日志：非法请求不改变状态与日志，只回拒绝原因。
      const rejection = validateMend(stepper.model, stepper.state, msg.a, msg.b);
      if (rejection) {
        send({ type: 'mendRejected', epoch, reason: MEND_REJECTION_TEXT[rejection] });
        return;
      }
      stepper.ops.push({
        kind: 'mend',
        a: msg.a,
        b: msg.b,
        applyStep: stepper.state.step,
      });
      // 在当前步、下一次积分之前立即生成缝线（推进时按日志幂等重放）。
      applyOpsNow();
      send({ type: 'snapshot', epoch, snapshot: currentSnapshot() });
      return;
    }
    case 'check': {
      if (!config) return;
      const model = createClothModel(config);
      // 检查始终从初始状态按完整日志重放 —— 与画面是否推进过无关，
      // 因而编辑后/任意暂停点的检查结果都只取决于 (config, ops)。
      const report = runChecks(config, model, stepper?.ops ?? []);
      send({ type: 'check', epoch, report });
      return;
    }
  }
}

workerScope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  // Worker 创建后第一条消息必须是 init；epoch 随之固定，之后拒绝任何其他 epoch。
  if (msg.type === 'init' && epoch === -1) epoch = msg.epoch;
  try {
    handle(msg);
  } catch (err) {
    send({ type: 'error', epoch, message: (err as Error).message });
  }
};
