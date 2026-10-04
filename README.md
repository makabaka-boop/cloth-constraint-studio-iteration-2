# 离线二维布料实验台

React 18 + TypeScript + Canvas + Web Worker 的确定性二维布料物理实验台。
纯前端离线运行，无任何外部服务依赖。

## 运行

```bash
npm install
npm run dev      # 开发服务器
npm test         # 运行 20 个测试（模拟核心 + Worker 协议）
npm run build    # tsc 严格类型检查 + 生产构建
npm run preview  # 预览构建产物
```

## 交互

- **点击节点**：固定 / 释放挂点（瞬时 pin/unpin，记入操作日志）
- **拖动节点**：移动挂点。拖动既有固定点松手后锚定在终点；抓起自由节点松手后脱落
- **▶ 播放 / ⏸ 暂停**：播放时每个 `requestAnimationFrame` 推进恰好 1 个固定时间步
- **单步 +1 / 推进 N 步**：手动分批推进
- 右侧面板可悬停检查任意节点的位置、速度、固定态；可跑 600 步自动不变量核对；可导出当前快照 JSON
- 编辑网格尺寸 / 间距 / 重力 / 阻尼 / 刚度 / 迭代次数 / 撕裂倍数 / 地面等参数后，点「应用参数并重置实验」

## 物理模型（`src/sim/cloth.ts`）

- 网格每边 8～20 个节点；水平边、垂直边分别建立（存储上先水平段后垂直段）
- **固定时间步 Verlet 积分**（默认 dt=1/60）：`x' = x + (x - x_prev)*damping + g*dt²`
- 每个时间步执行**固定次数**约束松弛（默认 4 次），每次迭代先扫全部水平边、再扫全部垂直边，
  Jakobsen 位置型修正按动度分配（固定点动度为 0，不被任何边拉动）
- **一次性撕裂**：某边首次检测到当前长度 > `restLength * tearFactor` 即置 torn=1，
  之后每一步直接跳过该边，永不恢复、不再施加约束
- **地面碰撞**：节点 y 夹到 groundY，法向速度清零、切向施摩擦；固定点不参与（位置逐位精确）
- 上限 **600 步**，达到后状态冻结

## 确定性保证（核心要求）

状态的唯一决定因素是 `(ClothConfig, ClothModel, 操作日志)`。模拟核心只用 Float64 运算、
无随机源、无时间/环境输入，边扫描与约束迭代顺序固定：

- **同一日志任意分批一致**：`Stepper.advance(n)` 只是在同一状态上连续执行 n 个 `stepOnce`。
  操作以 `applyStep` 标记生效时刻（拖动是逐轨迹点的 move 操作），分批只改变「何时停下来观察」，
  不改变每一步看到的操作集合。测试逐位断言 `[600]` / `[1,3,17,42,100,237,200]` / `[1]×600`
  三种推进的 `pos / prev / pinned / torn` 完全相同，并在 0/1/2/7/…/599 等中间步采样核对。
- **编辑约束 / 重置后旧帧不可能覆盖新实验**：重置 = `worker.terminate()` 旧 Worker +
  递增 epoch 启动新 Worker；主线程收到的回帧若 epoch 不匹配一律丢弃，Worker 内部也做 epoch 校验。
- **画面 / 单步检查 / 导出同源**：Worker 每轮回传唯一的 `Snapshot`，Canvas 渲染、右侧节点检查、
  JSON 导出全部只读这一个对象。

操作在「每步积分之前」应用，因此固定点在该步绝不会漂移；暂停态对冻结帧的操作通过
`applyOpsAtStep` 幂等回放，同帧抓起又松手的移动（释放步定位点）在实机与从头重放中逐位一致。

## 自动不变量核对（右侧按钮，`src/sim/check.ts`）

从初始状态按当前完整操作日志重放 600 步并检查：

| 检查项 | 内容 |
| --- | --- |
| `fixedNoDrift` | 每个固定点逐位不漂移，只允许出现在活动 move 轨迹上 |
| `ground` | 600 步每一帧所有节点 y ≤ groundY |
| `tearMonotonic` | torn 标记只增不减，撕裂不可逆 |
| `determinism` | 一次性 / 非均匀分批 / 逐步三种推进逐位相等 |
| `pinSemantics` | 独立标量回放 pin/unpin/move（含释放语义），最终固定态一致 |
| `cap` | 达到 600 步后再推进状态冻结 |

## 目录

```
src/
  sim/            纯函数模拟核心（可脱离 DOM/Worker 在 Node 中测试）
    types.ts        配置 / 模型 / 状态 / 操作日志 / 快照类型
    cloth.ts        建模、Verlet 积分、约束松弛+撕裂、地面碰撞
    stepper.ts      确定性分批推进器
    snapshot.ts     唯一快照构建 + 序列化
    check.ts        600 步不变量核对
  worker/
    sim.worker.ts   Worker：持有模型/状态/日志，处理 init/advance/addOps/check
    protocol.ts     主线程 ↔ Worker 消息类型
  hooks/
    useClothSimulation.ts  Worker 生命周期、epoch、播放循环、拖动/固定交互
  components/     ClothCanvas / ControlPanel / StatusPanel
```
