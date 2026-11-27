/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n';

interface QRCodeBadgeProps {
  readonly value: string;
  readonly label: string;
  readonly class?: string;
  /** 展示边长（px），默认 128；群邀请等长内容可用 160 */
  readonly size?: number;
}

export function QRCodeBadge(props: QRCodeBadgeProps): VNode {
  const [src, setSrc] = useState<string>('');
  const size = props.size && props.size > 0 ? props.size : 128;

  useEffect(() => {
    let cancelled = false;
    if (!props.value) {
      setSrc('');
      return;
    }
    // M13-5：Profile 页 mount 时再拉 qrcode，避免打进首屏公共 chunk
    void import('qrcode')
      .then((mod) => mod.default.toDataURL(props.value, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 6,
        color: {
          dark: '#09090b',
          light: '#ffffff',
        },
      }))
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc('');
      });
    return () => {
      cancelled = true;
    };
  }, [props.value]);

  const boxClass = 'rounded-md border border-zinc-200 bg-white p-1 dark:border-zinc-700';

  return (
    <div class={props.class}>
      {src ? (
        <img
          src={src}
          alt={props.label}
          width={size}
          height={size}
          class={boxClass}
          style={{ width: `${size}px`, height: `${size}px` }}
        />
      ) : (
        <div
          class={`flex items-center justify-center border-dashed border-zinc-300 bg-zinc-50 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 ${boxClass}`}
          style={{ width: `${size}px`, height: `${size}px` }}
          role="img"
          aria-label={props.label}
        >
          {t('qrGenerating')}
        </div>
      )}
    </div>
  );
}
