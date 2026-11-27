/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Search, UserPlus } from 'lucide-preact';
import { getOwnerJwt, resolveWorkerAUrl } from '../lib/auth';
import { ApiError, getErrorMessage } from '../lib/errors';
import { formatPublicHandleDisplay } from '../lib/handleDisplay';
import {
  isOfficialRegistrySearchHandle,
  normalizeSearchHandleInput,
  parseSearchHandle,
} from '../lib/handleSearch';
import { initLanguage, t } from '../lib/i18n';
import { resolveRegistryUrl } from '../lib/registryEndpoints';
import { resolvePublicWorkerBBaseUrlSync } from '../lib/deployEnv';
import { createWorkerAClient, type LookupResponse } from '../lib/workerA';

type SearchState = 'idle' | 'loading' | 'ready' | 'error';

export const OFFICIAL_REGISTRY_HANDLE = 'hailuo-registry';

function validateHandle(handle: string): string | null {
  const parsed = parseSearchHandle(handle);
  if (!parsed.ok) {
    if (parsed.reason === 'empty') return t('searchHandleRequired');
    if (parsed.reason === 'did') return t('searchDidDisabled');
    return t('searchHandleInvalid');
  }
  return null;
}

function officialRegistryLookup(registryUrl: string, qualifiedHandle: string): LookupResponse {
  return {
    handle: qualifiedHandle,
    pubkey: '',
    node_url: registryUrl,
    worker_b_url: registryUrl,
  };
}

function lookupPublicNodeUrl(result: LookupResponse): string {
  return (result.worker_b_url || result.node_url || '').trim();
}

function isOfficialRegistryResult(result: LookupResponse): boolean {
  return isOfficialRegistrySearchHandle(result.handle || '', OFFICIAL_REGISTRY_HANDLE);
}

