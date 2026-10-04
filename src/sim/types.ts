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

/**
 * 补缝约束（新身份的缝线）。
 *
 * 缝线由 mend 操作在「下一次积分之前」生成，静长取生效时两端实际距离。
 * 每一条缝线有全局唯一且按创建顺序递增的 id（即缝线代次）：再次补缝产生新 id，
 * 旧缝线（无论之后是否再次撕裂）都只追加、永不删除，因此撕裂的取证轨迹完整保留。
 *
 * 存储上 stitches 恒按 id 升序追加，约束扫描固定排在全部原始水平/垂直边之后，
 * 不依赖边数组下标，所以一次推进、分批推进与从日志重放逐位一致。
 */
export interface Stitch {
  /** 全局唯一缝线 id（代次），从 0 起按创建顺序递增。 */
  id: number;
  a: number;
  b: number;
  /** 静长：mend 生效步开始时两端的实际距离（>0）。 */
  restLength: number;
  /** 0 = 活动缝线（参与约束、可能断裂），1 = 已再次撕裂（永久跳过）。 */
  torn: number;
  /** 生效步数（mend 的 applyStep），取证用。 */
  appliedStep: number;
  /** 再次撕裂发生的步数；未撕裂为 -1，取证用。 */
  tornStep: number;
}

/** 动态模拟状态。 */
export interface ClothState {
  pos: Float64Array;
  prev: Float64Array;
  /** 1 = 固定点（当前步由操作日志决定，Verlet 中不积分、约束中权重为 0）。 */
  pinned: Uint8Array;
  /** 0 = 完好，1 = 已撕裂。撕裂不可逆，后续步骤不再施加该边约束。 */
  torn: Uint8Array;
  /**
   * 历次补缝产生的全部缝线，按 id（创建顺序）追加，永不删除。
   * 原始边的 torn 永不被补缝倒改；缝线自己的 torn 也只增不减。
   */
  stitches: Stitch[];
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
    }
  | {
      kind: 'mend';
      /** 被补的已撕裂原始边的两个端点（顺序不敏感）。 */
      a: number;
      b: number;
      /** 在第几步开始时（下一次积分之前）生成缝线。 */
      applyStep: number;
      /** 缝线身份（代次）：创建时由当前 stitches 长度确定，再次补缝必为新值。 */
      stitchId: number;
      /** 生效时两端的实际距离（>0）；创建时测得并随日志保留，重放逐位一致。 */
      restLength: number;
    };

/** 补缝被拒绝的原因（拒绝时不改变状态，也不写入日志）。 */
export type MendRejectReason =
  | 'frozen'
  | 'badEndpoint'
  | 'edgeNotTorn'
  | 'zeroDistance'
  | 'alreadyStitched';

export interface MendResult {
  ok: boolean;
  reason?: MendRejectReason;
  /** ok 时生成的待入日志操作。 */
  op?: Extract<ClothOp, { kind: 'mend' }>;
}

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
  /**
   * 历次补缝缝线的快照（含代次），按 id 升序、永不缺失 —— 与原始边同源，
   * Canvas、检查面板、JSON 导出读取的缝线代次完全一致。
   */
  stitches: Array<{
    id: number;
    /** 缝线代次：同一对端点之间第几次补缝（1 起）。 */
    generation: number;
    a: number;
    b: number;
    restLength: number;
    torn: boolean;
    appliedStep: number;
    tornStep: number | null;
    /** 当前长度/restLength，已再次撕裂为 null。 */
    strain: number | null;
  }>;
  tornCount: number;
  /** 当前仍活动（未再次撕裂）的缝线数。 */
  activeStitchCount: number;
  /** 历次补缝总数（含已再次撕裂的代次）。 */
  stitchCount: number;
  pinnedCount: number;
  reachedMax: boolean;
  config: ClothConfig;
  ops: ClothOp[];
}
