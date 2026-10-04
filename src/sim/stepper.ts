import { stepOnce } from './cloth';
import {
  MAX_STEPS,
  type ClothConfig,
  type ClothModel,
  type ClothOp,
  type ClothState,
} from './types';

/**
 * 确定性推进器：持有模型、状态与操作日志。
 *
 * advance(n) 只是在同一状态上连续执行 n 个 stepOnce —— 状态完全由
 * (model, state, ops) 决定，不存在任何与批次、时间、随机源相关的输入，
 * 所以同一份日志拆成 [1,1,...] 还是一次性 [600]，到达相同步数时状态逐位相同。
 *
 * 操作日志以 applyStep 标记生效时刻：分批只改变「何时停下来观察」，
 * 不改变每一步看到的操作集合。
 */
export class Stepper {
  readonly config: ClothConfig;
  readonly model: ClothModel;
  state: ClothState;
  /** 完整操作日志（按创建顺序保留，不按步排序——创建顺序也是确定的）。 */
  ops: ClothOp[];

  constructor(config: ClothConfig, model: ClothModel, state: ClothState, ops: ClothOp[] = []) {
    this.config = config;
    this.model = model;
    this.state = state;
    this.ops = ops;
  }

  get step(): number {
    return this.state.step;
  }

  get reachedMax(): boolean {
    return this.state.step >= MAX_STEPS;
  }

  /** 推进至多 count 步，返回实际推进的步数（达到 600 上限后返回 0）。 */
  advance(count: number): number {
    let done = 0;
    while (done < count && this.state.step < MAX_STEPS) {
      stepOnce(this.config, this.model, this.state, this.ops);
      done++;
    }
    return done;
  }
}

/** 把操作日志在全新实验上重放，到 targetStep 停止（用于核对/测试）。 */
export function replayOps(
  config: ClothConfig,
  model: ClothModel,
  initialState: ClothState,
  ops: readonly ClothOp[],
  targetStep: number = MAX_STEPS,
): ClothState {
  const stepper = new Stepper(config, model, cloneState(initialState), ops.slice());
  stepper.advance(Math.max(0, Math.min(MAX_STEPS, targetStep)));
  return stepper.state;
}

export function cloneState(state: ClothState): ClothState {
  return {
    pos: new Float64Array(state.pos),
    prev: new Float64Array(state.prev),
    pinned: new Uint8Array(state.pinned),
    torn: new Uint8Array(state.torn),
    step: state.step,
  };
}
