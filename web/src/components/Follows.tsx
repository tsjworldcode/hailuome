/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal, computed } from '@preact/signals';
import { stripTrailingSlash } from '../lib/auth';
import { clearOwnerSessionForLogin } from '../lib/ownerSession';
import { createWorkerAClient, type FollowItem, type FollowPullProbeItem } from '../lib/workerA';
import { ApiError, getErrorMessage } from '../lib/errors';
import { formatRelativeTime } from '../lib/timeFormat';
import { buildWorkerBImageUrl } from '../lib/mediaUrls';
import {
  ownerBaseUrl,
  ownerCredentialsReady,
  ownerJwt,
  useOwnerCredentials,
} from '../lib/useOwnerCredentials';
import { t } from '../lib/i18n';
import { formatPublicHandleDisplay } from '../lib/handleDisplay';
import { QrScannerPanel } from './QrScannerPanel';
import { ConfirmDialog } from './ConfirmDialog';
import { UserMinus } from 'lucide-preact';
import { parseAddFriendUri } from '../lib/hailuoUri';
import { showToast } from '../lib/toast';

// M7-4：关注管理
//
// 设计要点：
// - 双 gate：未配 Worker A 地址 → 引导卡跳设置 / 未登录 → 引导卡跳设置
// - 列出关注：调 workerA.listFollows()；展示节点 URL、关注时间、last_active、fail_count
// - 添加关注：表单 → URL 校验（http/https 协议白名单 + host 非空，避免 javascript: / data: 注入）
//   + 去尾斜杠（保持与 Worker A D1 内存储格式一致）→ createFollow(nodeUrl) → 列表前插
// - 取消关注：ConfirmDialog 二次确认 → deleteFollow(nodeUrl) → 列表移除
// - 错误处理：ApiError.displayMessage 中文映射 + 表单内 rose-50 / 列表顶部 rose-50 两处分别显示
// - §F-02：本组件用 auth.ts.getWorkerAUrl 运行时读取 Worker A 地址，绝不读 import.meta.env.WORKER_A_URL

const follows = signal<readonly FollowItem[]>([]);
const total = signal<number>(0);
const loading = signal<boolean>(false);
const errorMsg = signal<string | null>(null);

const newUrl = signal<string>('');
const newHandle = signal<string>('');
const adding = signal<boolean>(false);
const addError = signal<string | null>(null);
const addSuccess = signal<string | null>(null);

/** 正在删除的节点 URL（同一时间只允许一个删除请求） */
const deletingUrl = signal<string | null>(null);
const unfollowTarget = signal<FollowItem | null>(null);
const unfollowPending = signal<boolean>(false);
const probingPulls = signal<boolean>(false);
const probeMsg = signal<string | null>(null);
const probeItems = signal<readonly FollowPullProbeItem[]>([]);

const newUrlTrimmed = computed(() => newUrl.value.trim());
const addIsFriendLink = computed(() => /^hailuo:/i.test(newUrlTrimmed.value));

/** 粘贴/扫码 hailuo://add-friend 链接：直接发好友请求，不走“关注节点”路径。 */
async function addFriendFromUri(raw: string): Promise<void> {
  addError.value = null;
  addSuccess.value = null;
  const parsed = parseAddFriendUri(raw.trim());
  if (!parsed.ok) {
    addError.value = t('friendUriInvalid');
    showToast(t('friendUriInvalid'), 'error');
    return;
  }
  const base = ownerBaseUrl.value;
  const jwt = ownerJwt.value;
  if (!base || !jwt) {
    addError.value = t('ownerConfigureWriteLayer');
    return;
  }
  newUrl.value = parsed.data.node;
  try {
    const client = createWorkerAClient({ baseUrl: base, getJwt: () => jwt });
    await client.sendFriendRequest({
      target_node_url: parsed.data.node,
      target_handle: parsed.data.handle,
    });
    addSuccess.value = t('friendSent');
    showToast(t('friendSent'));
  } catch (err) {
    const msg = err instanceof ApiError ? err.displayMessage : t('friendUriInvalid');
    addError.value = msg;
    showToast(msg, 'error');
  }
}

