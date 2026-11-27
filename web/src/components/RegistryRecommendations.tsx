/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { UserPlus, RefreshCw } from 'lucide-preact';
import { getOwnerJwt, resolveWorkerAUrl } from '../lib/auth';
import {
  createWorkerAClient,
  type FofRecommendedUser,
  type RegistryRecommendedUser,
  type RegistryRecommendedUsersResponse,
} from '../lib/workerA';
import { ApiError, getErrorMessage } from '../lib/errors';
import { resolvePublicWorkerBBaseUrlSync } from '../lib/deployEnv';
import { t } from '../lib/i18n';
import { validateNodeUrl } from './Follows';
import { FriendRequestButton, type FriendRelation } from './FriendRequestButton';

type LoadState = 'idle' | 'loading' | 'ready' | 'error' | 'unauthenticated';

/**
 * M-F4：加好友关系快照。
 * key = 归一化节点 URL（小写、去尾斜杠）；value = 关系 + 关联请求 id。
 *
 * REL-FIX-4：追加发起侧投递回执（inbox_status / inbox_error），
 * 让推荐行内联按钮也能显示「已送达 / 重试中 / 对方可能未收到」。
 */
type RelationSnapshot = Map<
  string,
  {
    relation: FriendRelation;
    requestId?: string;
    /** REL-FIX-4：后端 inbox_status 原始值 */
    deliveryStatus?: string;
    /** REL-FIX-4：后端 inbox_error 脱敏短码 */
    deliveryError?: string;
  }
>;

function normalizeNodeUrlForCompare(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * M-F4：拉取「已关注」与「待处理请求」，算出每个节点的真实关系。
 *
 * 之前这里写死 `relation="unknown"`，导致：已关注的人仍显示「加好友」，点了会被后端
 * 拒成 ALREADY_FOLLOWING；已发出的请求也不显示「已发请求 · 撤回」。
 */
async function loadRelationSnapshot(): Promise<RelationSnapshot> {
  const snapshot: RelationSnapshot = new Map();
  const baseUrl = await resolveWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) return snapshot;
  const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });

  // 1) 已关注 → following
  try {
    const follows = await client.listFollows();
    for (const item of follows.items ?? []) {
      const key = normalizeNodeUrlForCompare(item.worker_b_url || item.node_url);
      if (!key) continue;
      snapshot.set(key, { relation: 'following' });
    }
  } catch {
    // 关注列表拉取失败不阻塞推荐列表渲染
  }

  // 2) 已发出的待处理请求 → outgoing_pending
  try {
    const pending = await client.listFriendRequests({ direction: 'outgoing', status: 'pending', limit: 50 });
    for (const item of pending.items ?? []) {
      const key = normalizeNodeUrlForCompare(item.target_node_url);
      if (!key) continue;
      // REL-FIX-4：带上投递回执（对方是否真的收到了）
      snapshot.set(key, {
        relation: 'outgoing_pending',
        requestId: item.id,
        deliveryStatus: item.inbox_status,
        deliveryError: item.inbox_error,
      });
    }
  } catch {
    // 同上，失败则按 unknown 展示
  }

  // 3) 收到的待处理请求 → incoming_pending
  try {
    const pending = await client.listFriendRequests({ direction: 'incoming', status: 'pending', limit: 50 });
    for (const item of pending.items ?? []) {
      const key = normalizeNodeUrlForCompare(item.origin_node_url);
      if (!key) continue;
      // 已有 outgoing_pending 的行不被 incoming 覆盖
      if (!snapshot.has(key)) {
        snapshot.set(key, { relation: 'incoming_pending', requestId: item.id });
      }
    }
  } catch {
    // 同上
  }

  return snapshot;
}

function isOwnNodeUrl(nodeUrl: string): boolean {
  const ownUrl = resolvePublicWorkerBBaseUrlSync();
  return Boolean(ownUrl && normalizeNodeUrlForCompare(nodeUrl) === normalizeNodeUrlForCompare(ownUrl));
}

