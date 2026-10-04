import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../sim/types';

interface Props {
  snapshot: Snapshot | null;
  onTogglePin: (node: number) => void;
  onBeginDrag: (node: number, x: number, y: number) => void;
  onUpdateDrag: (x: number, y: number) => void;
  onEndDrag: () => void;
  onHover: (node: number | null) => void;
}

const HIT_RADIUS = 14;
const DRAG_THRESHOLD = 4;

export function ClothCanvas({
  snapshot,
  onTogglePin,
  onBeginDrag,
  onUpdateDrag,
  onEndDrag,
  onHover,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapRef = useRef<Snapshot | null>(snapshot);
  const [hover, setHover] = useState<number | null>(null);
  const hoverRef = useRef<number | null>(null);
  const downRef = useRef<{ node: number; x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    snapRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    hoverRef.current = hover;
  }, [hover]);

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
        if (ctx) render(ctx, snap, hoverRef.current);
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

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!snapRef.current) return;
    const { x, y } = posFromEvent(e);
    const node = pickNode(x, y);
    if (node === null) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    downRef.current = { node, x, y, moved: false };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const snap = snapRef.current;
    if (!snap) return;
    const { x, y } = posFromEvent(e);
    const down = downRef.current;
    if (down) {
      if (Math.hypot(x - down.x, y - down.y) >= DRAG_THRESHOLD) {
        if (!down.moved) {
          down.moved = true;
          onBeginDrag(down.node, x, y);
        } else {
          onUpdateDrag(x, y);
        }
      }
      return;
    }
    const node = pickNode(x, y);
    if (node !== hover) {
      setHover(node);
      onHover(node);
      canvasRef.current!.style.cursor = node === null ? 'default' : 'grab';
    }
  };

  const finishPointer = (e: React.PointerEvent) => {
    const down = downRef.current;
    if (!down) return;
    downRef.current = null;
    if (down.moved) {
      onEndDrag();
    } else {
      // 纯点击（未移动）：切换固定/自由。
      onTogglePin(down.node);
    }
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  const handlePointerLeave = () => {
    if (!downRef.current) {
      setHover(null);
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

function clampPointer(x: number, y: number, snap: Snapshot) {
  return {
    x: Math.max(2, Math.min(snap.config.canvasWidth - 2, x)),
    // 拖动位置限制在地面之上，保证固定点逐位精确、不穿越地面。
    y: Math.max(2, Math.min(snap.config.groundY - 2, y)),
  };
}

function render(ctx: CanvasRenderingContext2D, snap: Snapshot, hover: number | null) {
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

  // 撕裂边（红虚线）
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
