/**
 * SEC-AUDIT-2026-10-6b · 媒体图片渲染组件（票据接线 + 失败降级）。
 *
 * 【职责】
 *   把 Worker B 的 `/img/:key` 图片按「票据可用性」渲染出来，并在失败时**降级**，
 *   保证 Feed 不出现白屏 / 破图。
 *
 * 【降级阶梯】
 *   1. 裸 URL（public-read 档最省：走公开缓存，零额外请求）
 *   2. 票据 URL（protected 档：`?ticket=`，批量取票，URL 自带授权）
 *   3. 票据过期 / 被拒 → 作废缓存换新票重试一次
 *   4. 仍失败 → JS fetch（带粉丝 Token）→ Blob → objectURL
 *   5. 全失败 → 中性占位块（版面不塌，绝不白屏）
 *
 * 【省请求策略】
 *   - 未确认 protected 档时**先试裸 URL**（public-read 档零额外开销）；
 *     一旦裸 URL 失败，批量取票（同一时间窗内多张图合并成一次请求）。
 *   - 票据 URL 加载成功后即记住「本会话是 protected 档」，
 *     后续图片直接走票据路径，不再逐张试错。
 *   - SEC-AUDIT-2026-10-9：已确认 protected 时**首帧不挂裸 URL**（占位等票），
 *     并用 inFlight 互斥，避免 onError 与 useEffect 并发二次取票 / 401 风暴。
 *
 * 【站主 JWT 路径】
 *   `/api/images/:key`（owner-only 档）仍由 `OwnerJwtImage` 处理（JWT + Blob），
 *   本组件只做**委派**，不重复实现。
 *
 * §F-02：本组件不含 Worker A 地址字面量。
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { CSSProperties, VNode } from 'preact';
import { needsOwnerJwtImageFetch } from '../lib/mediaUrls';
import {
  buildTicketedImageUrl,
  ensureMediaTicket,
  fetchMediaAsBlobUrl,
  isProtectedMediaModeDetected,
  markProtectedMediaModeDetected,
  parseMediaImageUrl,
  refreshMediaTicket,
} from '../lib/mediaTickets';
import { OwnerJwtImage } from './OwnerJwtImage';

export interface MediaImageProps {
  readonly src: string;
  readonly alt?: string;
  readonly class?: string;
  readonly loading?: 'lazy' | 'eager';
  readonly decoding?: 'async' | 'sync' | 'auto';
  readonly sizes?: string;
  /** 透传给 `<img>` 的行内样式（灯箱缩放位移用） */
  readonly style?: CSSProperties;
  /** 透传给 `<img>` 的 draggable（灯箱禁拖拽用） */
  readonly draggable?: boolean;
  /** 装饰性图片（头像等）：置 aria-hidden，避免读屏念空 alt */
  readonly ariaHidden?: boolean;
}

/** 渲染阶段：plain=裸 URL / pending=等票占位 / ticketed=带票 / blob=JS fetch 兜底 / failed=占位 */
type RenderPhase = 'plain' | 'pending' | 'ticketed' | 'blob' | 'failed';

