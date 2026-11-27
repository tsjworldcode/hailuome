/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal, computed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { clearOwnerSessionForLogin } from '../lib/ownerSession';
import { createWorkerAClient } from '../lib/workerA';
import { ApiError, getErrorMessage } from '../lib/errors';
import { deleteDraft, saveDraft } from '../lib/localDb';
import { restoreDraftToForm } from '../lib/draftRestore';
import { isQuotaExceeded } from '../lib/idbErrors';
import { showToast } from '../lib/toast';
import {
  ownerBaseUrl,
  ownerCredentialsReady,
  ownerJwt,
  useOwnerCredentials,
} from '../lib/useOwnerCredentials';
import { initLanguage, t } from '../lib/i18n';

// M7-3：发帖器（文字 + 图片）
//
// 设计要点：
// - 双 gate：未配 Worker A 地址 → 引导卡跳设置 / 未登录 → 引导卡跳设置
// - 字符计数按 Unicode 码点数（[...str].length），与 Worker A `MAX_CONTENT_LENGTH=500` 对齐
// - 图片：本地 File 列表 + URL.createObjectURL 预览 + 删除；提交时按顺序 uploadImage 拿 keys 再 createPost
//   * 注意：必须串行（图片可能很大，B2 后端 500 MB 上限；并发会撑爆 CF Workers 子请求或浏览器内存）
//   * Worker A `POST /api/images` 接受 raw body（非 multipart），Content-Type 直传 file.type
//   * 返回 key 形如 `kv:img_xxx` / `r2:img_xxx` / `b2:img_xxx`，直接放进 createPost.images
// - 提交成功后清空表单 + 倒计时 5 秒跳回首页
// - **M7-7b 起，草稿自动保存 + 刷新可恢复**：
//   * 输入 textarea 走 debounce 1s 后派发 saveDraft 入 IDB drafts store；首次保存拿回 autoIncrement draft_id 记住
//   * useEffect mount 时带 listDrafts() 拿最近一条（按 updated_at DESC 排序）以预填 textarea + currentDraftId
//   * 草稿内容 trim 为空时 deleteDraft 清除指针，避免“空草稿”驻留
//   * 发帖提交成功进入倌计时后 deleteDraft 上下文草稿（避免下次进入又被恢复）
//   * 仅持文字部分；image_keys=[] 预留（File 未上传前不可靠序列化，且 URL.createObjectURL 刷新后失效）
//   * 错误沉默（SSR / IDB 禁用 / 隐身模式），不阻塞主发帖流程
// - **M7-13（F-02 修复）：URL query ?draft={id} 入口**：
//   * 当 URL 带 ?draft=<id> 时，restoreDraftOnce 调 getDraft(id) 取指定草稿预填
//   * 没有 query 时维持原逻辑：listDrafts() → drafts[0] 最新一条（与 M7-7b 同源）
//   * 给 LocalDataPanel.DraftsManager「编辑」链接使用，让用户能编辑非最新草稿
// - **M7-13（F-13 修复）：QuotaExceeded → toast**：
//   * persistDraftNow saveDraft / deleteDraft 失败时区分 QuotaExceeded：命中走 showToast 提示用户清理本地数据
//   * 其它错误仍静默吞不打断主发帖流程（与原 M7-7b 行为同源）
// - §F-02：本组件用 auth.ts.getWorkerAUrl 运行时读取，绝不读 import.meta.env.WORKER_A_URL

const MAX_CONTENT_LENGTH = 500;
const MAX_IMAGE_COUNT = 9;
/** 单张图片大小上限（与 Worker A KV 后端的 25 MB 上限对齐；B2/R2 可更大但本前端先按保守值） */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** 草稿自动保存 debounce（1s） */
const DRAFT_DEBOUNCE_MS = 1000;

interface PreviewImage {
  readonly id: string;
  readonly file: File;
  readonly url: string;
}

const content = signal<string>('');
const previews = signal<readonly PreviewImage[]>([]);
const submitting = signal<boolean>(false);
const uploadProgress = signal<{ current: number; total: number } | null>(null);
const errorMsg = signal<string | null>(null);
const successMsg = signal<string | null>(null);
const countdown = signal<number>(0);
/** 当前草稿主键（autoIncrement draft_id）；undefined 表示未落库 / 已删 */
const currentDraftId = signal<number | undefined>(undefined);
/** 草稿状态提示（仅调试可见）：idle / saving / saved 三态，免渲染在 UI 上 */
const draftStatus = signal<'idle' | 'saving' | 'saved'>('idle');
/** 草稿顶部「已恢复」提示可见性（1 次页面生命周期内可以被手动关闭） */
const draftRestoredHint = signal<boolean>(false);

