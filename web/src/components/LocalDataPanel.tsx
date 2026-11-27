/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { Download, Sparkles, Trash2, Upload } from 'lucide-preact';
import {
  listBookmarks,
  listDrafts,
  getInterestWeights,
  listCachedPosts,
  clearAll,
} from '../lib/localDb';
import {
  buildSnapshot,
  serializeSnapshot,
  parseSnapshot,
  applySnapshot,
  type LocalDataSnapshot,
} from '../lib/localData';
import { listDmPlaintexts } from '../lib/dmLocalDb';
import {
  RANKING_STORAGE_KEY,
  readRankingPref,
  writeRankingPref,
  type RankingPref,
} from '../lib/forYou';
import { t } from '../lib/i18n';
import { SETTINGS_SECTION_CLASS } from '../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './settings/SettingsSectionHeader';
import { DraftsManager } from './DraftsManager';
import { DmBackupPanel } from './DmBackupPanel';

// M7-7c：Settings 本地数据区（M7-9 扩 v2 schema + 导入能力）
//
// 提供四项能力，全部基于 M7-7 lib/localDb.ts + M7-9 lib/localData.ts：
//   1. 计数：书签 / 草稿 / 兴趣权重 / 离线读缓存 四 store 当前条数
//   2. 导出 JSON：调 lib/localData.buildSnapshot + serializeSnapshot 生成 v2 快照
//      （meta：schema_version=2 + exported_at + app_version + export_origin + counts；
//       payload：四 store 数组；prefs：for_you_ranking）触发浏览器下载
//   3. 导入 JSON（M7-9）：隐藏 file input → file.text() → parseSnapshot → 二段确认后
//      applySnapshot('replace') 先 clearAll 再批量 put，原样保留时间戳；兼容 v1 旧导出文件
//   4. 清空全部本地数据：调 clearAll() 单事务 readwrite 清四 store，
//      二段确认以免误触（首次点击展开「确认清空」+「取消」）
//
// §F-02 严守：
//   - 零 import lib/api.ts 与 lib/workerA.ts 业务 client / 零 import.meta.env
//   - 零 localStorage + sessionStorage 直调（一切持久化经 lib/localDb 中转）
//   - 零 worker-a + WORKER_A_URL + hailuo:worker-a-* + localhost:8787 字面量
//
// 错误沉默：与 M7-7b 一致，IDB 不可用（SSR / 隐私模式）走 try/catch 后静默；
// 关键失败用顶部 panelStatus 卡片提示用户重试，UI 不闪红。
//
// M7-8：本面板只提供 For-You 重排的 opt-in 开关、走 lib/forYou.ts 的 read/write 偏好 中转
// （不直访 localStorage；persist 逻辑集中在 forYou 模块）。写完后手动 dispatchEvent('storage')
// 以让同页 Timeline 同步重算 posts（storage 事件仅跨标签触发，本 tab 需手动 dispatch）。

/** 四 store 计数；null 表示尚未加载（首次 mount 中或 IDB 不可用） */
interface Counts {
  readonly bookmarks: number | null;
  readonly drafts: number | null;
  readonly interest: number | null;
  readonly read_cache: number | null;
  readonly dm_chats: number | null;
}

const counts = signal<Counts>({
  bookmarks: null,
  drafts: null,
  interest: null,
  read_cache: null,
  dm_chats: null,
});

const refreshing = signal<boolean>(false);
const exporting = signal<boolean>(false);
const confirmingClear = signal<boolean>(false);
const clearing = signal<boolean>(false);
/** M7-9：导入流程三态 — importing 控按钮 loading；pendingImport 持解析后的 snapshot 等待二段确认 */
const importing = signal<boolean>(false);
const pendingImport = signal<LocalDataSnapshot | null>(null);
/** M7-8：For-You 重排偏好镜像到 Panel signal，mount 从 localStorage 读初始值 */
const rankingPref = signal<RankingPref>('off');
const panelStatus = signal<{ readonly type: 'idle' | 'success' | 'error'; readonly msg: string }>({
  type: 'idle',
  msg: '',
});

/** 首次 mount 守卫，避免 Astro 客户端 hydration 双调用 */
const mounted = signal<boolean>(false);

function setPanelStatus(type: 'idle' | 'success' | 'error', msg: string): void {
  panelStatus.value = { type, msg };
}

