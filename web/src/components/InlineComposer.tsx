/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal, computed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Image as ImageIcon, X } from 'lucide-preact';
import { getOwnerJwt, resolveWorkerAUrl } from '../lib/auth';
import { clearOwnerSessionForLogin } from '../lib/ownerSession';
import { createWorkerAClient } from '../lib/workerA';
import { ApiError, getErrorMessage } from '../lib/errors';
import { deleteDraft, saveDraft } from '../lib/localDb';
import { restoreDraftToForm } from '../lib/draftRestore';
import { isQuotaExceeded } from '../lib/idbErrors';
import { showToast } from '../lib/toast';
import { initLanguage, t } from '../lib/i18n';

// M7-5b-3：Timeline 顶部行内紧凑发帖框（X 风格 inline composer）
//
// 设计要点：
// - **仅 UI 重写，不动业务逻辑**：发帖契约与 Composer.tsx 完全一致——createWorkerAClient + 串行 uploadImage → createPost
// - **三态 gate**（紧凑提示，不抢中栏视觉）：
//   - 未配 baseUrl → 单行链接「请前往设置配置节点地址」
//   - 已配但未登录 → 单行链接「请前往设置以站主身份登录」
//   - 双 gate 通过 → 主体表单
// - **X 风格紧凑结构**：左圆形头像（随语言显示 Me/我 + 中性 zinc 调色）+ 右侧可伸缩 textarea（默认 2 行，自动随内容增高）+ 底部一行 ImageIcon button + 字数计 + 发布按钮
// - **图片预览**：水平滚动小缩略图行，每张右上 × 删除，最多 9 张
// - **发帖成功**：调用 onPosted 回调（Timeline 注入）由 Timeline 决定刷新策略；自身只清空表单 + 显示 1.5s 「已发布」浅 toast
// - §F-02：本组件用 auth.ts.getWorkerAUrl 运行时读取，不引入 Worker A URL 字面量
//
// M7-10（F-01 修复）+ M7-19（§5）：草稿自动保存；?draft= 与 Composer 同源；多草稿提示链到设置/完整发帖页
//   * 输入 textarea 走 debounce 1s 后派发 saveDraft 入 IDB drafts store；首次保存拿回 autoIncrement draft_id 记住
//   * useEffect mount 时带 listDrafts() 拿最近一条（按 updated_at DESC 排序）以预填 textarea + icDraftId
//   * 草稿内容 trim 为空时 deleteDraft 清除指针，避免「空草稿」驻留
//   * 发帖提交成功后 deleteDraft 上下文草稿（避免下次进入又被恢复）
//   * 与 Composer.tsx 共享 IDB drafts store：两组件 mount 时都恢复 drafts[0]（最近一条），
//     与 X 实际行为同源（inline + modal composer 共享单条草稿）；同时编辑时以最后 save 的为准
//   * 仅持文字部分；image_keys=[] 预留（File 未上传前不可靠序列化，且 URL.createObjectURL 刷新后失效）
//   * 错误沉默（SSR / IDB 禁用 / 隐身模式），不阻塞主发帖流程

const MAX_CONTENT_LENGTH = 500;
const MAX_IMAGE_COUNT = 9;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** M7-10：草稿自动保存 debounce（1s），与 Composer.tsx 同步语义 */
const DRAFT_DEBOUNCE_MS = 1000;

interface PreviewImage {
  readonly id: string;
  readonly file: File;
  readonly url: string;
}

// 模块级 signals（与 Composer.tsx 同源理由：Astro 单页面单 island，避免重渲染态丢）
// 命名加 `ic` 前缀以与 Composer.tsx 完整发帖器的同名 signals 隔离，避免两组件同页时串扰
const icContent = signal<string>('');
const icPreviews = signal<readonly PreviewImage[]>([]);
const icSubmitting = signal<boolean>(false);
const icUploadProgress = signal<{ current: number; total: number } | null>(null);
const icErrorMsg = signal<string | null>(null);
const icSuccessFlash = signal<boolean>(false);
const icBaseUrl = signal<string | null>(null);
const icJwt = signal<string | null>(null);
const icCredentialsReady = signal<boolean>(false);
const icDraftId = signal<number | undefined>(undefined);
/** M7-19：除当前恢复条外还有多少条草稿 */
const icOtherDraftCount = signal<number>(0);

// M7-10：草稿保存 debounce 句柄；模块级与 signals 同周期
let icDraftSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** M7-10 F-01：写入或删除当前草稿；空内容时清除指针
 *  M7-13 F-13：saveDraft/deleteDraft 失败时区分 QuotaExceeded → 走 toast，其它错误仍静默 */