const contentLength = computed(() => [...content.value].length);
const canSubmit = computed(() => {
  const len = contentLength.value;
  return (
    !submitting.value &&
    len > 0 &&
    len <= MAX_CONTENT_LENGTH &&
    previews.value.length <= MAX_IMAGE_COUNT
  );
});

// M7-7b：草稿保存 debounce。模块级变量存放定时器句柄，与 signals 同周期。
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

async function persistDraftNow(): Promise<void> {
  if (typeof indexedDB === 'undefined') return; // SSR / 不支持的环境静默跳过
  const text = content.value;
  // 空内容：如已有草稿 则删除。避免「已清空但未发帖」仍被下次进入复原
  if (!text.trim()) {
    const id = currentDraftId.value;
    if (id !== undefined) {
      try {
        await deleteDraft(id);
      } catch (err) {
        // M7-13 F-13：QuotaExceeded 给 toast，其它错误静默不阻塞主流程
        if (isQuotaExceeded(err)) showToast(t('localStorageQuotaExceeded'), 'error');
      }
      currentDraftId.value = undefined;
    }
    draftStatus.value = 'idle';
    return;
  }
  draftStatus.value = 'saving';
  try {
    const id = await saveDraft({
      draft_id: currentDraftId.value,
      content: text,
      image_keys: [],
      updated_at: Date.now(),
    });
    currentDraftId.value = id;
    draftStatus.value = 'saved';
  } catch (err) {
    // M7-13 F-13：QuotaExceeded 给 toast，其它错误静默不阻塞主流程，下次输入会重调
    if (isQuotaExceeded(err)) showToast(t('localStorageQuotaExceeded'), 'error');
    draftStatus.value = 'idle';
  }
}

function scheduleDraftSave(): void {
  if (typeof window === 'undefined') return;
  if (draftSaveTimer !== null) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    void persistDraftNow();
  }, DRAFT_DEBOUNCE_MS);
}

/** M7-13 F-02 + M7-19：共享 lib/draftRestore（?draft= 优先 + drafts[0] 回落） */
async function restoreDraftOnce(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  if (content.value !== '') return;
  await restoreDraftToForm({
    getContent: () => content.value,
    setContent: (v) => {
      content.value = v;
    },
    setDraftId: (id) => {
      currentDraftId.value = id;
    },
    onRestored: () => {
      draftStatus.value = 'saved';
      draftRestoredHint.value = true;
    },
  });
}