export function RegistryRecommendations() {
  const [state, setState] = useState<LoadState>('idle');
  const [data, setData] = useState<RegistryRecommendedUsersResponse | null>(null);
  const [displayItems, setDisplayItems] = useState<RegistryRecommendedUser[]>([]);
  const [fofItems, setFofItems] = useState<FofRecommendedUser[]>([]);
  const [relations, setRelations] = useState<RelationSnapshot>(new Map());
  const [error, setError] = useState('');

  async function load() {
    setState('loading');
    setError('');
    const baseUrl = await resolveWorkerAUrl();
    const jwt = getOwnerJwt();
    if (!baseUrl || !jwt) {
      setState('unauthenticated');
      return;
    }
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const result = await client.getRegistryRecommendedUsers();
      setData(result);
      setDisplayItems([...result.items]);
      setFofItems([...(result.fof_items ?? [])]);
      setState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }

    // M-F4：推荐列表渲染后再异步补关系（失败不阻塞列表）
    try {
      setRelations(await loadRelationSnapshot());
    } catch {
      setRelations(new Map());
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const footer = useMemo(() => formatFooter(data), [data]);
  const hasOfficial = displayItems.length > 0;
  const hasFof = fofItems.length > 0;

  function removeOfficial(userId: string) {
    setDisplayItems((prev) => prev.filter((item) => item.user_id !== userId));
  }

  function removeFof(nodeUrl: string) {
    const key = normalizeNodeUrlForCompare(nodeUrl);
    setFofItems((prev) =>
      prev.filter((item) => normalizeNodeUrlForCompare(item.worker_b_url || item.node_url) !== key),
    );
  }

  return (
    <section class="border-b border-[#eff3f4] bg-white p-4 transition-colors dark:border-[#2f3336] dark:bg-black">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-zinc-950 dark:text-white">{t('rightRailRegistryTitle')}</h2>
        <button
          type="button"
          onClick={() => void load()}
          class="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition hover:bg-zinc-200/70 hover:text-zinc-950 disabled:cursor-wait disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
          disabled={state === 'loading'}
          aria-label={t('rightRailRegistryRefresh')}
          title={t('rightRailRegistryRefresh')}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>

      {state === 'loading' && (
        <p class="mt-3 text-sm text-fg2">{t('rightRailRegistryLoading')}</p>
      )}

      {state === 'unauthenticated' && (
        <p class="mt-3 text-sm leading-6 text-fg2">{t('rightRailRegistryLogin')}</p>
      )}

      {state === 'error' && (
        <p class="mt-3 text-sm leading-6 text-rose-600 dark:text-rose-300">
          {error || t('rightRailRegistryError')}
        </p>
      )}

      {state === 'ready' && !hasOfficial && !hasFof && (
        <p class="mt-3 text-sm leading-6 text-fg2">{t('rightRailRegistryEmpty')}</p>
      )}

      {hasOfficial && (
        <div class="mt-3 flex flex-col gap-3">
          {displayItems.map((item) => (
            <RecommendationRow
              key={item.user_id}
              handle={item.handle}
              nodeUrl={item.worker_b_url || item.node_url}
              reasonLabel={reasonText(item.reason)}
              allowFriendRequest
              relation={relations.get(normalizeNodeUrlForCompare(item.worker_b_url || item.node_url))}
              onFollowed={() => removeOfficial(item.user_id)}
            />
          ))}
        </div>
      )}

      {/* M17-4-2c：官方推荐之后接 FoF；CTA 仅「关注」，不加好友按钮 */}
      {hasFof && (
        <div class={hasOfficial ? 'mt-5' : 'mt-3'}>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {t('rightRailFofSectionTitle')}
          </h3>
          <div class="flex flex-col gap-3">
            {fofItems.map((item) => (
              <RecommendationRow
                key={`fof:${item.node_url}`}
                handle={item.handle}
                nodeUrl={item.worker_b_url || item.node_url}
                reasonLabel={fofReasonText(item.mutual_count)}
                allowFriendRequest={false}
                onFollowed={() => removeFof(item.worker_b_url || item.node_url)}
              />
            ))}
          </div>
          <p class="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {t('rightRailFofPrivacyHint')}
          </p>
        </div>
      )}

      {footer && <p class="mt-3 text-xs text-zinc-500 dark:text-zinc-400">{footer}</p>}
    </section>
  );
}

function RecommendationRow(props: {
  handle: string;
  nodeUrl: string;
  reasonLabel: string;
  allowFriendRequest: boolean;
  /** M-F4：真实关系快照（未加载完成时按 unknown 展示） */
  relation?: {
    relation: FriendRelation;
    requestId?: string;
    /** REL-FIX-4：发起侧投递回执 */
    deliveryStatus?: string;
    deliveryError?: string;
  };
  onFollowed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const rawUrl = (props.nodeUrl || '').trim();
  let friendNodeUrl = '';
  try {
    if (props.allowFriendRequest && rawUrl && !isOwnNodeUrl(rawUrl)) {
      friendNodeUrl = validateNodeUrl(rawUrl);
    }
  } catch {
    friendNodeUrl = '';
  }

  async function follow() {
    if (busy) return;
    setBusy(true);
    setErrorMsg('');

    let nodeUrl: string;
    try {
      nodeUrl = validateNodeUrl(rawUrl);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('rightRailRegistryFollowFailed'));
      setBusy(false);
      return;
    }

    if (isOwnNodeUrl(nodeUrl)) {
      setErrorMsg(t('searchOwnNode'));
      setBusy(false);
      return;
    }

    const baseUrl = await resolveWorkerAUrl();
    const jwt = getOwnerJwt();
    if (!baseUrl || !jwt) {
      setErrorMsg(t('rightRailRegistryLogin'));
      setBusy(false);
      return;
    }

    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await client.createFollow(nodeUrl, {
        handle: props.handle,
        worker_b_url: nodeUrl,
      });
      // M32-1：关注成功后从列表移除（非仅改按钮态）
      props.onFollowed();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_FOLLOWING') {
        props.onFollowed();
        return;
      }
      setErrorMsg(err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('rightRailRegistryFollowFailed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex items-center gap-3">
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white dark:bg-zinc-100 dark:text-zinc-950">
        {avatarText(props.handle)}
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold text-zinc-950 dark:text-white">@{props.handle}</p>
        <p class="truncate text-xs text-zinc-500 dark:text-zinc-400">{props.reasonLabel}</p>
        {errorMsg && <p class="mt-1 text-xs text-rose-600 dark:text-rose-300">{errorMsg}</p>}
      </div>
      <div class="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => void follow()}
          disabled={busy}
          class="inline-flex h-8 min-w-16 items-center justify-center gap-1 rounded-full bg-zinc-950 px-3 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-700 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-300"
        >
          <UserPlus size={14} aria-hidden="true" />
          {busy ? t('rightRailRegistryFollowing') : t('rightRailRegistryFollow')}
        </button>
        {friendNodeUrl ? (
          <FriendRequestButton
            target_node_url={friendNodeUrl}
            target_handle={props.handle}
            relation={props.relation?.relation ?? 'unknown'}
            request_id={props.relation?.requestId}
            // REL-FIX-4：投递回执（对方是否真的收到了这条请求）
            delivery_status={props.relation?.deliveryStatus}
            delivery_error={props.relation?.deliveryError}
          />
        ) : null}
      </div>
    </div>
  );
}

function avatarText(handle: string): string {
  return (handle.trim().charAt(0) || 'H').toUpperCase();
}

function reasonText(reason: string): string {
  if (reason === 'active_recently') return t('rightRailRegistryReasonActive');
  if (reason === 'new_public_node') return t('rightRailRegistryReasonNew');
  return t('rightRailRegistryReasonPublic');
}

function fofReasonText(mutualCount: number): string {
  const n = Number.isFinite(mutualCount) && mutualCount > 0 ? Math.floor(mutualCount) : 1;
  return t('rightRailFofReasonMutual').replace('{count}', String(n));
}

function formatFooter(data: RegistryRecommendedUsersResponse | null): string {
  if (!data?.last_checked_at) return '';
  try {
    return t('rightRailRegistryUpdated').replace('{time}', new Date(data.last_checked_at).toLocaleString());
  } catch {
    return '';
  }
}
