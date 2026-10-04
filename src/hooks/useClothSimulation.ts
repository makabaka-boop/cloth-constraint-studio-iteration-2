import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckReport } from '../sim/check';
import { DEFAULT_CONFIG } from '../sim/cloth';
import type { ClothConfig, ClothOp, MovePoint, Snapshot } from '../sim/types';
import { MAX_STEPS } from '../sim/types';
import type { WorkerRequest, WorkerResponse } from '../worker/protocol';

export interface ActiveDrag {
  node: number;
  /** 拖动开始时该节点是否为固定点 —— 决定松手后锚定还是脱落。 */
  wasPinned: boolean;
}

interface PendingMove {
  op: Extract<ClothOp, { kind: 'move' }>;
  wasPinned: boolean;
}

export interface ClothApi {
  snapshot: Snapshot | null;
  config: ClothConfig;
  playing: boolean;
  drag: ActiveDrag | null;
  report: CheckReport | null;
  busy: boolean;
  reset: (config?: ClothConfig) => void;
  togglePlay: () => void;
  step: (count: number) => void;
  togglePin: (node: number) => void;
  beginDrag: (node: number, x: number, y: number) => void;
  updateDrag: (x: number, y: number) => void;
  endDrag: () => void;
  runChecks: () => void;
}