async function icPersistDraftNow(): Promise<void> {
  if (typeof indexedDB === 'undefined') return; // SSR / 不支持的环境静默跳过
  const text = icContent.value;
  if (!text.trim()) {
    const id = icDraftId.value;
    if (id !== undefined) {
      try {
        await deleteDraft(id);
      } catch (err) {
        // M7-13 F-13：QuotaExceeded 给 toast，其它错误静默吞，不阻塞主流程
        if (isQuotaExceeded(err)) showToast(t('localStorageQuotaExceeded'), 'error');
      }
      icDraftId.value = undefined;
    }
    return;
  }
  try {
    const id = await saveDraft({
      draft_id: icDraftId.value,
      content: text,
      image_keys: [],
      updated_at: Date.now(),
    });
    icDraftId.value = id;
  } catch (err) {
    // M7-13 F-13：QuotaExceeded 给 toast，其它错误静默吞，下次输入会重调
    if (isQuotaExceeded(err)) showToast(t('localStorageQuotaExceeded'), 'error');
  }
}

/** M7-10 F-01：onInput 后走 debounce，1s 内重复输入仅最后一次入库 */
function icScheduleDraftSave(): void {
  if (typeof window === 'undefined') return;
  if (icDraftSaveTimer !== null) clearTimeout(icDraftSaveTimer);
  icDraftSaveTimer = setTimeout(() => {
    icDraftSaveTimer = null;
    void icPersistDraftNow();
  }, DRAFT_DEBOUNCE_MS);
}

/** M7-10 + M7-19：mount 恢复草稿（?draft= 优先，与 Composer 同源） */
async function icRestoreDraftOnce(): Promise<void> {
  const result = await restoreDraftToForm({
    getContent: () => icContent.value,
    setContent: (v) => {
      icContent.value = v;
    },
    setDraftId: (id) => {
      icDraftId.value = id;
    },
  });
  icOtherDraftCount.value = result.draftCount > 1 ? result.draftCount - 1 : 0;
}

const icContentLength = computed(() => [...icContent.value].length);
const icCanSubmit = computed(() => {
  const len = icContentLength.value;
  return (
    !icSubmitting.value &&
    len > 0 &&
    len <= MAX_CONTENT_LENGTH &&
    icPreviews.value.length <= MAX_IMAGE_COUNT
  );
});

async function refreshCredentials(showLoading = false): Promise<void> {
  if (showLoading) icCredentialsReady.value = false;
  icBaseUrl.value = await resolveWorkerAUrl();
  icJwt.value = getOwnerJwt();
  icCredentialsReady.value = true;
}