/** 拉四 store 当前条数，IDB 不可用静默回 0（与 lib/localDb 的 reject 语义对接） */
async function refreshCounts(): Promise<void> {
  refreshing.value = true;
  try {
    const [bookmarks, drafts, interest, cache, dmChats] = await Promise.all([
      listBookmarks().catch(() => []),
      listDrafts().catch(() => []),
      getInterestWeights().catch(() => []),
      listCachedPosts().catch(() => []),
      listDmPlaintexts().catch(() => []),
    ]);
    counts.value = {
      bookmarks: bookmarks.length,
      drafts: drafts.length,
      interest: interest.length,
      read_cache: cache.length,
      dm_chats: dmChats.length,
    };
  } finally {
    refreshing.value = false;
  }
}

/** 把 unix ms 转成本地时间字符串（YYYYMMDD-HHmm）供导出文件名使用 */
function formatTimestampForFilename(now: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes())
  );
}

/** 导出 JSON：M7-9 升级为 v2 schema，经 lib/localData.buildSnapshot+serializeSnapshot 中转 */
async function handleExport(): Promise<void> {
  if (exporting.value) return;
  setPanelStatus('idle', '');
  exporting.value = true;
  try {
    const snapshot = await buildSnapshot();
    const json = serializeSnapshot(snapshot);
    // Blob + ObjectURL + 隐式 <a download> 触发本地下载；不依赖 service worker
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hailuo-local-data-${formatTimestampForFilename(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 让浏览器有机会发起下载后再回收资源；100ms 留出足量调度窗口
    setTimeout(() => URL.revokeObjectURL(url), 100);
    const c = snapshot.meta.counts;
    const total = c.bookmarks + c.drafts + c.interest_weights + c.read_cache;
    setPanelStatus(
      'success',
      t('localDataExportSuccess', undefined, {
        total,
        version: snapshot.meta.schema_version,
      }),
    );
  } catch {
    setPanelStatus('error', t('localDataExportFailed'));
  } finally {
    exporting.value = false;
  }
}

/** M7-9 导入：file change → file.text() → parseSnapshot → 暂存到 pendingImport 等待二段确认 */
async function handleImportFile(file: File): Promise<void> {
  setPanelStatus('idle', '');
  importing.value = true;
  try {
    const json = await file.text();
    const result = parseSnapshot(json);
    if (!result.ok) {
      setPanelStatus('error', t('localDataImportFailedParse', undefined, { error: result.error }));
      pendingImport.value = null;
      return;
    }
    pendingImport.value = result.snapshot;
  } catch {
    setPanelStatus('error', t('localDataImportFailedRead'));
    pendingImport.value = null;
  } finally {
    importing.value = false;
  }
}

/** M7-9 二段确认通过后真正调 applySnapshot('replace')；先 clearAll 再批量 put 四 store */
async function handleImportConfirm(): Promise<void> {
  const snapshot = pendingImport.value;
  if (!snapshot || importing.value) return;
  importing.value = true;
  try {
    const result = await applySnapshot(snapshot, { mode: 'replace' });
    pendingImport.value = null;
    counts.value = {
      bookmarks: result.counts.bookmarks,
      drafts: result.counts.drafts,
      interest: result.counts.interest_weights,
      read_cache: result.counts.read_cache,
      dm_chats: result.counts.dm_chats,
    };
    // 同步 For-You pref 镜像（applySnapshot 已 writeRankingPref；这里同步 panel signal）
    rankingPref.value = readRankingPref();
    const total =
      result.counts.bookmarks +
      result.counts.drafts +
      result.counts.interest_weights +
      result.counts.read_cache +
      result.counts.dm_chats;
    setPanelStatus('success', t('localDataImportSuccess', undefined, { total }));
  } catch {
    setPanelStatus('error', t('localDataImportFailedTx'));
  } finally {
    importing.value = false;
  }
}

function handleImportCancel(): void {
  pendingImport.value = null;
  setPanelStatus('idle', '');
}

function handleClearRequest(): void {
  setPanelStatus('idle', '');
  confirmingClear.value = true;
}

function handleClearCancel(): void {
  confirmingClear.value = false;
}

/** M7-8：切换 For-You 重排偏好；写 lib/forYou 后手动发 storage 事件让同页 Timeline 同步 */
function handleToggleRanking(): void {
  const next: RankingPref = rankingPref.value === 'on' ? 'off' : 'on';
  rankingPref.value = next;
  writeRankingPref(next);
  // storage 事件原生仅跨标签触发；同页手动 dispatch 使 Timeline 同步重算 posts
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: RANKING_STORAGE_KEY,
          newValue: next,
        }),
      );
    } catch {
      // Safari/Firefox 某些版本 StorageEvent 构造函数限制；静默，跨标签仍会生效
    }
  }
}

