/** @jsxImportSource preact */
/**
 * UX-APPLE-9：图片全屏灯箱（ImageLightbox）
 * UX-APPLE-10：移动端滑动手势（左右滑切图、双指缩放、下滑关闭）
 *
 * 纯前端组件，给 PostCard / Profile 帖图网格点开用。
 * 行为要点：
 *  - 固定全屏 + 黑色半透明背景（bg-black/85）+ z-50
 *  - 键盘：左右切图 / ESC 关闭 / + - 缩放 / 0 重置
 *  - 滚轮缩放（带 ctrl/meta 修饰键避免误触）
 *  - 触控：单指水平滑 > 屏宽 25% 切图；垂直下滑 > 屏高 20% 关闭；
 *    双指缩放（pointer 双点算距离变化）；已缩放时滑动 = 平移
 *  - 单图时隐藏左右翻页按钮
 *  - mount 时锁 body 滚动，cleanup 复原
 *  - 单图点击图片本身 = 关闭；非图片区域（背景）点击 = 关闭
 *  - 不用任何 PII / 持久化；不读 storage / import.meta.env / fetch
 *
 * §F-02 红线：零 worker-a / WORKER_A_URL / localhost:8787 字面量；零 lib/api
 * 引用；零 storage / import.meta.env 访问。详见 .cursor/rules/04-frontend-guidelines.mdc。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CSSProperties, VNode } from 'preact';
import { t } from '../lib/i18n';
import { MediaImage } from './MediaImage';

/** 缩放下限 / 上限（CSS transform: scale 倍数） */
const MIN_SCALE = 1;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

/** 触屏手势阈值（按屏宽/屏高比例计算触发距离） */
const SWIPE_HORIZONTAL_RATIO = 0.25;
const SWIPE_VERTICAL_RATIO = 0.2;
/** 双指缩放最小变化像素（避免轻微抖动导致缩放跳变） */
const PINCH_MIN_DELTA = 8;
/** 位移超出容差前不算「已开始拖动」 */
const DRAG_START_THRESHOLD = 6;

export interface ImageLightboxProps {
  /** 待展示的图片 URL 列表（至少 1 张） */
  readonly images: readonly string[];
  /** 当前展示的下标（0-based） */
  readonly index: number;
  /** 关闭回调（ESC / 背景点击 / 关闭按钮） */
  readonly onClose: () => void;
  /** 切到指定下标回调（左右键 / 翻页按钮） */
  readonly onIndexChange?: (next: number) => void;
  /** 图片 alt 文本（用于 a11y） */
  readonly alt?: string;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function wrapIndex(next: number, total: number): number {
  if (total <= 0) return 0;
  const mod = ((next % total) + total) % total;
  return mod;
}

export function ImageLightbox({
  images,
  index,
  onClose,
  onIndexChange,
  alt,
}: ImageLightboxProps): VNode | null {
  const total = images.length;
  const safeIndex = clamp(index, 0, Math.max(0, total - 1));
  const currentSrc = total > 0 ? images[safeIndex] : '';
  const [scale, setScale] = useState(MIN_SCALE);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const hasMultiple = total > 1;

  // UX-APPLE-10b：scale 必须走 ref，pointer 监听器不能读闭包里的过期 scale
  const scaleRef = useRef(MIN_SCALE);
  const commitScale = (next: number): void => {
    const clamped = clamp(next, MIN_SCALE, MAX_SCALE);
    scaleRef.current = clamped;
    setScale(clamped);
  };

  // UX-APPLE-10：pointer 拖动状态机（单指 pan / 双指 pinch）
  // UX-APPLE-10b：suppressClickRef 吞掉手势结束后的合成 click，避免滑切图后又关灯箱
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const startDistanceRef = useRef<number>(0);
  const startScaleRef = useRef<number>(MIN_SCALE);
  const dragStartRef = useRef<{ x: number; y: number; index: number } | null>(null);
  const draggingRef = useRef<boolean>(false);
  const pinchActiveRef = useRef<boolean>(false);
  const suppressClickRef = useRef<boolean>(false);

  const armClickSuppress = (): void => {
    suppressClickRef.current = true;
  };
  const consumeSuppressedClick = (): boolean => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  // ESC / 方向键 / 缩放键；与 body 锁滚动
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKey(event: KeyboardEvent): void {
      // 不拦截用户输入（虽然灯箱全屏但保留扩展位）
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!hasMultiple) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        const next = wrapIndex(safeIndex + 1, total);
        onIndexChange?.(next);
        commitScale(MIN_SCALE);
        setTx(0);
        setTy(0);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        const next = wrapIndex(safeIndex - 1, total);
        onIndexChange?.(next);
        commitScale(MIN_SCALE);
        setTx(0);
        setTy(0);
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        commitScale(scaleRef.current + SCALE_STEP);
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        commitScale(scaleRef.current - SCALE_STEP);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        commitScale(MIN_SCALE);
        setTx(0);
        setTy(0);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [hasMultiple, safeIndex, total, onClose, onIndexChange]);

