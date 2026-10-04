/**
 * 布料模拟核心类型定义。
 *
 * 所有数值运算基于 Float64Array，代码路径确定（无随机、无 Date/Math.random），
 * 因此同一初始模型 + 同一操作日志，无论分多少批推进，结果逐位一致。
 */

/** 网格每边节点数，8～20。 */
export const MIN_NODES_PER_SIDE = 8;
export const MAX_NODES_PER_SIDE = 20;

/** 模拟最多推进的步数。 */
export const MAX_STEPS = 600;

export type PinMode = 'top-row' | 'corners' | 'none';

/** 静态配置：编辑这些参数会重置整个实验（重新建模）。 */
export interface ClothConfig {
  /** 水平方向节点数（列数）。 */
  cols: number;
  /** 垂直方向节点数（行数）。 */
  rows: number;
  /** 节点间距（像素）。 */
  spacing: number;
  /** 布料左上角 x（画布坐标）。 */
  originX: number;
  /** 布料左上角 y（画布坐标）。 */
  originY: number;
  /** 重力加速度 px/s^2（竖直向下）。 */
  gravity: number;
  /** Verlet 阻尼系数：v *= damping，1 为无阻尼。 */
  damping: number;
  /**
   * 约束刚度（0～1），每次约束修正施加的比例。
   * 固定迭代次数，刚度仅影响修正比例，不影响迭代次数（迭代次数本身是确定的）。
   */
  stiffness: number;
  /** 每个时间步的约束修正迭代次数（水平、垂直边各扫一遍为一次迭代）。 */
  iterations: number;
  /** 边长度超过 restLength * tearFactor 时撕裂（一次性）。 */
  tearFactor: number;
  /** 固定时间步长（秒）。 */
  dt: number;
  /** 地面 y 坐标（像素），节点不得低于此线。 */
  groundY: number;
  /** 地面切向摩擦：落地后水平速度 *= friction。 */
  groundFriction: number;
  /** 画布宽（仅用于绘制边界，不参与物理）。 */
  canvasWidth: number;
  /** 画布高。 */
  canvasHeight: number;
  /** 初始挂点模式。 */
  pinMode: PinMode;
}

/** 静态拓扑：边和初始挂点。 */
export interface ClothModel {
  cols: number;
  rows: number;
  /** 边 a 端节点索引，水平边在前、垂直边在后（段内按行优先排列）。 */
  edgeA: Int32Array;
  edgeB: Int32Array;
  /** 边的静止长度。 */
  edgeRest: Float64Array;
  /** 每条边是否为水平边（true = 水平，false = 垂直）。 */
  edgeHorizontal: Uint8Array;
  edgeCount: number;
  /** 初始固定节点索引。 */
  initialPins: Int32Array;
}

/** 动态模拟状态。 */
export interface ClothState {
  pos: Float64Array;
  prev: Float64Array;
  /** 1 = 固定点（当前步由操作日志决定，Verlet 中不积分、约束中权重为 0）。 */
  pinned: Uint8Array;
  /** 0 = 完好，1 = 已撕裂。撕裂不可逆，后续步骤不再施加该边约束。 */
  torn: Uint8Array;
  /** 已完成的步数（0～MAX_STEPS）。 */
  step: number;
}

/** 操作日志条目。同一操作日志不论分批方式都必须得到相同状态。 */
export interface MovePoint {
  step: number;
  x: number;
  y: number;
}

export type ClothOp =
  | { kind: 'pin'; node: number; /** 在第几步开始时生效 */ applyStep: number }
  | { kind: 'unpin'; node: number; applyStep: number }
  | {
      kind: 'move';
      node: number;
      /** move 在 [applyStep, releaseStep) 内每步开始时将节点钉到该步的轨迹点。 */
      applyStep: number;
      /** 在 releaseStep 开始时释放；拖动进行中为 MAX_STEPS+1。 */
      releaseStep: number;
      /** true：释放后锚定在终点（拖动既有挂点）；false：释放为自由节点。拖动中为 null。 */
      releasePinned: boolean | null;
      /** 按 step 升序的轨迹点；每步取 step <= 当前步 的最后一个点。 */
      points: MovePoint[];
    };

/** 供渲染 / 单步检查 / 导出共用的唯一模拟快照。 */
export interface Snapshot {
  step: number;
  nodes: Array<{
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    pinned: boolean;
  }>;
  edges: Array<{
    id: number;
    a: number;
    b: number;
    horizontal: boolean;
    torn: boolean;
    strain: number | null; // 当前长度/restLength，撕裂边为 null
  }>;
  tornCount: number;
  pinnedCount: number;
  reachedMax: boolean;
  config: ClothConfig;
  ops: ClothOp[];
}
