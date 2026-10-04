import type { CheckReport } from '../sim/check';
import type {
  ClothConfig,
  ClothOp,
  MendRejectReason,
  MovePoint,
  Snapshot,
} from '../sim/types';

/** 主线程 → Worker */
export type WorkerRequest =
  | {
      type: 'init';
      epoch: number;
      config: ClothConfig;
    }
  | {
      type: 'advance';
      epoch: number;
      count: number;
      /** 本批推进前追加的操作（pin/unpin 或已收尾的 move）。 */
      newOps?: ClothOp[];
      /** 对进行中 move 轨迹的追加（指针移动节流上报）。 */
      moveUpdates?: Array<{ node: number; points: MovePoint[] }>;
    }
  | {
      type: 'addOps';
      epoch: number;
      /** 暂停（不推进）时追加操作并立即应用到当前步，随后回传快照。 */
      newOps: ClothOp[];
    }
  | {
      type: 'appendMovePoints';
      epoch: number;
      /** 暂停状态下拖动：只追加轨迹点，当前步立即定位。 */
      node: number;
      points: MovePoint[];
    }
  | {
      type: 'finishMove';
      epoch: number;
      node: number;
      releaseStep: number;
      releasePinned: boolean;
      point?: MovePoint;
    }
  | {
      type: 'mend';
      epoch: number;
      /** 布景师选中的当前已撕裂边的两个端点（顺序不敏感）。 */
      a: number;
      b: number;
    }
  | {
      type: 'check';
      epoch: number;
    };

/** Worker → 主线程 */
export type WorkerResponse =
  | {
      type: 'snapshot';
      epoch: number;
      snapshot: Snapshot;
      /** 仅当本帧由一次补缝请求触发时附带补缝结果（用于 UI 反馈拒绝原因）。 */
      mend?: { ok: true } | { ok: false; reason: MendRejectReason };
    }
  | { type: 'check'; epoch: number; report: CheckReport }
  | { type: 'error'; epoch: number; message: string };

/**
 * 主线程判断回帧是否属于当前实验（epoch）。
 * 重置/编辑参数 = terminate 旧 Worker + 递增 epoch 启新 Worker，
 * 旧 Worker 迟到的任何帧（snapshot/check/error）都必须按同一规则丢弃。
 */
export function responseBelongsToEpoch(res: WorkerResponse, epoch: number): boolean {
  return res.epoch === epoch;
}