  // 切图时重置缩放/位移
  useEffect(() => {
    commitScale(MIN_SCALE);
    setTx(0);
    setTy(0);
  }, [safeIndex]);

  // UX-APPLE-10 / 10b：pointer 事件（单指 pan / 双指 pinch / 滑切图 / 滑关闭）
  // scale 一律读 scaleRef；手势确认后 armClickSuppress，合成 click 在捕获阶段吃掉
  useEffect(() => {
    if (typeof window === 'undefined') return;

    function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return Math.hypot(dx, dy);
    }

    function resetDragState(): void {
      pointersRef.current = new Map();
      startDistanceRef.current = 0;
      startScaleRef.current = MIN_SCALE;
      dragStartRef.current = null;
      draggingRef.current = false;
      pinchActiveRef.current = false;
    }

    function onPointerDown(event: PointerEvent): void {
      // 只响应 touch / pen，避免桌面鼠标误进入拖动状态机
      if (event.pointerType === 'mouse') return;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pointCount = pointersRef.current.size;
      if (pointCount === 1) {
        dragStartRef.current = { x: event.clientX, y: event.clientY, index: safeIndex };
        draggingRef.current = false;
        pinchActiveRef.current = false;
      } else if (pointCount === 2) {
        const points = Array.from(pointersRef.current.values());
        startDistanceRef.current = distance(points[0], points[1]);
        startScaleRef.current = scaleRef.current;
        dragStartRef.current = null;
        draggingRef.current = true;
        pinchActiveRef.current = false;
      }
    }

    function onPointerMove(event: PointerEvent): void {
      if (!pointersRef.current.has(event.pointerId)) return;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = Array.from(pointersRef.current.values());

      if (points.length === 2) {
        const currentDistance = distance(points[0], points[1]);
        const distDelta = Math.abs(currentDistance - startDistanceRef.current);
        // UX-APPLE-10b：未超过 PINCH_MIN_DELTA 不算 pinch，避免双指轻触抖动改 scale
        if (!pinchActiveRef.current) {
          if (distDelta < PINCH_MIN_DELTA) return;
          pinchActiveRef.current = true;
          armClickSuppress();
        }
        const base = startDistanceRef.current || 1;
        const ratio = currentDistance / base;
        const next = clamp(startScaleRef.current * ratio, MIN_SCALE, MAX_SCALE);
        scaleRef.current = next;
        setScale(next);
        return;
      }

      if (points.length === 1 && dragStartRef.current) {
        const start = dragStartRef.current;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!draggingRef.current) {
          if (Math.abs(dx) < DRAG_START_THRESHOLD && Math.abs(dy) < DRAG_START_THRESHOLD) {
            return;
          }
          draggingRef.current = true;
          armClickSuppress();
        }

        if (scaleRef.current > MIN_SCALE + 0.01) {
          setTx(dx);
          setTy(dy);
          return;
        }

        setTx(dx);
        setTy(Math.max(0, dy));
      }
    }

    function onPointerUp(event: PointerEvent): void {
      if (!pointersRef.current.has(event.pointerId)) return;
      const wasTwo = pointersRef.current.size === 2;
      pointersRef.current.delete(event.pointerId);
      if (wasTwo && pointersRef.current.size === 1) {
        const remaining = Array.from(pointersRef.current.values())[0];
        dragStartRef.current = { x: remaining.x, y: remaining.y, index: safeIndex };
        draggingRef.current = true;
        startDistanceRef.current = 0;
        pinchActiveRef.current = false;
        return;
      }
      if (pointersRef.current.size === 0) {
        const start = dragStartRef.current;
        const liveScale = scaleRef.current;
        if (start && draggingRef.current && liveScale <= MIN_SCALE + 0.01) {
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          const screenW = window.innerWidth || 1;
          const screenH = window.innerHeight || 1;
          if (hasMultiple && Math.abs(dx) > screenW * SWIPE_HORIZONTAL_RATIO && Math.abs(dx) > Math.abs(dy)) {
            armClickSuppress();
            if (dx < 0) goNext();
            else goPrev();
            setTx(0);
            setTy(0);
            resetDragState();
            return;
          }
          if (dy > screenH * SWIPE_VERTICAL_RATIO && Math.abs(dy) > Math.abs(dx)) {
            armClickSuppress();
            onClose();
            resetDragState();
            return;
          }
          setTx(0);
          setTy(0);
        }
        resetDragState();
      }
    }