function followDisplayName(follow: FollowItem): string {
  // 有昵称用昵称；否则用正式名（主中心裸名 / 其它 @regN）
  return follow.display_name || (follow.handle ? formatPublicHandleDisplay(follow.handle) : t('followsUnknownNode'));
}

function followHandleLabel(follow: FollowItem): string {
  return follow.handle ? formatPublicHandleDisplay(follow.handle) : t('followsHandleMissing');
}

function followRegistryMetaLines(follow: FollowItem): string[] {
  const lines: string[] = [];
  if (follow.user_id) {
    lines.push(`${t('followsUserId')}${follow.user_id}`);
  }
  if (follow.registry_status) {
    lines.push(`${t('followsRegistryStatus')}${follow.registry_status}`);
  }
  if (follow.health_status) {
    lines.push(`${t('followsHealthStatus')}${follow.health_status}`);
  }
  if (follow.pubkey_fingerprint) {
    lines.push(`${t('followsPubkeyFingerprint')}${follow.pubkey_fingerprint}`);
  }
  return lines;
}

function avatarLetter(follow: FollowItem): string {
  const source = follow.handle || follow.display_name || 'H';
  return (source.trim().charAt(0) || 'H').toUpperCase();
}

function avatarHue(follow: FollowItem): number {
  const source = follow.handle || follow.node_url;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

function followAvatarUrl(follow: FollowItem): string {
  const workerBUrl = follow.worker_b_url || follow.node_url;
  if (!follow.avatar_key || !workerBUrl) return '';
  return buildWorkerBImageUrl(workerBUrl, follow.avatar_key);
}

/**
 * 校验节点 URL：必须 http/https 协议，必须有 host，去尾斜杠。
 * 成功返回规范化 URL；失败抛出包含中文消息的 Error。
 */
export function validateNodeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(t('followsValidateUrlEmpty'));
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(t('followsValidateUrlInvalid'));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(t('followsValidateUrlProtocol'));
  }
  if (!parsed.host) {
    throw new Error(t('followsValidateUrlNoHost'));
  }
  return stripTrailingSlash(parsed.toString());
}

async function loadList(): Promise<void> {
  const currentBaseUrl = ownerBaseUrl.value;
  const currentJwt = ownerJwt.value;
  if (!currentBaseUrl || !currentJwt) return;

  loading.value = true;
  errorMsg.value = null;

  const client = createWorkerAClient({
    baseUrl: currentBaseUrl,
    getJwt: () => currentJwt,
  });

  try {
    const list = await client.listFollows();
    follows.value = list.items;
    total.value = list.total;
  } catch (err) {
    if (err instanceof ApiError) {
      errorMsg.value = err.displayMessage;
    } else {
      errorMsg.value = getErrorMessage({}, t('followsLoadFailed'));
    }
  } finally {
    loading.value = false;
  }
}