export function useClothSimulation(): ClothApi {
  const [config, setConfig] = useState<ClothConfig>(DEFAULT_CONFIG);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [playing, setPlaying] = useState(false);
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [busy, setBusy] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const epochRef = useRef(0);
  const snapshotRef = useRef<Snapshot | null>(null);
  const playingRef = useRef(false);
  const pendingReplyRef = useRef(false);
  const dragRef = useRef<ActiveDrag | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  /** 播放中产生、待下一次 advance 携带的 pin/unpin。 */
  const queuedOpsRef = useRef<ClothOp[]>([]);
  /** 尚未发送给 Worker 的 move（创建于播放中、等下一帧随批发出）。 */
  const pendingMoveRef = useRef<PendingMove | null>(null);
  /** 待发送的松手意图（等在途 advance 回来后再按准确的 step 释放）。 */
  const finishIntentRef = useRef<ActiveDrag | null>(null);
  const pointScheduledRef = useRef(false);

  const post = useCallback((msg: WorkerRequest) => {
    workerRef.current?.postMessage(msg);
  }, []);

  // —— Worker 生命周期：每次重置/编辑约束都彻底换新 Worker ——
  const spawnWorker = useCallback((cfg: ClothConfig) => {
    workerRef.current?.terminate(); // 旧 Worker 绝不可能再发出被采纳的帧
    const epoch = ++epochRef.current;
    pendingReplyRef.current = false;
    queuedOpsRef.current = [];
    pendingMoveRef.current = null;
    finishIntentRef.current = null;
    const worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const res = e.data;
      // epoch 防护：旧实验/旧 Worker 的任何回帧一律丢弃。
      if (res.epoch !== epochRef.current) return;
      if (res.type === 'error') {
        console.error('cloth worker error:', res.message);
        return;
      }
      if (res.type === 'check') {
        setReport(res.report);
        setBusy(false);
        return;
      }
      pendingReplyRef.current = false;
      snapshotRef.current = res.snapshot;
      setSnapshot(res.snapshot);

      // 在途 advance 期间松手：此刻才知道准确的下一步编号，释放它。
      const finish = finishIntentRef.current;
      if (finish && res.snapshot.step <= MAX_STEPS) {
        finishIntentRef.current = null;
        post({
          type: 'finishMove',
          epoch: epochRef.current,
          node: finish.node,
          releaseStep: res.snapshot.step,
          releasePinned: finish.wasPinned,
        });
      }
      if (res.snapshot.reachedMax && playingRef.current) {
        playingRef.current = false;
        setPlaying(false);
      }
    };
    workerRef.current = worker;
    post({ type: 'init', epoch, config: cfg });
  }, [post]);

  useEffect(() => {
    spawnWorker(DEFAULT_CONFIG);
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [spawnWorker]);

  const reset = useCallback((cfg?: ClothConfig) => {
    playingRef.current = false;
    setPlaying(false);
    setReport(null);
    setDrag(null);
    dragRef.current = null;
    pointerRef.current = null;
    snapshotRef.current = null;
    setSnapshot(null);
    const next = cfg ?? config;
    if (cfg) setConfig(cfg);
    spawnWorker(next);
  }, [config, spawnWorker]);

  // —— 播放循环：每帧最多一个在途 advance，固定每帧 1 个时间步 ——
  useEffect(() => {
    playingRef.current = playing;
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (!playingRef.current) return;
      const snap = snapshotRef.current;
      if (snap && !snap.reachedMax && !pendingReplyRef.current) {
        const newOps = queuedOpsRef.current;
        queuedOpsRef.current = [];

        // 进行中的拖动：把指针当前位置记录为「即将积分的这一步」的轨迹点。
        const d = dragRef.current;
        const ptr = pointerRef.current;
        let moveUpdates: Array<{ node: number; points: MovePoint[] }> | undefined;
        if (d && ptr && !finishIntentRef.current) {
          const point: MovePoint = { step: snap.step, x: ptr.x, y: ptr.y };
          const pending = pendingMoveRef.current;
          if (pending) {
            // move 尚未发出：把点并入操作，随本批首次发出。
            pending.op.points.push(point);
            newOps.push(pending.op);
            pendingMoveRef.current = null;
          } else {
            moveUpdates = [{ node: d.node, points: [point] }];
          }
        }

        pendingReplyRef.current = true;
        post({
          type: 'advance',
          epoch: epochRef.current,
          count: 1,
          newOps: newOps.length ? newOps : undefined,
          moveUpdates,
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, post]);

  const step = useCallback((count: number) => {
    if (playingRef.current || pendingReplyRef.current) return;
    const snap = snapshotRef.current;
    if (!snap || snap.reachedMax) return;
    pendingReplyRef.current = true;
    post({ type: 'advance', epoch: epochRef.current, count });
  }, [post]);

  const togglePlay = useCallback(() => {
    const snap = snapshotRef.current;
    if (snap?.reachedMax) return;
    setPlaying((p) => {
      const next = !p;
      playingRef.current = next;
      return next;
    });
  }, []);

  const togglePin = useCallback((node: number) => {
    if (dragRef.current) return;
    const snap = snapshotRef.current;
    if (!snap) return;
    const op: ClothOp = {
      kind: snap.nodes[node].pinned ? 'unpin' : 'pin',
      node,
      applyStep: snap.step,
    };
    if (playingRef.current) queuedOpsRef.current.push(op);
    else post({ type: 'addOps', epoch: epochRef.current, newOps: [op] });
  }, [post]);

  const beginDrag = useCallback((node: number, x: number, y: number) => {
    const snap = snapshotRef.current;
    if (!snap || dragRef.current) return;
    const wasPinned = snap.nodes[node].pinned;
    const active: ActiveDrag = { node, wasPinned };
    dragRef.current = active;
    setDrag(active);
    pointerRef.current = { x, y };
    const op: Extract<ClothOp, { kind: 'move' }> = {
      kind: 'move',
      node,
      applyStep: snap.step,
      releaseStep: MAX_STEPS + 1,
      releasePinned: null,
      points: [{ step: snap.step, x, y }],
    };
    if (playingRef.current) {
      // 随下一帧的 advance 首次发出（避免操作与在途批次错位）。
      pendingMoveRef.current = { op, wasPinned };
    } else {
      post({ type: 'addOps', epoch: epochRef.current, newOps: [op] });
    }
  }, [post]);

  const updateDrag = useCallback((x: number, y: number) => {
    if (!dragRef.current) return;
    pointerRef.current = { x, y };
    // 播放中的轨迹由播放循环随下一帧 advance 带走；暂停时按 rAF 节流上报。
    if (playingRef.current || pointScheduledRef.current) return;
    pointScheduledRef.current = true;
    requestAnimationFrame(() => {
      pointScheduledRef.current = false;
      const d = dragRef.current;
      const ptr = pointerRef.current;
      const snap = snapshotRef.current;
      if (!d || !ptr || !snap) return;
      post({
        type: 'appendMovePoints',
        epoch: epochRef.current,
        node: d.node,
        points: [{ step: snap.step, x: ptr.x, y: ptr.y }],
      });
    });
  }, [post]);

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDrag(null);
    pointerRef.current = null;

    // move 尚未发出（创建后立刻松手，且播放中）：直接丢弃，日志不留无效操作。
    if (pendingMoveRef.current) {
      pendingMoveRef.current = null;
      return;
    }

    const release = (s: number) => {
      post({
        type: 'finishMove',
        epoch: epochRef.current,
        node: d.node,
        releaseStep: s,
        releasePinned: d.wasPinned,
      });
    };

    if (playingRef.current && pendingReplyRef.current) {
      // 在途 advance：等回帧后用准确 step 释放（见 onmessage）。
      finishIntentRef.current = d;
    } else {
      const snap = snapshotRef.current;
      if (snap) release(snap.step);
    }
  }, [post]);

  const runChecks = useCallback(() => {
    setBusy(true);
    post({ type: 'check', epoch: epochRef.current });
  }, [post]);

  return {
    snapshot,
    config,
    playing,
    drag,
    report,
    busy,
    reset,
    togglePlay,
    step,
    togglePin,
    beginDrag,
    updateDrag,
    endDrag,
    runChecks,
  };
}