export function MediaImage(props: MediaImageProps): VNode {
  const {
    src,
    alt = '',
    class: className,
    loading,
    decoding,
    sizes,
    style,
    draggable,
    ariaHidden,
  } = props;

  const isOwnerPath = needsOwnerJwtImageFetch(src);
  const mediaTarget = !isOwnerPath ? parseMediaImageUrl(src) : null;
  const isMediaPath = mediaTarget !== null;
  // 首帧即知 protected：不要先挂裸 URL（否则 401 → onError 与 effect 双取票）
  const preferTicketFirst =
    Boolean(mediaTarget && isProtectedMediaModeDetected(mediaTarget.origin));

  const [phase, setPhase] = useState<RenderPhase>(preferTicketFirst ? 'pending' : 'plain');
  const [displaySrc, setDisplaySrc] = useState(preferTicketFirst ? '' : src);
  /** 票据重试只允许一次（避免坏票据导致无限循环打服务端） */
  const ticketRetriedRef = useRef(false);
  /** 取票飞行锁：effect 与 onError 不得并发二次 applyTicket */
  const ticketInFlightRef = useRef(false);
  const blobUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  /** 降级：JS fetch（粉丝 Token）→ Blob → objectURL */
  const fallbackToBlob = async (): Promise<void> => {
    const blobUrl = await fetchMediaAsBlobUrl(src);
    if (cancelledRef.current) {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      return;
    }
    if (!blobUrl) {
      setPhase('failed');
      return;
    }
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = blobUrl;
    setDisplaySrc(blobUrl);
    setPhase('blob');
  };

  /** 取票据并切换到票据 URL；取不到则退回 Blob 兜底。 */
  const applyTicket = async (): Promise<void> => {
    if (ticketInFlightRef.current) return;
    ticketInFlightRef.current = true;
    try {
      let ticket: string | null = null;
      try {
        ticket = await ensureMediaTicket(src);
      } catch {
        ticket = null;
      }
      if (cancelledRef.current) return;
      if (ticket) {
        setDisplaySrc(buildTicketedImageUrl(src, ticket));
        setPhase('ticketed');
        return;
      }
      // 取不到票 → 退到 Bearer fetch（若本来就是裸 URL 失败，则一并走 Blob）
      await fallbackToBlob();
    } finally {
      ticketInFlightRef.current = false;
    }
  };

  useEffect(() => {
    cancelledRef.current = false;
    ticketRetriedRef.current = false;
    ticketInFlightRef.current = false;

    // 非媒体路径（外部头像等）与站主 JWT 路径：不做票据处理
    if (isOwnerPath || !isMediaPath) {
      setPhase('plain');
      setDisplaySrc(src);
      return () => {
        cancelledRef.current = true;
      };
    }

    // 已确认 protected 档（按 origin）：占位等票，禁止首帧裸 URL
    if (mediaTarget && isProtectedMediaModeDetected(mediaTarget.origin)) {
      setPhase('pending');
      setDisplaySrc('');
      void applyTicket();
    } else {
      setPhase('plain');
      setDisplaySrc(src);
    }

    return () => {
      cancelledRef.current = true;
    };
  }, [src, isOwnerPath, isMediaPath]);

  // 释放 Blob URL，避免内存泄漏
  useEffect(
    () => () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    },
    [],
  );

  /** 图片加载成功：票据路径可用 → 记住该 origin 是 protected 档 */
  const handleLoad = (): void => {
    if (phase === 'ticketed' && mediaTarget) {
      markProtectedMediaModeDetected(mediaTarget.origin);
    }
  };

  /** 图片加载失败时的降级处理（裸 URL → 票据 → 换票重试 → Bearer fetch → 占位） */
  const handleError = (): void => {
    if (!isMediaPath) {
      setPhase('failed');
      return;
    }
    // pending 无 <img>，理论上不会进；纵深防御：忽略
    if (phase === 'pending') return;
    if (phase === 'plain') {
      // 裸 URL 失败 → 取票据再试一次（inFlight 锁防与 effect 重叠）
      void applyTicket();
      return;
    }
    if (phase === 'ticketed' && !ticketRetriedRef.current) {
      // 票据过期 / 被拒：作废缓存换一张新票再试一次
      ticketRetriedRef.current = true;
      void (async () => {
        let fresh: string | null = null;
        try {
          fresh = await refreshMediaTicket(src);
        } catch {
          fresh = null;
        }
        if (cancelledRef.current) return;
        if (fresh) {
          // 换新票后再试；仍失败会再次进本分支（ticketRetriedRef 已置位）→ 走 Blob 兜底
          setDisplaySrc(buildTicketedImageUrl(src, fresh));
          return;
        }
        await fallbackToBlob();
      })();
      return;
    }
    if (phase === 'ticketed') {
      // 换新票仍失败 → 最后一档：Bearer fetch → Blob
      void fallbackToBlob();
      return;
    }
    if (phase === 'blob') {
      // Blob 已失败过一次，不再重试
      setPhase('failed');
      return;
    }
    setPhase('failed');
  };

  // 站主 JWT 路径（owner-only 档）：委派给 OwnerJwtImage
  if (isOwnerPath) {
    return (
      <OwnerJwtImage
        src={src}
        alt={alt}
        class={className}
        loading={loading}
        decoding={decoding}
        sizes={sizes}
      />
    );
  }

  if (phase === 'failed' || !displaySrc) {
    return (
      <div
        class={className}
        style={style}
        role="img"
        aria-label={alt || undefined}
        aria-hidden={ariaHidden ? 'true' : undefined}
        aria-busy={phase === 'failed' ? undefined : 'true'}
      />
    );
  }

  return (
    <img
      src={displaySrc}
      alt={alt}
      loading={loading}
      decoding={decoding}
      sizes={sizes}
      class={className}
      style={style}
      draggable={draggable}
      aria-hidden={ariaHidden ? 'true' : undefined}
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}
