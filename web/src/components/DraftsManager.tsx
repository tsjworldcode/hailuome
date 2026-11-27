/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { FileText, Pencil, Trash2 } from 'lucide-preact';
import { listDrafts, deleteDraft, type Draft } from '../lib/localDb';
import { isQuotaExceeded } from '../lib/idbErrors';
import { showToast } from '../lib/toast';
import { initLanguage, t } from '../lib/i18n';

// listDrafts 返回的 Draft 一定带 autoIncrement 分配的 draft_id（未落库的草稿不可能出现在 listDrafts 结果中），
// 仅 Draft.draft_id 类型在写入接口上被设为 optional。在本组件内部收敛为明确的 number。
type PersistedDraft = Draft & { readonly draft_id: number };

// M7-13（F-02 修复）：草稿列表子模块（在 LocalDataPanel 内折叠展开）
//
// 设计要点：
// - 响应审计报告 §2.2 F-02：Composer/InlineComposer 仅恢复 drafts[0]，
//   IDB 中其它草稿（导入 / 异常残留）用户永远看不到
// - 折叠 <details> 默认收起，避免抢占面板视觉
// - 展开后渲染 <ul role=list> 草稿列表，按 lib/localDb.listDrafts 已排序的 updated_at DESC 输出
// - 每条草稿：
//   * content 截断到 DRAFT_PREVIEW_LENGTH=60 个 Unicode 码点 + 「…」省略号
//   * updated_at 格式化为本地相对时间（与 PostCard 同源 formatRelative 风格简化版）
//   * 「编辑」<a href="/composer?draft={id}">：跳 Composer 页加载该 draft（Composer.tsx 接 URL query 处理）
//   * 「删除」按钮：直接调 deleteDraft + refreshDrafts；QuotaExceeded 走 toast，其它错误静默
// - 顶部「全部删除」按钮 + 二段确认（与 LocalDataPanel.handleClearConfirm 同源 UX）
// - listDrafts / deleteDraft 失败时静默 + 顶部状态条提示
// - dark 变体完整
//
// §F-02 红线：零 import lib/api 与 lib/workerA / 零 import.meta.env / 零 fetch / 零 storage 直调
//   仅经 lib/localDb（listDrafts/deleteDraft）+ lib/idbErrors + lib/toast 中转

/** 草稿预览截断长度（按 Unicode 码点） */
export const DRAFT_PREVIEW_LENGTH = 60;

/** 顶层草稿队列（preact-signals 自动订阅）；draft_id 在 listDrafts 返回后保证为 number */
const drafts = signal<readonly PersistedDraft[]>([]);
const loadingDrafts = signal<boolean>(false);
const confirmingDeleteAll = signal<boolean>(false);
const deletingDraftId = signal<number | null>(null);
const deletingAll = signal<boolean>(false);
const mounted = signal<boolean>(false);
const errorMsg = signal<string | null>(null);

/** 拉所有草稿到本地 signal；IDB 不可用静默回空数组 */
export async function refreshDrafts(): Promise<void> {
  if (loadingDrafts.value) return;
  loadingDrafts.value = true;
  errorMsg.value = null;
  try {
    const list = await listDrafts();
    // listDrafts 后所有 draft 都有 draft_id；外部 type定义仅为了写入接口需要 optional。
    drafts.value = list.filter((d): d is PersistedDraft => typeof d.draft_id === 'number');
  } catch {
    // 静默：IDB 不可用（SSR / 隐私模式）直接保持当前值
    errorMsg.value = t('draftsManagerReadFailed');
  } finally {
    loadingDrafts.value = false;
  }
}

/** 单条删除；QuotaExceeded 走 toast，其它错误顶部状态条提示 */
async function handleDelete(draftId: number): Promise<void> {
  if (deletingDraftId.value !== null) return;
  deletingDraftId.value = draftId;
  errorMsg.value = null;
  try {
    await deleteDraft(draftId);
    drafts.value = drafts.value.filter((d) => d.draft_id !== draftId);
  } catch (err) {
    if (isQuotaExceeded(err)) {
      showToast(t('localStorageQuotaExceeded'), 'error');
    } else {
      errorMsg.value = t('draftsManagerDeleteFailed');
    }
  } finally {
    deletingDraftId.value = null;
  }
}

function handleDeleteAllRequest(): void {
  errorMsg.value = null;
  confirmingDeleteAll.value = true;
}

function handleDeleteAllCancel(): void {
  confirmingDeleteAll.value = false;
}

/** 二段确认通过后遍历 deleteDraft；任一条失败仍继续，最后统一统计 */
async function handleDeleteAllConfirm(): Promise<void> {
  if (deletingAll.value) return;
  deletingAll.value = true;
  errorMsg.value = null;
  const targets = drafts.value;
  let quotaHit = false;
  let otherFail = 0;
  for (const d of targets) {
    try {
      await deleteDraft(d.draft_id);
    } catch (err) {
      if (isQuotaExceeded(err)) {
        quotaHit = true;
      } else {
        otherFail++;
      }
    }
  }
  await refreshDrafts();
  confirmingDeleteAll.value = false;
  deletingAll.value = false;
  if (quotaHit) {
    showToast(t('localStorageQuotaExceeded'), 'error');
  } else if (otherFail > 0) {
    errorMsg.value = t('draftsManagerPartialDeleteFailed', undefined, { count: otherFail });
  }
}

