// M14-11：owner-only 下图片走 Worker A JWT；`<img>` 需 fetch + blob URL

import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { getOwnerJwt } from '../lib/auth';
import { needsOwnerJwtImageFetch } from '../lib/mediaUrls';

type OwnerJwtImageProps = {
  readonly src: string;
  readonly alt?: string;
  readonly class?: string;
  readonly loading?: 'lazy' | 'eager';
  readonly decoding?: 'async' | 'sync' | 'auto';
  readonly sizes?: string;
};

/** 普通 Worker B /img/ URL 直出；/api/images/ 站主路径带 JWT fetch 后 blob 展示 */
export function OwnerJwtImage(props: OwnerJwtImageProps): VNode {
  const { src, alt = '', class: className, loading, decoding, sizes } = props;
  const jwtRequired = needsOwnerJwtImageFetch(src);
  const [displaySrc, setDisplaySrc] = useState(jwtRequired ? '' : src);

  useEffect(() => {
    if (!jwtRequired) {
      setDisplaySrc(src);
      return;
    }
    const jwt = getOwnerJwt();
    if (!jwt) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    void fetch(src, { headers: { Authorization: `Bearer ${jwt}` } })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setDisplaySrc(objectUrl);
      })
      .catch(() => {
        /* 图片加载失败时保持占位，不打断 Feed */
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, jwtRequired]);

  if (!displaySrc) {
    return (
      <div
        class={className}
        role="img"
        aria-label={alt || undefined}
        aria-busy="true"
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
    />
  );
}