async function handleAdd(e: Event): Promise<void> {
  e.preventDefault();
  addError.value = null;
  addSuccess.value = null;

  // 支持直接粘贴 hailuo://add-friend 链接：自动发好友请求，而不是当节点 URL 校验。
  if (addIsFriendLink.value) {
    await addFriendFromUri(newUrl.value);
    return;
  }

  let normalized: string;
  try {
    normalized = validateNodeUrl(newUrl.value);
  } catch (err) {
    addError.value = err instanceof Error ? err.message : t('followsValidateFailed');
    return;
  }

  const currentBaseUrl = ownerBaseUrl.value;
  const currentJwt = ownerJwt.value;
  if (!currentBaseUrl || !currentJwt) {
    addError.value = t('followsConfigureFirst');
    return;
  }

  adding.value = true;
  const client = createWorkerAClient({
    baseUrl: currentBaseUrl,
    getJwt: () => currentJwt,
  });

  try {
    // M-OPT-1c：显式写入 worker_b_url，保证 follows 行可作 L1 解析锚点；
    // 可选 handle：URL 关注也能把对方 handle 写进 follows，时间线不再回落到节点名。
    const handle = newHandle.value.trim().replace(/^@+/, '').toLowerCase();
    const created = await client.createFollow(normalized, {
      worker_b_url: normalized,
      ...(handle ? { handle } : {}),
    });
    // 直接前插新关注（last_active / fail_count 用默认值，后续 Cron 拉取后会刷新）
    const newItem: FollowItem = {
      id: created.id,
      node_url: created.node_url,
      handle: created.handle,
      display_name: created.display_name,
      avatar_key: created.avatar_key,
      worker_b_url: created.worker_b_url,
      user_id: '',
      registry_status: '',
      health_status: '',
      pubkey_fingerprint: '',
      followed_at: created.followed_at,
      last_active: null,
      fail_count: 0,
    };
    follows.value = [newItem, ...follows.value];
    total.value = total.value + 1;
    newUrl.value = '';
    newHandle.value = '';
    addSuccess.value = created.handle
      ? t('followsAddSuccessWithHandle', undefined, {
          handle: formatPublicHandleDisplay(created.handle) || created.handle,
        })
      : t('followsAddSuccess');
  } catch (err) {
    if (err instanceof ApiError) {
      addError.value = err.displayMessage;
    } else {
      addError.value = getErrorMessage({}, t('followsAddFailed'));
    }
  } finally {
    adding.value = false;
  }
}

function openUnfollowDialog(follow: FollowItem): void {
  unfollowTarget.value = follow;
}

async function confirmUnfollow(): Promise<void> {
  const target = unfollowTarget.value;
  if (!target) return;

  const currentBaseUrl = ownerBaseUrl.value;
  const currentJwt = ownerJwt.value;
  if (!currentBaseUrl || !currentJwt) return;

  unfollowPending.value = true;
  deletingUrl.value = target.node_url;
  errorMsg.value = null;
  const client = createWorkerAClient({
    baseUrl: currentBaseUrl,
    getJwt: () => currentJwt,
  });

  try {
    await client.deleteFollow(target.node_url);
    follows.value = follows.value.filter((f) => f.node_url !== target.node_url);
    total.value = Math.max(0, total.value - 1);
    unfollowTarget.value = null;
  } catch (err) {
    if (err instanceof ApiError) {
      errorMsg.value = err.displayMessage;
    } else {
      errorMsg.value = getErrorMessage({}, t('followsUnfollowFailed'));
    }
  } finally {
    unfollowPending.value = false;
    deletingUrl.value = null;
  }
}

function trimProbeSnippet(value: string | null): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '—';
  return trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
}

async function handleProbePulls(): Promise<void> {
  const currentBaseUrl = ownerBaseUrl.value;
  const currentJwt = ownerJwt.value;
  if (!currentBaseUrl || !currentJwt || probingPulls.value) return;

  probingPulls.value = true;
  probeMsg.value = null;
  const client = createWorkerAClient({
    baseUrl: currentBaseUrl,
    getJwt: () => currentJwt,
  });

  try {
    const result = await client.probeFollowNodePulls();
    probeItems.value = result.items;
    const failed = result.items.filter((item) => !item.ok).length;
    probeMsg.value = failed > 0
      ? t('followsProbeDoneFailed', undefined, { failed, total: result.items.length })
      : t('followsProbeDoneOk', undefined, { total: result.items.length });
  } catch (err) {
    probeMsg.value = err instanceof ApiError
      ? err.displayMessage
      : getErrorMessage({}, t('followsProbeFailed'));
  } finally {
    probingPulls.value = false;
  }
}