/** 内容截断到 DRAFT_PREVIEW_LENGTH 个 Unicode 码点 + 「…」省略号 */
function previewContent(content: string): string {
  const cp = [...content];
  if (cp.length <= DRAFT_PREVIEW_LENGTH) return content;
  return cp.slice(0, DRAFT_PREVIEW_LENGTH).join('') + '…';
}

/** Unix ms 转本地相对时间（精简版；秒/分/时/天/月四档） */
function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return t('timeNow');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('timeMinutesAgo', undefined, { count: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t('timeHoursAgo', undefined, { count: diffHour });
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return t('timeDaysAgo', undefined, { count: diffDay });
  const diffMonth = Math.floor(diffDay / 30);
  return t('timeMonthsAgo', undefined, { count: diffMonth });
}

function DraftRow({ draft }: { draft: PersistedDraft }): VNode {
  const preview = previewContent(draft.content);
  const time = formatRelativeTime(draft.updated_at);
  const isDeleting = deletingDraftId.value === draft.draft_id;
  return (
    <li
      class="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
      data-draft-id={draft.draft_id}
    >
      <FileText
        size={14}
        strokeWidth={1.75}
        class="mt-0.5 shrink-0 text-slate-500 dark:text-zinc-400"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <p class="break-words text-sm leading-5 text-slate-800 dark:text-zinc-100">
          {preview || <span class="italic text-slate-400 dark:text-zinc-500">{t('draftsManagerEmptyDraft')}</span>}
        </p>
        <p class="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
          {t('draftsManagerUpdatedAt', undefined, { time })}
          {draft.image_keys.length > 0 ? ` · ${t('draftsManagerImages', undefined, { count: draft.image_keys.length })}` : ''}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <a
          href={`/composer?draft=${draft.draft_id}`}
          class="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-white px-2 py-1 text-xs font-medium text-sky-700 transition hover:bg-sky-50 dark:border-sky-700 dark:bg-zinc-900 dark:text-sky-300 dark:hover:bg-zinc-800"
          aria-label={t('draftsManagerEditAria', undefined, { id: draft.draft_id })}
        >
          <Pencil size={12} strokeWidth={1.75} aria-hidden="true" />
          {t('draftsManagerEdit')}
        </a>
        <button
          type="button"
          onClick={() => void handleDelete(draft.draft_id)}
          disabled={isDeleting}
          aria-label={t('draftsManagerDeleteAria', undefined, { id: draft.draft_id })}
          class="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-2 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:bg-zinc-900 dark:text-rose-300 dark:hover:bg-zinc-800"
        >
          <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
          {isDeleting ? t('draftsManagerDeleting') : t('draftsManagerDelete')}
        </button>
      </div>
    </li>
  );
}

export function DraftsManager(): VNode {
  useEffect(() => {
    initLanguage();
    if (mounted.value) return;
    mounted.value = true;
    void refreshDrafts();
  }, []);

  const list = drafts.value;
  const errBox = errorMsg.value ? (
    <div
      class="mt-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100"
      role="status"
      aria-live="polite"
    >
      {errorMsg.value}
    </div>
  ) : null;

  return (
    <details class="mt-3 rounded-md border border-slate-200 bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900">
      <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium text-slate-800 dark:text-zinc-100">
        {t('draftsManagerTitle', undefined, { count: list.length })}
      </summary>
      <div class="px-3 pb-3">
        <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
          {t('draftsManagerDescription')}
        </p>
        {list.length === 0 ? (
          <p class="mt-2 text-xs italic text-slate-500 dark:text-zinc-500">
            {t('draftsManagerEmpty')}
          </p>
        ) : (
          <>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              {confirmingDeleteAll.value ? (
                <div
                  class="flex flex-wrap items-center gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 dark:border-rose-700 dark:bg-rose-950"
                  role="group"
                  aria-label={t('draftsManagerDeleteAllAria')}
                >
                  <span class="text-xs text-rose-900 dark:text-rose-100">
                    {t('draftsManagerDeleteAllPrompt', undefined, { count: list.length })}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleDeleteAllConfirm()}
                    disabled={deletingAll.value}
                    class="rounded-md bg-rose-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-400"
                  >
                    {deletingAll.value ? t('draftsManagerDeleting') : t('draftsManagerConfirmDelete')}
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteAllCancel}
                    disabled={deletingAll.value}
                    class="rounded-md border border-rose-300 bg-white px-2 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:bg-zinc-900 dark:text-rose-200 dark:hover:bg-zinc-800"
                  >
                    {t('localDataCancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleDeleteAllRequest}
                  class="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-2 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-50 dark:border-rose-700 dark:bg-zinc-900 dark:text-rose-300 dark:hover:bg-zinc-800"
                >
                  <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
                  {t('draftsManagerDeleteAll')}
                </button>
              )}
            </div>
            <ul class="mt-2 flex flex-col gap-2" role="list">
              {list.map((d) => (
                <DraftRow key={d.draft_id} draft={d} />
              ))}
            </ul>
          </>
        )}
        {errBox}
      </div>
    </details>
  );
}
