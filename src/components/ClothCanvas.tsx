import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../sim/types';

interface Props {
  snapshot: Snapshot | null;
  onTogglePin: (node: number) => void;
  onBeginDrag: (node: number, x: number, y: number) => void;
  onUpdateDrag: (x: number, y: number) => void;
  onEndDrag: () => void;
  onHover: (node: number | null) => void;
  /** 点击一条「可补缝」的已撕裂边（其上当前无活动缝线）时请求补缝。 */
  onMend: (a: number, b: number) => void;
}

const HIT_RADIUS = 14;
const DRAG_THRESHOLD = 4;
/** 已撕裂边允许点中的最大垂直距离（像素）。 */
const EDGE_HIT_DIST = 8;

export function ClothCanvas({
  snapshot,
  onTogglePin,
  onBeginDrag,
  onUpdateDrag,
  onEndDrag,
  onHover,
  onMend,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapRef = useRef<Snapshot | null>(snapshot);
  const [hover, setHover] = useState<number | null>(null);
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const hoverRef = useRef<number | null>(null);
  const hoverEdgeRef = useRef<number | null>(null);
  const downRef = useRef<{ node: number; edge: number | null; x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    snapRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    hoverRef.current = hover;
  }, [hover]);
  useEffect(() => {
    hoverEdgeRef.current = hoverEdge;
  }, [hoverEdge]);

  const width = snapshot?.config.canvasWidth ?? 900;
  const height = snapshot?.config.canvasHeight ?? 600;

  // —— 绘制始终读取最新快照；快照来自 Worker 回传的唯一 Snapshot ——
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const snap = snapRef.current;
      if (canvas && snap) {
        const ctx = canvas.getContext('2d');
        if (ctx) render(ctx, snap, hoverRef.current, hoverEdgeRef.current);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const posFromEvent = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const snap = snapRef.current!;
    const scaleX = snap.config.canvasWidth / rect.width;
    const scaleY = snap.config.canvasHeight / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return clampPointer(x, y, snap);
  };

  const pickNode = (x: number, y: number): number | null => {
    const snap = snapRef.current;
    if (!snap) return null;
    let best: number | null = null;
    let bestD = HIT_RADIUS;
    for (const n of snap.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  };

  /** 端点对之间是否已有活动缝线（同对端点最多一条活动缝线）。 */
  const pairHasActiveStitch = (snap: Snapshot, a: number, b: number): boolean =>
    snap.stitches.some(
      (st) => !st.torn && ((st.a === a && st.b === b) || (st.a === b && st.b === a)),
    );

  /** 点中一条可补缝的已撕裂边（原始边 torn 且其上无活动缝线）；返回边 id。 */
  const pickMendableEdge = (x: number, y: number): number | null => {
    const snap = snapRef.current;
    if (!snap) return null;
    let best: number | null = null;
    let bestD = EDGE_HIT_DIST;
    for (const edge of snap.edges) {
      if (!edge.torn) continue;
      if (pairHasActiveStitch(snap, edge.a, edge.b)) continue;
      const a = snap.nodes[edge.a];
      const b = snap.nodes[edge.b];
      const d = pointToSegment(x, y, a.x, a.y, b.x, b.y);
      if (d < bestD) {
        bestD = d;
        best = edge.id;
      }
    }
    return best;
  };

  const updateHover = (x: number, y: number) => {
    const snap = snapRef.current;
    if (!snap) return;
    const node = pickNode(x, y);
    if (node !== hover) {
      setHover(node);
      onHover(node);
    }
    // 节点优先；未悬停节点时才高亮可补缝边。
    const edge = node === null ? pickMendableEdge(x, y) : null;
    if (edge !== hoverEdge) setHoverEdge(edge);
    canvasRef.current!.style.cursor =
      node !== null ? 'grab' : edge !== null ? 'crosshair' : 'default';
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!snapRef.current) return;
    const { x, y } = posFromEvent(e);
    const node = pickNode(x, y);
    const edge = node === null ? pickMendableEdge(x, y) : null;
    if (node === null && edge === null) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    downRef.current = { node: node ?? -1, edge, x, y, moved: false };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const { x, y } = posFromEvent(e);
    const down = downRef.current;
    if (down) {
      if (Math.hypot(x - down.x, y - down.y) >= DRAG_THRESHOLD) {
        if (!down.moved && down.node >= 0) {
          down.moved = true;
          onBeginDrag(down.node, x, y);
        } else if (down.moved) {
          onUpdateDrag(x, y);
        }
      }
      return;
    }
    updateHover(x, y);
  };

  const finishPointer = (e: React.PointerEvent) => {
    const down = downRef.current;
    if (!down) return;
    downRef.current = null;
    if (down.moved) {
      onEndDrag();
    } else if (down.node >= 0) {
      // 纯点击节点（未移动）：切换固定/自由。
      onTogglePin(down.node);
    } else if (down.edge !== null) {
      // 纯点击可补缝的已撕裂边：在当前步补缝（拒绝与否由 Worker 判定）。
      const snap = snapRef.current;
      const edge = snap?.edges[down.edge];
      if (snap && edge) onMend(edge.a, edge.b);
    }
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  const handlePointerLeave = () => {
    if (!downRef.current) {
      setHover(null);
      setHoverEdge(null);
      onHover(null);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        width: '100%',
        maxWidth: width,
        touchAction: 'none',
        border: '1px solid #334',
        borderRadius: 8,
        background: '#0f1220',
        display: 'block',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onPointerLeave={handlePointerLeave}
    />
  );
}

/** 点到线段的距离。 */
function pointToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function clampPointer(x: number, y: number, snap: Snapshot) {
  return {
    x: Math.max(2, Math.min(snap.config.canvasWidth - 2, x)),
    // 拖动位置限制在地面之上，保证固定点逐位精确、不穿越地面。
    y: Math.max(2, Math.min(snap.config.groundY - 2, y)),
  };
}

function render(
  ctx: CanvasRenderingContext2D,
  snap: Snapshot,
  hover: number | null,
  hoverEdge: number | null,
) {
  const { canvasWidth: w, canvasHeight: h, groundY } = snap.config;
  ctx.clearRect(0, 0, w, h);

  // 背景
  ctx.fillStyle = '#0f1220';
  ctx.fillRect(0, 0, w, h);

  // 地面
  ctx.strokeStyle = '#5b8c5a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(w, groundY);
  ctx.stroke();
  ctx.fillStyle = 'rgba(91,140,90,0.12)';
  ctx.fillRect(0, groundY, w, h - groundY);

  // 撕裂边（红虚线）——旧边保持 torn 的取证轨迹，补缝后依旧画出
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(229,72,77,0.55)';
  ctx.beginPath();
  for (const edge of snap.edges) {
    if (!edge.torn) continue;
    const a = snap.nodes[edge.a];
    const b = snap.nodes[edge.b];
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  // 再次撕裂的缝线代次：橙虚线（保留全部代次轨迹）
  ctx.setLineDash([2, 5]);
  ctx.strokeStyle = 'rgba(230,150,60,0.5)';
  ctx.beginPath();
  for (const st of snap.stitches) {
    if (!st.torn) continue;
    const a = snap.nodes[st.a];
    const b = snap.nodes[st.b];
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // 完好边：按应变着色（绿→黄→红），逐条描边（≤ ~760 条）
  for (const edge of snap.edges) {
    if (edge.torn || edge.strain === null) continue;
    const a = snap.nodes[edge.a];
    const b = snap.nodes[edge.b];
    ctx.beginPath();
    ctx.strokeStyle = strainColor(edge.strain, snap.config.tearFactor);
    ctx.lineWidth = 1.2;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // 活动缝线：青色实线（新身份约束），线宽略粗以区别于原始边
  for (const st of snap.stitches) {
    if (st.torn || st.strain === null) continue;
    const a = snap.nodes[st.a];
    const b = snap.nodes[st.b];
    ctx.beginPath();
    ctx.strokeStyle = stitchColor(st.strain, snap.config.tearFactor);
    ctx.lineWidth = 1.8;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // 可补缝边悬停高亮
  if (hoverEdge !== null && snap.edges[hoverEdge]) {
    const edge = snap.edges[hoverEdge];
    const a = snap.nodes[edge.a];
    const b = snap.nodes[edge.b];
    ctx.strokeStyle = 'rgba(125,249,255,0.9)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 节点
  for (const n of snap.nodes) {
    ctx.beginPath();
    ctx.fillStyle = n.pinned ? '#ffd166' : '#9fb4e8';
    ctx.arc(n.x, n.y, n.pinned ? 3.4 : 2.2, 0, Math.PI * 2);
    ctx.fill();
    if (n.pinned) {
      ctx.strokeStyle = '#e85d04';
      ctx.lineWidth = 1;
      ctx.strokeRect(n.x - 6, n.y - 6, 12, 12);
    }
  }

  // 悬停高亮
  if (hover !== null && snap.nodes[hover]) {
    const n = snap.nodes[hover];
    ctx.strokeStyle = '#7df9ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(n.x, n.y, HIT_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function strainColor(strain: number, tearFactor: number): string {
  const t = Math.max(0, Math.min(1, (strain - 1) / (tearFactor - 1)));
  // 绿 (120) → 黄 (60) → 红 (0)
  const hue = 120 - 120 * t;
  return `hsl(${hue.toFixed(0)} 65% 60%)`;
}

/** 缝线着色：青绿 → 亮青，接近断裂时转品红，提示仍按阈值断裂。 */
function stitchColor(strain: number, tearFactor: number): string {
  const t = Math.max(0, Math.min(1, (strain - 1) / (tearFactor - 1)));
  const hue = 180 - 180 * t; // 青 180 → 品红 300 方向（线性截断到 0）
  return `hsl(${Math.max(0, hue).toFixed(0)} 75% ${(62 + 8 * t).toFixed(0)}%)`;
}