export function Follows(): VNode {
  useOwnerCredentials(() => {
    if (ownerBaseUrl.value && ownerJwt.value) {
      void loadList();
    }
  });
  if (!ownerCredentialsReady.value) {
    // 整站登录态由 SiteAuthGate 统一展示；子页面避免重复渲染“正在校验登录状态…”残留在内容底部。
    return <div aria-busy="true" />;
  }

  // gate 1：部署入口缺失。生产应由 PUBLIC_WORKER_B_URL / deploy-env.json 自动注入。
  if (ownerBaseUrl.value === null) {
    return (
      <section class="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm leading-6 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
        <h2 class="text-base font-semibold">{t('followsGateEndpointTitle')}</h2>
        <p class="mt-2">{t('followsGateEndpointBody')}</p>
        <a
          href="/settings"
          class="mt-3 inline-block rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700"
        >
          {t('followsGoSettings')}
        </a>
      </section>
    );
  }

  // gate 2：会话失效
  if (ownerJwt.value === null) {
    return (
      <section class="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm leading-6 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
        <h2 class="text-base font-semibold">{t('followsGateSessionTitle')}</h2>
        <p class="mt-2">{t('followsGateSessionBody')}</p>
        <button
          type="button"
          class="mt-3 inline-block rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700"
          onClick={clearOwnerSessionForLogin}
        >
          {t('followsBackLogin')}
        </button>
      </section>
    );
  }

  return (
    <div class="space-y-5">
      <header class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h1 class="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-50">{t('followsTitle')}</h1>
          <div class="flex items-center gap-2">
            <span class="text-xs text-slate-500 dark:text-zinc-400">{t('followsTotal', undefined, { count: total.value })}</span>
            <button
              type="button"
              disabled={probingPulls.value || follows.value.length === 0}
              onClick={() => { void handleProbePulls(); }}
              class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {probingPulls.value ? t('followsProbing') : t('followsProbeButton')}
            </button>
          </div>
        </div>
        <p class="mt-1 text-xs text-slate-500 dark:text-zinc-400">
          {t('followsDescription')}
        </p>
      </header>

      {(probeMsg.value || probeItems.value.length > 0) && (
        <section class="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-sm font-semibold text-slate-900 dark:text-zinc-50">{t('followsProbeTitle')}</h2>
            <button
              type="button"
              class="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              onClick={() => {
                probeMsg.value = null;
                probeItems.value = [];
              }}
            >
              {t('followsProbeCollapse')}
            </button>
          </div>
          {probeMsg.value && (
            <p class="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {probeMsg.value}
            </p>
          )}
          {probeItems.value.length > 0 && (
            <ul class="mt-3 divide-y divide-slate-200 overflow-hidden rounded-md border border-slate-200 text-xs dark:divide-zinc-800 dark:border-zinc-800">
              {probeItems.value.map((item) => (
                <li key={item.fetch_url} class="space-y-1 bg-white p-3 dark:bg-zinc-950">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class={item.ok ? 'rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-700 dark:bg-rose-950 dark:text-rose-300'}>
                      {item.ok ? t('followsProbeOk') : t('followsProbeFail')}
                    </span>
                    <span class="text-slate-500 dark:text-zinc-400">
                      {t('followsProbeMeta', undefined, {
                        status: item.http_status ?? '—',
                        count: item.post_count,
                        retry: item.token_retry ? t('followsProbeYes') : t('followsProbeNo'),
                      })}
                    </span>
                  </div>
                  <dl class="space-y-1 text-slate-600 dark:text-zinc-400">
                    <div class="min-w-0">
                      <dt class="inline font-medium text-slate-700 dark:text-zinc-300">{t('followsProbeFetchUrl')}</dt>
                      <dd class="inline break-all font-mono">{item.posts_url}</dd>
                    </div>
                    <div class="min-w-0">
                      <dt class="inline font-medium text-slate-700 dark:text-zinc-300">{t('followsProbeRecordUrl')}</dt>
                      <dd class="inline break-all font-mono">{item.fetch_url}</dd>
                    </div>
                    {!item.ok && (
                      <>
                        <div class="min-w-0">
                          <dt class="inline font-medium text-slate-700 dark:text-zinc-300">{t('followsProbeError')}</dt>
                          <dd class="inline break-words">{item.error ?? t('followsProbeUnknownError')}</dd>
                        </div>
                        <div class="min-w-0">
                          <dt class="inline font-medium text-slate-700 dark:text-zinc-300">{t('followsProbeSnippet')}</dt>
                          <dd class="inline break-words">{trimProbeSnippet(item.body_snippet)}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 class="text-sm font-semibold text-slate-900 dark:text-zinc-50">{t('followsAddTitle')}</h2>
        <form class="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => void handleAdd(e)}>
          <input
            type="text"
            inputMode="url"
            placeholder={t('followsAddPlaceholder')}
            class="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:placeholder:text-zinc-500"
            value={newUrl.value}
            onInput={(e) => (newUrl.value = (e.currentTarget as HTMLInputElement).value)}
            disabled={adding.value}
            aria-label={t('followsNodeAddress')}
            required
          />
          <input
            type="text"
            inputMode="text"
            placeholder={t('followsHandleOptional')}
            class="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:placeholder:text-zinc-500"
            value={newHandle.value}
            onInput={(e) => (newHandle.value = (e.currentTarget as HTMLInputElement).value)}
            disabled={adding.value}
            aria-label={t('followsHandleOptional')}
          />
          <button
            type="submit"
            class="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={adding.value || newUrlTrimmed.value === ''}
          >
            {adding.value ? t('followsAdding') : addIsFriendLink.value ? t('addFriend') : t('followsAdd')}
          </button>
        </form>
        <p class="mt-2 text-xs text-slate-500 dark:text-zinc-400">{t('followsHandleOptionalHint')}</p>
        {addError.value && (
          <p class="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100" role="alert" aria-live="polite">
            {addError.value}
          </p>
        )}
        {addSuccess.value && (
          <p class="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100" role="status" aria-live="polite">
            {addSuccess.value}
          </p>
        )}
        <QrScannerPanel
          onResult={(value) => {
            addError.value = null;
            addSuccess.value = null;
            const trimmed = value.trim();
            // M17-2：扫码/图片识别到 hailuo://add-friend → 直接发好友请求
            if (/^hailuo:/i.test(trimmed)) {
              void addFriendFromUri(trimmed);
              return;
            }
            newUrl.value = value;
          }}
        />
      </section>

      {errorMsg.value && (
        <section
          class="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm leading-6 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100"
          role="alert"
          aria-live="polite"
        >
          <p class="font-semibold">{t('followsErrorTitle')}</p>
          <p class="mt-1">{errorMsg.value}</p>
          <button
            type="button"
            class="mt-3 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-800 hover:bg-rose-100 dark:border-rose-700 dark:bg-zinc-900 dark:text-rose-200 dark:hover:bg-zinc-800"
            onClick={() => void loadList()}
          >
            {t('followsRetry')}
          </button>
        </section>
      )}

      {loading.value && (
        <section class="space-y-3" aria-busy="true" aria-label={t('followsLoading')}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              class="h-20 animate-pulse rounded-lg border border-slate-200 bg-slate-100"
            />
          ))}
        </section>
      )}

      {!loading.value && follows.value.length === 0 && !errorMsg.value && (
        <section class="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <p>{t('followsEmptyTitle')}</p>
          <p class="mt-1 text-xs text-slate-500 dark:text-zinc-400">{t('followsEmptyBody')}</p>
        </section>
      )}

      {follows.value.length > 0 && (
        <section class="space-y-3" aria-label={t('followsList')}>
          {follows.value.map((follow) => {
            const registryMeta = followRegistryMetaLines(follow);
            return (
            <article
              key={follow.id}
              class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              {/* 中文注释：UX-AUDIT-6 — 列表头像与 PostCard 统一 h-10；卡片用 rounded-xl 补回缩尺寸后的视觉重量 */}
              <header class="flex items-start justify-between gap-3">
                <div class="flex min-w-0 items-start gap-3">
                  <div
                    class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold text-white"
                    style={`background-color: hsl(${avatarHue(follow)}, 62%, 45%)`}
                    aria-hidden="true"
                  >
                    {followAvatarUrl(follow) ? (
                      <img
                        src={followAvatarUrl(follow)}
                        alt=""
                        class="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      avatarLetter(follow)
                    )}
                  </div>
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-slate-950 dark:text-zinc-50">
                      {followDisplayName(follow)}
                    </p>
                    <p class="mt-0.5 truncate text-xs text-slate-500 dark:text-zinc-400">
                      {followHandleLabel(follow)}
                    </p>
                    {registryMeta.length > 0 ? (
                      <ul class="mt-1 space-y-0.5 text-xs text-slate-400 dark:text-zinc-500">
                        {registryMeta.map((line) => (
                          <li key={line} class="truncate" title={line}>
                            {line}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p class="mt-1 text-xs text-slate-400 dark:text-zinc-500">
                        {t('followsUserIdMissing')}
                      </p>
                    )}
                    {follow.fail_count > 0 && (
                      <p class="mt-1 text-xs text-rose-600 dark:text-rose-300">
                        {t('followsPullFailedHint')}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  class="shrink-0 rounded border border-rose-200 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => openUnfollowDialog(follow)}
                  disabled={deletingUrl.value === follow.node_url || unfollowPending.value}
                  aria-label={t('followsUnfollowAria', undefined, { url: follow.node_url })}
                >
                  {deletingUrl.value === follow.node_url ? t('followsDeleting') : t('followsDelete')}
                </button>
              </header>
              <dl class="mt-3 grid grid-cols-1 gap-1 text-xs text-slate-500 sm:grid-cols-3">
                <div>
                  <dt class="inline font-medium text-slate-600 dark:text-zinc-400">{t('followsFollowedAt')}</dt>
                  <dd class="inline" title={follow.followed_at}>
                    {formatRelativeTime(follow.followed_at)}
                  </dd>
                </div>
                <div>
                  <dt class="inline font-medium text-slate-600 dark:text-zinc-400">{t('followsLastActive')}</dt>
                  <dd class="inline">
                    {follow.last_active ? (
                      <span title={follow.last_active}>{formatRelativeTime(follow.last_active)}</span>
                    ) : (
                      <span class="text-slate-400">{t('followsNeverFetched')}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt class="inline font-medium text-slate-600 dark:text-zinc-400">{t('followsFailCount')}</dt>
                  <dd class="inline">
                    <span class={follow.fail_count > 0 ? 'text-rose-600' : ''}>
                      {follow.fail_count}
                    </span>
                  </dd>
                </div>
              </dl>
            </article>
            );
          })}
        </section>
      )}

      <ConfirmDialog
        open={unfollowTarget.value !== null}
        pending={unfollowPending.value}
        title={t('followsUnfollowDialogTitle')}
        body={
          unfollowTarget.value ? (
            <>
              <p>{t('followsUnfollowDialogBody')}</p>
              <p class="mt-2 break-all font-medium text-zinc-800 dark:text-zinc-100">
                {followDisplayName(unfollowTarget.value)}
              </p>
              <p class="mt-1 break-all text-xs text-zinc-500 dark:text-zinc-400">
                {unfollowTarget.value.node_url}
              </p>
            </>
          ) : null
        }
        cancelLabel={t('followsUnfollowDialogCancel')}
        confirmLabel={t('followsUnfollowDialogConfirm')}
        confirmPendingLabel={t('followsUnfollowDialogPending')}
        icon={<UserMinus size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!unfollowPending.value) unfollowTarget.value = null;
        }}
        onConfirm={() => void confirmUnfollow()}
      />
    </div>
  );
}