/** 二段确认通过后真正调 clearAll() */
async function handleClearConfirm(): Promise<void> {
  if (clearing.value) return;
  clearing.value = true;
  try {
    await clearAll();
    counts.value = { bookmarks: 0, drafts: 0, interest: 0, read_cache: 0, dm_chats: 0 };
    confirmingClear.value = false;
    setPanelStatus('success', t('localDataClearSuccess'));
  } catch {
    setPanelStatus('error', t('localDataClearFailed'));
  } finally {
    clearing.value = false;
  }
}

/** 单行计数渲染，null 显示 — 表示尚未加载 */
function CountRow(props: { label: string; value: number | null; hint?: string }): VNode {
  return (
    <div class="flex items-baseline justify-between gap-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div class="min-w-0">
        <div class="text-sm font-medium text-slate-800 dark:text-zinc-100">{props.label}</div>
        {props.hint ? (
          <div class="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">{props.hint}</div>
        ) : null}
      </div>
      <div
        class="shrink-0 font-mono text-base font-semibold tabular-nums text-slate-900 dark:text-zinc-50"
        aria-live="polite"
      >
        {props.value === null ? '—' : props.value}
      </div>
    </div>
  );
}

export function LocalDataPanel(): VNode {
  // M7-9：隐藏 file input 的 ref，由「导入 JSON」按钮 click() 触发
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (mounted.value) return;
    mounted.value = true;
    // M7-8：mount 同步从 localStorage 读 For-You 偏好（走 lib/forYou.readRankingPref SSR/隐身守卫）
    rankingPref.value = readRankingPref();
    void refreshCounts();
  }, []);

  const status = panelStatus.value;
  const statusBox =
    status.type === 'idle' || !status.msg ? null : (
      <div
        class={
          status.type === 'success'
            ? 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100'
            : 'rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100'
        }
        role="status"
        aria-live="polite"
      >
        {status.msg}
      </div>
    );

  return (
    <section
      class={SETTINGS_SECTION_CLASS}
    >
      <SettingsSectionHeader sectionKey="localData" title={t('localDataTitle')} />
      <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
        {t('localDataDescriptionPrefix')}{' '}
        <code class="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-zinc-800 dark:text-zinc-200">
          hailuo
        </code>
        {' '}{t('localDataDescriptionSuffix')}
      </p>

      <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <CountRow label={t('localDataBookmarks')} value={counts.value.bookmarks} hint={t('localDataBookmarksHint')} />
        <CountRow label={t('localDataDrafts')} value={counts.value.drafts} hint={t('localDataDraftsHint')} />
        <CountRow label={t('localDataInterest')} value={counts.value.interest} hint={t('localDataInterestHint')} />
        <CountRow label={t('localDataReadCache')} value={counts.value.read_cache} hint={t('localDataReadCacheHint')} />
        <CountRow label={t('localDataDmChats')} value={counts.value.dm_chats} hint={t('localDataDmChatsHint')} />
      </div>

      {/* M7-13（F-02 修复）：草稿列表子模块，折叠 details 默认收起；展开可编辑/删除全部草稿 */}
      <DraftsManager />

      {/* M7-9：隐藏 file input，由「导入 JSON」按钮 click() 触发；选中后 onChange 走 handleImportFile */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        class="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const target = e.currentTarget;
          const file = target.files?.[0];
          if (file) void handleImportFile(file);
          // 重置 value 以便同一文件重选仍能触发 change 事件
          target.value = '';
        }}
      />

      {/* M7-7d：书签详情入口（脱网渲染，独立路由 /bookmarks） */}
      <div class="mt-3">
        <a
          href="/bookmarks"
          class="inline-flex items-center gap-1 text-sm font-medium text-sky-700 hover:underline dark:text-sky-400"
        >
          {t('localDataViewBookmarks')}
        </a>
      </div>

      {/* M7-8：For-You 重排 opt-in 开关。默认关（与原 Timeline 行为一致）；
          开启后 Timeline 推荐 tab 根据本地 interest_weights 稳定 partition 重排。 */}
      <div
        class="mt-4 flex items-start justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 text-sm font-medium text-slate-800 dark:text-zinc-100">
            <Sparkles
              size={14}
              strokeWidth={1.75}
              class="text-sky-600 dark:text-sky-400"
              aria-hidden="true"
            />
            <span id="for-you-ranking-label">{t('localDataRankingTitle')}</span>
          </div>
          <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
            {t('localDataRankingDescription')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={rankingPref.value === 'on'}
          aria-labelledby="for-you-ranking-label"
          data-for-you-ranking-toggle={rankingPref.value}
          onClick={handleToggleRanking}
          class={
            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ' +
            (rankingPref.value === 'on'
              ? 'bg-sky-600 dark:bg-sky-500'
              : 'bg-slate-300 dark:bg-zinc-700')
          }
        >
          <span
            class={
              'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ' +
              (rankingPref.value === 'on' ? 'translate-x-5' : 'translate-x-0.5')
            }
            aria-hidden="true"
          />
          <span class="sr-only">{rankingPref.value === 'on' ? t('localDataRankingOn') : t('localDataRankingOff')}</span>
        </button>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exporting.value || importing.value}
          class="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          <Download size={14} strokeWidth={1.75} aria-hidden="true" />
          {exporting.value ? t('localDataExporting') : t('localDataExportJson')}
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing.value || exporting.value || pendingImport.value !== null}
          aria-label={t('localDataImportAria')}
          class="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
          {importing.value ? t('localDataImporting') : t('localDataImportJson')}
        </button>

        {confirmingClear.value ? (
          <div
            class="flex flex-wrap items-center gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 dark:border-rose-700 dark:bg-rose-950"
            role="group"
            aria-label={t('localDataClearConfirmAria')}
          >
            <span class="text-xs text-rose-900 dark:text-rose-100">
              {t('localDataClearConfirmPrompt')}
            </span>
            <button
              type="button"
              onClick={() => void handleClearConfirm()}
              disabled={clearing.value}
              class="rounded-md bg-rose-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-400"
            >
              {clearing.value ? t('localDataClearing') : t('localDataClearConfirm')}
            </button>
            <button
              type="button"
              onClick={handleClearCancel}
              disabled={clearing.value}
              class="rounded-md border border-rose-300 bg-white px-2 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:bg-zinc-900 dark:text-rose-200 dark:hover:bg-zinc-800"
            >
              {t('localDataCancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleClearRequest}
            disabled={refreshing.value}
            class="inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:bg-zinc-900 dark:text-rose-300 dark:hover:bg-zinc-800"
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('localDataClearAll')}
          </button>
        )}
      </div>

      <DmBackupPanel />

      {/* M7-9：导入二段确认卡；解析成功后 pendingImport 非 null 时展开 */}
      {pendingImport.value ? (
        <div
          class="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 dark:border-amber-700 dark:bg-amber-950"
          role="group"
          aria-labelledby="import-confirm-title"
        >
          <div id="import-confirm-title" class="text-sm font-medium text-amber-900 dark:text-amber-100">
            {t('localDataImportConfirmTitle', undefined, { version: pendingImport.value.meta.schema_version })}
          </div>
          <ul class="mt-2 list-disc pl-5 text-xs leading-5 text-amber-900 dark:text-amber-100">
            <li>{t('localDataCountLine', undefined, { label: t('localDataBookmarks'), count: pendingImport.value.meta.counts.bookmarks })}</li>
            <li>{t('localDataCountLine', undefined, { label: t('localDataDrafts'), count: pendingImport.value.meta.counts.drafts })}</li>
            <li>{t('localDataCountLine', undefined, { label: t('localDataInterest'), count: pendingImport.value.meta.counts.interest_weights })}</li>
            <li>{t('localDataCountLine', undefined, { label: t('localDataReadCache'), count: pendingImport.value.meta.counts.read_cache })}</li>
            <li>{t('localDataCountLine', undefined, { label: t('localDataDmChats'), count: pendingImport.value.meta.counts.dm_chats ?? 0 })}</li>
            {pendingImport.value.prefs.for_you_ranking ? (
              <li>{t('localDataRankingPrefLine', undefined, {
                state: pendingImport.value.prefs.for_you_ranking === 'on'
                  ? t('localDataRankingPrefOn')
                  : t('localDataRankingPrefOff'),
              })}</li>
            ) : null}
          </ul>
          <div class="mt-2 text-xs text-amber-900 dark:text-amber-100">
            <strong>{t('localDataImportWarningLabel')}</strong>{t('localDataImportWarningBody')}
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleImportConfirm()}
              disabled={importing.value}
              class="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-400"
            >
              {importing.value ? t('localDataImporting') : t('localDataImportConfirmButton')}
            </button>
            <button
              type="button"
              onClick={handleImportCancel}
              disabled={importing.value}
              class="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-700 dark:bg-zinc-900 dark:text-amber-200 dark:hover:bg-zinc-800"
            >
              {t('localDataCancel')}
            </button>
          </div>
        </div>
      ) : null}

      {statusBox ? <div class="mt-3">{statusBox}</div> : null}
    </section>
  );
}
