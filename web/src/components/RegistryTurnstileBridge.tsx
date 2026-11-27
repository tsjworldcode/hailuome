/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  getRegistryTurnstileBridgeUrl,
  getRegistryUrlFallback,
  isRegistryOrigin,
  REGISTRY_TURNSTILE_BRIDGE_PATH,
} from '../lib/registryUrl';
import { t } from '../lib/i18n';

interface Props {
  /** 目标注册中心 API 根地址；省略时用构建时回退值 */
  readonly registryUrl?: string;
  readonly onToken: (token: string) => void;
  readonly onExpire?: () => void;
  readonly onError?: () => void;
}

/** 在注册中心域名做人机验证（iframe），节点无需配置 Turnstile 域名白名单 */
export function RegistryTurnstileBridge({
  registryUrl: registryUrlProp,
  onToken,
  onExpire,
  onError,
}: Props): VNode | null {
  const registryUrl = registryUrlProp?.trim()
    ? registryUrlProp.trim().replace(/\/$/, '')
    : getRegistryUrlFallback();
  const parentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const bridgeUrl = parentOrigin ? getRegistryTurnstileBridgeUrl(parentOrigin, registryUrl) : '';
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!parentOrigin) return;

    function onMessage(ev: MessageEvent): void {
      if (!isRegistryOrigin(ev.origin, registryUrl)) return;
      const data = ev.data as { type?: string; token?: string } | null;
      if (!data || typeof data.type !== 'string') return;

      if (data.type === 'hailuo:turnstile:token' && typeof data.token === 'string') {
        setLoadFailed(false);
        onToken(data.token);
        return;
      }
      if (data.type === 'hailuo:turnstile:expire') {
        onExpire?.();
        return;
      }
      if (data.type === 'hailuo:turnstile:error') {
        setLoadFailed(true);
        onError?.();
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [registryUrl, parentOrigin, onToken, onExpire, onError]);

  if (!bridgeUrl) return null;

  return (
    <div class="space-y-2">
      <iframe
        title={t('registryTurnstileIframeTitle')}
        src={bridgeUrl}
        class="block h-[72px] w-full border-0 bg-transparent"
        sandbox="allow-scripts allow-same-origin allow-popups"
        onError={() => {
          setLoadFailed(true);
          onError?.();
        }}
      />
      <p class="text-xs text-zinc-500 dark:text-zinc-400">
        {t('registryTurnstileHint')}
      </p>
      {loadFailed && (
        <p class="text-xs text-amber-700 dark:text-amber-300">
          {t('registryTurnstileLoadFailedPrefix')}{' '}
          <code class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{REGISTRY_TURNSTILE_BRIDGE_PATH}</code>
          {t('registryTurnstileLoadFailedMiddle')}{' '}
          <code class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">examples/registry-turnstile-bridge.html</code>
          {t('registryTurnstileLoadFailedSuffix')}
        </p>
      )}
    </div>
  );
}