function genPreviewId(): string {
  return `icpv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function addFiles(files: FileList | null): void {
  if (!files || files.length === 0) return;
  const next: PreviewImage[] = [...icPreviews.value];
  for (const file of Array.from(files)) {
    if (next.length >= MAX_IMAGE_COUNT) break;
    if (!file.type.startsWith('image/')) {
      icErrorMsg.value = t('composerUnsupportedFileType', undefined, { type: file.type || t('composerUnknownFileType') });
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      icErrorMsg.value = t('composerFileTooLarge', undefined, { name: file.name });
      continue;
    }
    next.push({ id: genPreviewId(), file, url: URL.createObjectURL(file) });
  }
  icPreviews.value = next;
}

function removePreview(id: string): void {
  const removed = icPreviews.value.find((p) => p.id === id);
  if (removed) URL.revokeObjectURL(removed.url);
  icPreviews.value = icPreviews.value.filter((p) => p.id !== id);
}

function resetForm(): void {
  for (const p of icPreviews.value) URL.revokeObjectURL(p.url);
  icPreviews.value = [];
  icContent.value = '';
  icErrorMsg.value = null;
  // M7-10 F-01：发帖成功后同步清除 IDB 上下文草稿，避免下次进入又被预填
  if (icDraftSaveTimer !== null) {
    clearTimeout(icDraftSaveTimer);
    icDraftSaveTimer = null;
  }
  const idToDelete = icDraftId.value;
  icDraftId.value = undefined;
  if (idToDelete !== undefined && typeof indexedDB !== 'undefined') {
    void deleteDraft(idToDelete).catch(() => {
      // 静默：删除失败不影响发帖成功后续逻辑
    });
  }
}

function flashSuccess(): void {
  icSuccessFlash.value = true;
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    icSuccessFlash.value = false;
  }, 1500);
}

export interface InlineComposerProps {
  /** 发帖成功后由 Timeline 注入：用于触发 Feed 刷新（重新拉首屏） */
  readonly onPosted?: () => void;
}

async function handleSubmit(e: Event, onPosted?: () => void): Promise<void> {
  e.preventDefault();
  icErrorMsg.value = null;

  const trimmed = icContent.value.trim();
  if (!trimmed) {
    icErrorMsg.value = t('composerEmpty');
    return;
  }
  if ([...trimmed].length > MAX_CONTENT_LENGTH) {
    icErrorMsg.value = t('composerTooLong', undefined, { max: MAX_CONTENT_LENGTH });
    return;
  }

  const currentBaseUrl = icBaseUrl.value;
  const currentJwt = icJwt.value;
  if (!currentBaseUrl || !currentJwt) {
    icErrorMsg.value = t('composerMissingCredential');
    return;
  }

  icSubmitting.value = true;
  const client = createWorkerAClient({
    baseUrl: currentBaseUrl,
    getJwt: () => currentJwt,
  });

  try {
    const imageKeys: string[] = [];
    const total = icPreviews.value.length;
    for (let i = 0; i < total; i++) {
      const pv = icPreviews.value[i];
      if (!pv) continue;
      icUploadProgress.value = { current: i + 1, total };
      const result = await client.uploadImage({
        body: pv.file,
        contentType: pv.file.type,
        contentLength: pv.file.size,
      });
      imageKeys.push(result.key);
    }
    icUploadProgress.value = null;

    await client.createPost({ content: trimmed, images: imageKeys });
    resetForm();
    flashSuccess();
    if (onPosted) onPosted();
  } catch (err) {
    icUploadProgress.value = null;
    if (err instanceof ApiError) {
      icErrorMsg.value = err.displayMessage;
    } else {
      icErrorMsg.value = getErrorMessage({}, t('composerFailed'));
    }
  } finally {
    icSubmitting.value = false;
  }
}

/** 紧凑提示条：未配地址 / 会话失效时的内联引导 */
function GateNotice({
  message,
  href = '/settings',
  linkLabel = t('composerSettings'),
  onLoginReset,
}: {
  readonly message: string;
  readonly href?: string;
  readonly linkLabel?: string;
  readonly onLoginReset?: () => void;
}): VNode {
  return (
    <section
      class="mx-4 mt-3 rounded-2xl border border-[#eff3f4] bg-zinc-50/70 px-4 py-3 text-sm text-zinc-600 dark:border-[#2f3336] dark:bg-zinc-900/40 dark:text-zinc-400"
      role="status"
    >
      {message}
      {onLoginReset ? (
        <button
          type="button"
          class="ml-2 font-medium text-sky-600 hover:underline dark:text-sky-400"
          onClick={onLoginReset}
        >
          {linkLabel}
        </button>
      ) : (
        <a
          href={href}
          class="ml-2 font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          {linkLabel}
        </a>
      )}
    </section>
  );
}

export function InlineComposer(props: InlineComposerProps = {}): VNode {
  useEffect(() => {
    initLanguage();
    const run = (showLoading: boolean): void => {
      void refreshCredentials(showLoading);
    };
    run(!icCredentialsReady.value);
    void icRestoreDraftOnce();
    const onNavigate = (): void => run(false);
    document.addEventListener('astro:page-load', onNavigate);
    document.addEventListener('astro:after-swap', onNavigate);
    return () => {
      document.removeEventListener('astro:page-load', onNavigate);
      document.removeEventListener('astro:after-swap', onNavigate);
    };
  }, []);

  if (!icCredentialsReady.value) {
    return <GateNotice message={t('feedLoadingConfig')} />;
  }

  // gate 1：未配私密地址
  if (icBaseUrl.value === null) {
    return <GateNotice message={t('composerGateEndpoint')} />;
  }

  // gate 2：会话失效（整站门禁已登录；JWT 过期时纵深防御）
  if (icJwt.value === null) {
    return (
      <GateNotice
        message={t('composerGateLogin')}
        linkLabel={t('composerBackLogin')}
        onLoginReset={clearOwnerSessionForLogin}
      />
    );
  }

  const remaining = MAX_CONTENT_LENGTH - icContentLength.value;
  const counterCls =
    remaining < 0
      ? 'text-rose-600 font-semibold dark:text-rose-400'
      : remaining <= 20
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-fg3';

  const onPosted = props.onPosted;

  return (
    <form
      class="border-b border-[#eff3f4] bg-transparent px-4 py-3 dark:border-[#2f3336]"
      onSubmit={(e) => {
        void handleSubmit(e, onPosted);
      }}
      aria-label={t('composerLabel')}
    >
      {/* UX-FEED-FLUSH-1：与时间线同宽底边分隔，帖与帖贴齐 */}
      <div class="flex gap-3">
        {/* 站主头像占位：随界面语言显示 Me/我，与 PostCard 头像同直径 */}
        <div
          class="flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-full bg-sky-600 text-base font-bold text-white dark:bg-sky-500"
          aria-hidden="true"
        >
          {t('composerAvatarLabel')}
        </div>

        {/* 右侧：textarea + 图片预览 + 操作行 */}
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <textarea
            id="inline-composer-content"
            rows={2}
            maxLength={2000}
            placeholder={t('composerPlaceholder')}
            value={icContent.value}
            onInput={(e) => {
              icContent.value = (e.currentTarget as HTMLTextAreaElement).value;
              // M7-10 F-01：每次输入后调度 debounce 草稿保存
              icScheduleDraftSave();
            }}
            class="hailuo-focus min-h-[80px] w-full resize-none border-0 bg-transparent px-0 py-2 text-[17px] leading-6 text-zinc-900 placeholder:text-zinc-500 focus:outline-none dark:text-zinc-50 dark:placeholder:text-zinc-500"
          />

          {icOtherDraftCount.value > 0 && (
            <p class="text-xs text-zinc-500 dark:text-zinc-400" role="status">
              {t('composerDraftsPrefix', undefined, { count: icOtherDraftCount.value })}
              <a href="/composer" class="ml-1 font-medium text-sky-600 hover:underline dark:text-sky-400">
                {t('composerFullPage')}
              </a>
              <span class="mx-1 text-zinc-400">/</span>
              <a href="/settings" class="ml-1 font-medium text-sky-600 hover:underline dark:text-sky-400">
                {t('composerManageInSettings')}
              </a>
            </p>
          )}

          {/* 图片预览：横向小缩略图行 */}
          {icPreviews.value.length > 0 && (
            <ul class="flex flex-wrap gap-2">
              {icPreviews.value.map((pv) => (
                <li
                  key={pv.id}
                  class="group relative h-20 w-20 overflow-hidden rounded-lg ring-1 ring-[#eff3f4] dark:ring-[#2f3336]"
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
                    class="absolute right-0.5 top-0.5 rounded-full bg-zinc-900/70 p-0.5 text-white opacity-90 transition hover:bg-zinc-900 group-hover:opacity-100"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* 错误提示（紧凑红字） */}
          {icErrorMsg.value && (
            <p
              class="text-xs text-rose-600 dark:text-rose-400"
              role="alert"
              aria-live="polite"
            >
              {icErrorMsg.value}
            </p>
          )}

          {/* 成功 flash（1.5s 自动消失） */}
          {icSuccessFlash.value && (
            <p
              class="text-xs text-emerald-600 dark:text-emerald-400"
              role="status"
              aria-live="polite"
            >
              {t('composerPublished')}
            </p>
          )}

          {/* 上传进度（紧凑灰字） */}
          {icUploadProgress.value && (
            <p class="text-xs text-zinc-500 dark:text-zinc-400">
              {t('composerUploading', undefined, { current: icUploadProgress.value.current, total: icUploadProgress.value.total })}
            </p>
          )}

          {/* 操作行：左 ImagePlus / 中 字数计 / 右 发布按钮 */}
          <div class="flex items-center justify-between border-t border-zinc-200/80 pt-3 dark:border-zinc-700/80">
            <label
              class="flex cursor-pointer items-center gap-1 rounded-full p-1.5 text-sky-600 transition hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-500/10"
              title={t('composerAddImage')}
              aria-label={t('composerAddImage')}
            >
              <ImageIcon size={20} strokeWidth={2} aria-hidden="true" />
              <input
                id="inline-composer-images"
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => {
                  const inputEl = e.currentTarget as HTMLInputElement;
                  addFiles(inputEl.files);
                  inputEl.value = '';
                }}
                class="hidden"
              />
            </label>

            <div class="flex items-center gap-3">
              <span class={`text-xs tabular-nums ${counterCls}`}>
                {icContentLength.value} / {MAX_CONTENT_LENGTH}
              </span>
              <button
                type="submit"
                disabled={!icCanSubmit.value}
                class="rounded-full bg-sky-500 px-5 py-2 text-sm font-bold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-500 dark:hover:bg-sky-400"
              >
                {icSubmitting.value ? t('composerSubmitting') : t('composerSubmit')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