function genPreviewId(): string {
  // 仅用于 key prop，不进任何持久化
  return `pv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function addFiles(files: FileList | null): void {
  if (!files || files.length === 0) return;
  const next: PreviewImage[] = [...previews.value];
  for (const file of Array.from(files)) {
    if (next.length >= MAX_IMAGE_COUNT) break;
    if (!file.type.startsWith('image/')) {
      errorMsg.value = t('composerUnsupportedFileType', undefined, { type: file.type || t('composerUnknownFileType') });
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      errorMsg.value = t('composerFileTooLarge', undefined, { name: file.name });
      continue;
    }
    next.push({
      id: genPreviewId(),
      file,
      url: URL.createObjectURL(file),
    });
  }
  previews.value = next;
}

function removePreview(id: string): void {
  const removed = previews.value.find((p) => p.id === id);
  if (removed) URL.revokeObjectURL(removed.url);
  previews.value = previews.value.filter((p) => p.id !== id);
}

function resetForm(): void {
  for (const p of previews.value) URL.revokeObjectURL(p.url);
  previews.value = [];
  content.value = '';
  errorMsg.value = null;
  draftRestoredHint.value = false;
  draftStatus.value = 'idle';
  // 已提交发帖后同步清除 IDB 上下文草稿，避免下次进入又被预填
  if (draftSaveTimer !== null) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  const idToDelete = currentDraftId.value;
  currentDraftId.value = undefined;
  if (idToDelete !== undefined && typeof indexedDB !== 'undefined') {
    void deleteDraft(idToDelete).catch(() => {
      // 静默：删除失败不影响发帖成功后续跳转
    });
  }
}

function startCountdownRedirect(): void {
  countdown.value = 5;
  const tick = () => {
    if (typeof window === 'undefined') return;
    if (countdown.value <= 1) {
      window.location.href = '/';
      return;
    }
    countdown.value = countdown.value - 1;
    window.setTimeout(tick, 1000);
  };
  if (typeof window !== 'undefined') window.setTimeout(tick, 1000);
}

async function handleSubmit(e: Event): Promise<void> {
  e.preventDefault();
  errorMsg.value = null;
  successMsg.value = null;

  const trimmed = content.value.trim();
  if (!trimmed) {
    errorMsg.value = t('composerEmpty');
    return;
  }
  if ([...trimmed].length > MAX_CONTENT_LENGTH) {
    errorMsg.value = t('composerTooLong', undefined, { max: MAX_CONTENT_LENGTH });
    return;
  }

  const currentBaseUrl = ownerBaseUrl.value;
  const currentJwt = ownerJwt.value;
  if (!currentBaseUrl) {
    errorMsg.value = t('composerMissingEndpoint');
    return;
  }
  if (!currentJwt) {
    errorMsg.value = t('composerMissingSession');
    return;
  }

  submitting.value = true;
  const client = createWorkerAClient({
    baseUrl: currentBaseUrl,
    getJwt: () => currentJwt,
  });

  try {
    const imageKeys: string[] = [];
    const total = previews.value.length;
    for (let i = 0; i < total; i++) {
      const pv = previews.value[i];
      if (!pv) continue;
      uploadProgress.value = { current: i + 1, total };
      const result = await client.uploadImage({
        body: pv.file,
        contentType: pv.file.type,
        contentLength: pv.file.size,
      });
      imageKeys.push(result.key);
    }
    uploadProgress.value = null;

    await client.createPost({ content: trimmed, images: imageKeys });
    successMsg.value = t('composerSuccess');
    resetForm();
    startCountdownRedirect();
  } catch (err) {
    uploadProgress.value = null;
    if (err instanceof ApiError) {
      errorMsg.value = err.displayMessage;
    } else {
      errorMsg.value = getErrorMessage({}, t('composerFailed'));
    }
  } finally {
    submitting.value = false;
  }
}

export function Composer(): VNode {
  useOwnerCredentials();
  useEffect(() => {
    initLanguage();
    void restoreDraftOnce();
  }, []);

  if (!ownerCredentialsReady.value) {
    // 整站登录态由 SiteAuthGate 统一展示；子页面避免重复渲染“正在校验登录状态…”残留在内容底部。
    return <div aria-busy="true" />;
  }

  // gate 1：未配私密地址
  if (ownerBaseUrl.value === null) {
    return (
      <section class="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm leading-6 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
        <h2 class="text-base font-semibold">{t('composerGateEndpointTitle')}</h2>
        <p class="mt-2">{t('composerGateEndpointBody')}</p>
        <a
          href="/settings"
          class="mt-3 inline-block rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700"
        >
          {t('composerSettings')}
        </a>
      </section>
    );
  }

  // gate 2：会话失效（整站门禁已登录；此处为 JWT 过期等纵深防御）
  if (ownerJwt.value === null) {
    return (
      <section class="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm leading-6 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
        <h2 class="text-base font-semibold">{t('composerGateSessionTitle')}</h2>
        <p class="mt-2">{t('composerGateSessionBody')}</p>
        <button
          type="button"
          class="mt-3 inline-block rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700"
          onClick={clearOwnerSessionForLogin}
        >
          {t('composerReturnLogin')}
        </button>
      </section>
    );
  }

  const remaining = MAX_CONTENT_LENGTH - contentLength.value;
  const counterCls =
    remaining < 0
      ? 'text-rose-600 font-semibold'
      : remaining <= 20
        ? 'text-amber-600'
        : 'text-slate-500';

  return (
    <form class="space-y-4" onSubmit={handleSubmit}>
      {/* ── 成功提示 ─────────────────────────────────────────────────── */}
      {successMsg.value && (
        <div
          class="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200"
          role="status"
          aria-live="polite"
        >
          {successMsg.value}
          {countdown.value > 0 && (
            <span class="ml-1">{t('composerRedirectCountdown', undefined, { seconds: countdown.value })}</span>
          )}
        </div>
      )}

      {/* ── 错误提示 ─────────────────────────────────────────────────── */}
      {errorMsg.value && (
        <div
          class="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200"
          role="alert"
          aria-live="polite"
        >
          {errorMsg.value}
        </div>
      )}

      {/* ── 内容输入 ─────────────────────────────────────────────────── */}
      <section class="border-b border-[#eff3f4] py-4 dark:border-[#2f3336]">
        <label class="block text-[15px] font-bold text-zinc-950 dark:text-zinc-50" for="composer-content">
          {t('composerContentLabel')}
        </label>
        {/* M7-7b：草稿已恢复提示条（1 次页面生命周期可见，点叉可隐藏） */}
        {draftRestoredHint.value && (
          <div
            class="mt-2 flex items-start justify-between gap-2 rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200"
            role="status"
            aria-live="polite"
          >
            <span>{t('composerDraftRestored')}</span>
            <button
              type="button"
              class="shrink-0 rounded text-sky-700 hover:text-sky-900"
              aria-label={t('composerDraftRestoredClose')}
              onClick={() => {
                draftRestoredHint.value = false;
              }}
            >
              ×
            </button>
          </div>
        )}
        <textarea
          id="composer-content"
          rows={5}
          maxLength={2000}
          placeholder={t('composerTextareaPlaceholder')}
          value={content.value}
          onInput={(e) => {
            content.value = (e.currentTarget as HTMLTextAreaElement).value;
            // M7-7b：每次输入 debounce 1s 后落库，避免频繁写 IDB
            scheduleDraftSave();
          }}
          class="hailuo-focus mt-3 min-h-[160px] w-full resize-y border-0 bg-transparent px-0 py-3 text-[17px] leading-6 text-zinc-900 placeholder:text-zinc-500 focus:outline-none dark:text-zinc-50 dark:placeholder:text-zinc-500"
        />
        <div class={`mt-2 flex items-center justify-between text-xs`}>
          <span class="text-zinc-500 dark:text-zinc-400" aria-live="polite">
            {draftStatus.value === 'saving'
              ? t('composerDraftSaving')
              : draftStatus.value === 'saved'
                ? t('composerDraftSaved')
                : ''}
          </span>
          <span class={counterCls}>
            {contentLength.value} / {MAX_CONTENT_LENGTH}
          </span>
        </div>
      </section>

      {/* ── 图片选择 + 预览 ─────────────────────────────────────────── */}
      <section class="border-b border-[#eff3f4] py-4 dark:border-[#2f3336]">
        <div class="flex items-center justify-between">
          <label class="text-[15px] font-bold text-zinc-950 dark:text-zinc-50" for="composer-images">
            {t('composerImagesLabel', undefined, { count: MAX_IMAGE_COUNT })}
          </label>
          <span class="text-xs text-slate-500 dark:text-zinc-400">
            {previews.value.length} / {MAX_IMAGE_COUNT}
          </span>
        </div>
        <input
          id="composer-images"
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => {
            const inputEl = e.currentTarget as HTMLInputElement;
            addFiles(inputEl.files);
            // 重置 input 以便再次选择同名文件
            inputEl.value = '';
          }}
          class="mt-2 block w-full text-sm text-slate-700 file:mr-3 file:rounded-full file:border-0 file:bg-sky-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-sky-700 hover:file:bg-sky-100 dark:text-zinc-300 dark:file:bg-sky-500/10 dark:file:text-sky-300 dark:hover:file:bg-sky-500/20"
        />

        {previews.value.length > 0 && (
          <ul class="mt-3 grid grid-cols-3 gap-2">
            {previews.value.map((pv) => (
              <li
                key={pv.id}
                class="group relative aspect-square overflow-hidden rounded-xl border border-zinc-300 bg-slate-100 dark:border-zinc-700 dark:bg-zinc-900"
              >
                <img
                  src={pv.url}
                  alt={t('composerImageAlt', undefined, { name: pv.file.name })}
                  class="h-full w-full object-cover"
                />
                <button
                  type="button"
                  aria-label={t('composerRemoveImage', undefined, { name: pv.file.name })}
                  onClick={() => removePreview(pv.id)}
                  class="absolute right-1 top-1 rounded-full bg-slate-900/70 px-2 py-0.5 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100"
                >
                  {t('postDelete')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 提交 ─────────────────────────────────────────────────────── */}
      <div class="flex items-center justify-between py-4">
        <span class="text-xs text-zinc-500 dark:text-zinc-400">
          {uploadProgress.value
            ? t('composerUploading', undefined, { current: uploadProgress.value.current, total: uploadProgress.value.total })
            : submitting.value
              ? t('composerPublishing')
              : ''}
        </span>
        <button
          type="submit"
          disabled={!canSubmit.value}
          class="rounded-full bg-sky-500 px-5 py-2 text-sm font-bold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-500 dark:hover:bg-sky-400"
        >
          {submitting.value ? t('composerSubmitting') : t('composerSubmit')}
        </button>
      </div>
    </form>
  );
}