    function onPointerCancel(): void {
      setTx(0);
      setTy(0);
      resetDragState();
    }

    // 手势结束后浏览器仍会派发 click：捕获阶段吃掉，避免滑切图后又关灯箱
    function onClickCapture(event: Event): void {
      if (!suppressClickRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = false;
    }

    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
    window.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('click', onClickCapture, true);
      resetDragState();
    };
  }, [hasMultiple, safeIndex, total, onClose]);

  if (total === 0) return null;

  function goPrev(): void {
    const next = wrapIndex(safeIndex - 1, total);
    onIndexChange?.(next);
  }
  function goNext(): void {
    const next = wrapIndex(safeIndex + 1, total);
    onIndexChange?.(next);
  }
  function bumpScale(delta: number): void {
    commitScale(scaleRef.current + delta);
  }
  function resetTransform(): void {
    commitScale(MIN_SCALE);
    setTx(0);
    setTy(0);
  }
  function onWheel(event: WheelEvent): void {
    // 仅在用户主动表达「想缩放」时（ctrl/meta 按下）生效；普通滚轮在桌面也用于翻页
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      bumpScale(event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP);
    } else if (hasMultiple) {
      // 无修饰键的滚轮 → 切图（更顺手）
      event.preventDefault();
      if (event.deltaY > 0) goNext();
      else if (event.deltaY < 0) goPrev();
    }
  }

  const transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  const imageStyle: CSSProperties = {
    transform,
    transformOrigin: 'center center',
    transition: 'transform 120ms ease-out',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || t('lightboxCloseAria')}
      onWheel={onWheel}
      onClick={(e) => {
        if (consumeSuppressedClick()) return;
        if (e.target === e.currentTarget) onClose();
      }}
      class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm"
    >
      {/* 顶部工具条：计数 + 缩放控件 + 关闭 */}
      <div class="absolute inset-x-0 top-0 flex items-center justify-between gap-2 px-4 py-3 text-sm text-white">
        <span aria-live="polite" class="tabular-nums">
          {hasMultiple ? `${safeIndex + 1} / ${total}` : ''}
        </span>
        <div class="flex items-center gap-1">
          <button
            type="button"
            onClick={() => bumpScale(-SCALE_STEP)}
            disabled={scale <= MIN_SCALE}
            aria-label={t('lightboxZoomOut')}
            title={t('lightboxZoomOut')}
            class="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden="true" class="text-lg leading-none">−</span>
          </button>
          <button
            type="button"
            onClick={() => bumpScale(SCALE_STEP)}
            disabled={scale >= MAX_SCALE}
            aria-label={t('lightboxZoomIn')}
            title={t('lightboxZoomIn')}
            class="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden="true" class="text-lg leading-none">+</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('lightboxCloseAria')}
            title={t('lightboxClose')}
            class="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.25"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </div>
      </div>

      {/* 上一张 */}
      {hasMultiple && (
        <button
          type="button"
          onClick={goPrev}
          aria-label={t('lightboxPrevAria')}
          title={t('lightboxPrev')}
          class="absolute left-2 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 sm:left-4"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.25"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}

      {/* 当前图：点击图片 = 重置缩放或关闭；双击 = 缩放切换 */}
      <div class="flex max-h-[80vh] max-w-[90vw] items-center justify-center">
        <button
          type="button"
          onClick={() => {
            if (consumeSuppressedClick()) return;
            if (scaleRef.current > MIN_SCALE) resetTransform();
            else onClose();
          }}
          onDblClick={() => {
            bumpScale(scale >= MAX_SCALE ? -MAX_SCALE + MIN_SCALE : SCALE_STEP * 2);
          }}
          class="block max-h-[80vh] max-w-[90vw] cursor-zoom-in overflow-hidden rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <MediaImage
            key={currentSrc}
            src={currentSrc}
            alt={alt || ''}
            decoding="async"
            style={imageStyle}
            class="max-h-[80vh] max-w-[90vw] select-none object-contain shadow-2xl"
            draggable={false}
          />
        </button>
      </div>

      {/* 下一张 */}
      {hasMultiple && (
        <button
          type="button"
          onClick={goNext}
          aria-label={t('lightboxNextAria')}
          title={t('lightboxNext')}
          class="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 sm:right-4"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.25"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}

      {/* UX-APPLE-10：移动端触屏提示（< sm 显示）+ 全局 sr-only 描述（读屏用户） */}
      <p
        class="pointer-events-none absolute inset-x-0 bottom-4 px-4 text-center text-xs text-white/70 sm:hidden"
        aria-hidden="true"
      >
        {t('lightboxHintSwipe')}
      </p>
      <span class="sr-only">{t('lightboxHintSwipe')} · {t('lightboxHintPinch')}</span>
    </div>
  );
}
