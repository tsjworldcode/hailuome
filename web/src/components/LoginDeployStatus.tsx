/** @jsxImportSource preact */
/**
 * 登录页部署状态只读面板（M7-26d）。
 * 仅展示绑定与否 / 网关形态 / 版本；不渲染 Worker B host（避免登录页暴露公开读 URL）。
 */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  detectOwnerGatewayMode,
  readRawDeployEndpoint,
  resolveRawDeployEndpoint,
} from '../lib/deployEndpoint';
import { t } from '../lib/i18n';

const siteVersion = signal<string>('');
const apiBound = signal<boolean>(false);
const gatewayMode = signal<'pages' | 'direct' | 'unbound'>('unbound');
const loaded = signal<boolean>(false);

async function loadDeployStatus(): Promise<void> {
  const rawWorkerB = readRawDeployEndpoint() ?? (await resolveRawDeployEndpoint());
  // 中文注释：内部探测用完整 URL；UI 只显示「已绑定/未绑定」
  apiBound.value = Boolean(rawWorkerB);
  gatewayMode.value = detectOwnerGatewayMode(rawWorkerB);

  try {
    const res = await fetch('/site-version.json', { cache: 'no-store' });
    const parsed = (await res.json()) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      siteVersion.value = parsed.version.trim();
    }
  } catch {
    siteVersion.value = '';
  }

  loaded.value = true;
}

function StatusRow(props: { readonly label: string; readonly value: string; readonly ok?: boolean }): VNode {
  const tone =
    props.ok === true
      ? 'text-emerald-700 dark:text-emerald-300'
      : props.ok === false
        ? 'text-amber-800 dark:text-amber-200'
        : 'text-fg2';
  return (
    <div class="flex items-start justify-between gap-3 text-xs leading-5">
      <span class="shrink-0 text-zinc-500 dark:text-zinc-400">{props.label}</span>
      <span class={`text-right font-medium ${tone}`}>{props.value}</span>
    </div>
  );
}

export function LoginDeployStatus(): VNode {
  useEffect(() => {
    if (loaded.value) return;
    void loadDeployStatus();
  }, []);

  const apiLabel = apiBound.value ? t('loginDeployBound') : t('loginDeployUnbound');
  const gatewayLabel =
    gatewayMode.value === 'pages'
      ? t('loginDeployGatewayPages')
      : gatewayMode.value === 'direct'
        ? t('loginDeployGatewayDirect')
        : t('loginDeployGatewayUnconfigured');

  return (
    <section
      class="mt-5 rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-4 py-3 text-left dark:border-zinc-700 dark:bg-zinc-900/60"
      aria-label={t('loginDeployAria')}
      role="status"
    >
      <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {t('loginDeployTitle')}
      </h2>
      <div class="space-y-1.5">
        <StatusRow
          label={t('loginDeployPublicApi')}
          value={loaded.value ? apiLabel : t('loginDeployChecking')}
          ok={apiBound.value}
        />
        <StatusRow
          label={t('loginDeployOwnerGateway')}
          value={loaded.value ? gatewayLabel : t('loginDeployChecking')}
          ok={gatewayMode.value !== 'unbound'}
        />
        {siteVersion.value ? (
          <StatusRow label={t('loginDeploySiteVersion')} value={`v${siteVersion.value}`} />
        ) : null}
      </div>
    </section>
  );
}