function normalizeNodeUrlForCompare(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

function isOwnNodeUrl(nodeUrl: string): boolean {
  const ownUrl = resolvePublicWorkerBBaseUrlSync();
  return Boolean(ownUrl && normalizeNodeUrlForCompare(nodeUrl) === normalizeNodeUrlForCompare(ownUrl));
}

export function RightRailSearch(): VNode {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [result, setResult] = useState<LookupResponse | null>(null);
  const [message, setMessage] = useState('');
  const [followed, setFollowed] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  // M-UI-1：15s 超时
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SEARCH_TIMEOUT_MS = 15_000;

  useEffect(() => {
    initLanguage();
  }, []);

  async function lookup(e: Event): Promise<void> {
    e.preventDefault();
    const normalized = normalizeSearchHandleInput(query);
    const parsed = parseSearchHandle(normalized);
    const handle = parsed.ok ? parsed.handle : normalized;
    setQuery(handle);
    setResult(null);
    setFollowed(false);

    const invalid = validateHandle(normalized);
    if (invalid) {
      setState('error');
      setMessage(invalid);
      return;
    }

    if (isOfficialRegistrySearchHandle(handle, OFFICIAL_REGISTRY_HANDLE)) {
      // 官方注册中心账号不是普通用户节点，前端直接映射到当前部署配置的注册中心入口。
      const registryUrl = await resolveRegistryUrl();
      setResult(officialRegistryLookup(registryUrl, handle));
      setState('ready');
      setMessage('');
      return;
    }

    const baseUrl = await resolveWorkerAUrl();
    const jwt = getOwnerJwt();
    if (!baseUrl || !jwt) {
      setState('error');
      setMessage(t('searchLoginRequired'));
      return;
    }

    setState('loading');
    setMessage('');
    // M-UI-1：清除旧超时，设新超时
    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = setTimeout(() => {
      if (state === 'loading') {
        setState('error');
        setMessage(t('searchTimeout'));
      }
    }, SEARCH_TIMEOUT_MS);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const data = await client.lookup(handle);
      if (searchTimerRef.current !== null) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
      setResult(data);
      setState('ready');
    } catch (err) {
      if (searchTimerRef.current !== null) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
      setState('error');
      if (err instanceof ApiError) setMessage(err.displayMessage);
      else setMessage(getErrorMessage({}, t('searchFailed')));
    }
  }

  async function followResult(): Promise<void> {
    if (!result || followBusy || followed) return;
    const nodeUrl = lookupPublicNodeUrl(result);
    if (isOfficialRegistryResult(result) || isOwnNodeUrl(nodeUrl)) {
      setMessage('');
      return;
    }

    if (!nodeUrl) {
      setMessage(t('searchNodeUrlMissing'));
      return;
    }

    const baseUrl = await resolveWorkerAUrl();
    const jwt = getOwnerJwt();
    if (!baseUrl || !jwt) {
      setState('error');
      setMessage(t('searchLoginRequired'));
      return;
    }

    setFollowBusy(true);
    setMessage('');
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      // 注册中心可能只返回 node_url；关注保存粉丝可访问的公开入口。
      // SEC-AUDIT-2026-10-13：lookup 已带 pubkey 时一并写入存储级 pin（防换钥顶替）
      const pubkey =
        typeof result.pubkey === 'string' && /^[0-9a-fA-F]{64}$/.test(result.pubkey.trim())
          ? result.pubkey.trim().toLowerCase()
          : undefined;
      await client.createFollow(nodeUrl, {
        handle: result.handle,
        worker_b_url: nodeUrl,
        ...(pubkey ? { pubkey } : {}),
      });
      setFollowed(true);
    } catch (err) {
      if (err instanceof ApiError) setMessage(err.displayMessage);
      else setMessage(getErrorMessage({}, t('searchFollowFailed')));
    } finally {
      setFollowBusy(false);
    }
  }

  const normalized = normalizeSearchHandleInput(query);
  const canSubmit = normalized.length > 0 && state !== 'loading';
  const resultNodeUrl = result ? lookupPublicNodeUrl(result) : '';
  const isOwnSearchResult = Boolean(resultNodeUrl && isOwnNodeUrl(resultNodeUrl));
  const canFollowResult = Boolean(result && resultNodeUrl && !isOfficialRegistryResult(result) && !isOwnSearchResult);
  const resultHandleLabel = result ? formatPublicHandleDisplay(result.handle) : '';

  // 中文注释：UX-AUDIT-10 — 栏内滚动时搜索条钉顶；毛玻璃对齐 Timeline sticky header；top-0（非 top-16）
  return (
    <section class="sticky top-0 z-10 -mx-6 bg-white/95 px-6 py-1 backdrop-blur-md dark:bg-black/95">
      <form role="search" onSubmit={(e) => void lookup(e)}>
        <label class="relative flex items-center">
          <span class="pointer-events-none absolute left-4 flex items-center text-zinc-500 dark:text-zinc-400">
            <Search size={20} aria-hidden="true" />
          </span>
          <input
            type="search"
            name="q"
            value={query}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchAria')}
            title={t('searchTitle')}
            autoComplete="off"
            spellcheck={false}
            class="hailuo-focus w-full rounded-full border-0 bg-zinc-100 py-3 pl-12 pr-12 text-sm text-zinc-900 placeholder:text-zinc-500 focus:bg-white focus:outline-none dark:bg-zinc-900 dark:text-zinc-50 dark:placeholder:text-zinc-500 dark:focus:bg-zinc-950"
            onInput={(ev) => {
              setQuery((ev.currentTarget as HTMLInputElement).value);
              if (state !== 'idle') {
                setState('idle');
                setResult(null);
                setMessage('');
                setFollowed(false);
              }
              // M-UI-1：清超时
              if (searchTimerRef.current !== null) {
                clearTimeout(searchTimerRef.current);
                searchTimerRef.current = null;
              }
            }}
          />
          {/* 右侧提交钮；pr-12 给文字留空，避免遮挡正式名尾部 */}
          <button
            type="submit"
            class="absolute right-1.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-300"
            disabled={!canSubmit}
            aria-label={state === 'loading' ? t('searchSearching') : t('searchSubmit')}
            title={state === 'loading' ? t('searchSearching') : t('searchSubmit')}
          >
            <Search size={16} aria-hidden="true" />
          </button>
        </label>
      </form>

      {state === 'loading' && (
        <p class="px-2 py-2 text-xs text-zinc-500 dark:text-zinc-400" role="status">
          {t('searchSearching')}
        </p>
      )}

      {message && (
        <p
          class="mx-1 mt-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-800 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-100"
          role="alert"
          aria-live="polite"
        >
          {message}
        </p>
      )}

      {state === 'ready' && result && (
        <article class="mx-1 mt-2 rounded-2xl bg-zinc-50 p-3 dark:bg-zinc-900/80">
          <div class="flex items-start gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-600 text-sm font-bold text-white">
              {(resultHandleLabel.charAt(0) || result.handle.charAt(0) || 'H').toUpperCase()}
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-zinc-950 dark:text-white">{resultHandleLabel}</p>
              {result.user_id ? (
                <p class="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400" title={result.user_id}>
                  {t('followsUserId')}{result.user_id}
                </p>
              ) : null}
              {result.registry_status ? (
                <p class="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {t('followsRegistryStatus')}{result.registry_status}
                </p>
              ) : null}
              {!result.user_id && !resultNodeUrl ? (
                <p class="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {t('searchNodeUrlMissing')}
                </p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void followResult()}
            disabled={followBusy || followed || !canFollowResult}
            class="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-zinc-950 px-3 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-700 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-300"
          >
            {!followed && <UserPlus size={15} aria-hidden="true" />}
            {result && isOfficialRegistryResult(result)
              ? t('searchOfficialShown')
              : isOwnSearchResult
                ? t('searchOwnNode')
              : followed
                ? t('searchFollowed')
                : followBusy
                  ? t('searchFollowing')
                  : t('searchFollow')}
          </button>
        </article>
      )}
    </section>
  );
}
