import type { CheckReport } from '../sim/check';
import type { ClothConfig, ClothOp, MovePoint, Snapshot } from '../sim/types';

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
      type: 'check';
      epoch: number;
    };

/** Worker → 主线程 */
export type WorkerResponse =
  | { type: 'snapshot'; epoch: number; snapshot: Snapshot }
  | { type: 'check'; epoch: number; report: CheckReport }
  | { type: 'error'; epoch: number; message: string };
