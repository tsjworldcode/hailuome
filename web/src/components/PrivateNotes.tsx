/** @jsxImportSource preact */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Check, Download, Edit3, FileUp, Image as ImageIcon, Loader2, Lock, Paperclip, Search, Send, Trash2, X } from 'lucide-preact';
import { ConfirmDialog } from './ConfirmDialog';
import { getDmKekMaterial } from '../lib/dmSession';
import { ApiError } from '../lib/errors';
import { formatRelativeTime } from '../lib/timeFormat';
import {
  decryptPrivateNoteItem,
  enablePrivateNotesEncryption,
  encryptPrivateNoteContentForApi,
  hasPrivateNotesMasterKeyInSession,
  hydratePrivateNotesMasterKey,
} from '../lib/privateNotesService';
import { getPrivateNotesMasterKey } from '../lib/privateNotesSession';
import { createWorkerAClient, type PrivateNoteAttachmentItem, type PrivateNoteItem } from '../lib/workerA';
import {
  ownerBaseUrl,
  ownerCredentialsReady,
  ownerJwt,
  useOwnerCredentials,
} from '../lib/useOwnerCredentials';
import { initLanguage, language, t } from '../lib/i18n';

function noteSortDesc(items: readonly PrivateNoteItem[]): readonly PrivateNoteItem[] {
  return [...items].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

function noteSortAsc(items: readonly PrivateNoteItem[]): readonly PrivateNoteItem[] {
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** 与 Worker A PATCH 一致：纯文本不能为空；有附件时允许空正文。 */
function canSavePrivateNoteEdit(content: string, attachmentCount: number): boolean {
  return content.length > 0 || attachmentCount > 0;
}

function renderTime(note: PrivateNoteItem): string {
  const lang = language.value;
  return note.updated_at !== note.created_at
    ? `${formatRelativeTime(note.updated_at, Date.now(), lang)} ${t('privateNotesEditedSuffix')}`
    : formatRelativeTime(note.created_at, Date.now(), lang);
}

function attachmentLabel(att: PrivateNoteAttachmentItem): string {
  return att.name || att.mime || t('privateNotesAttachmentFallback');
}

function formatSize(size: number | null): string {
  if (!size || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function exportFileName(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `hailuo-private-notes-${stamp}.json`;
}

async function downloadAttachment(att: PrivateNoteAttachmentItem): Promise<void> {
  const baseUrl = ownerBaseUrl.value;
  const jwt = ownerJwt.value;
  if (!baseUrl || !jwt) return;
  const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
  const blob = await client.fetchPrivateNoteAttachment(att.id);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = attachmentLabel(att);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function AttachmentPreview({ attachment }: { attachment: PrivateNoteAttachmentItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  async function handleDownload(): Promise<void> {
    setDownloading(true);
    try {
      await downloadAttachment(attachment);
    } finally {
      setDownloading(false);
    }
  }

  useEffect(() => {
    if (!attachment.mime.startsWith('image/')) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    let currentUrl: string | null = null;
    let cancelled = false;
    void client.fetchPrivateNoteAttachment(attachment.id)
      .then((blob) => {
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setUrl(currentUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [attachment.id, attachment.mime]);

  const meta = [attachment.mime, formatSize(attachment.size_bytes)].filter(Boolean).join(' · ');
  if (attachment.mime.startsWith('image/')) {
    return (
      <div class="mt-2 overflow-hidden rounded-xl border border-white/20 bg-white/10">
        {url ? (
          <img src={url} alt={attachmentLabel(attachment)} class="max-h-72 w-full object-contain" />
        ) : (
          <div class="flex h-28 items-center justify-center gap-2 text-sm text-white/80">
            {failed ? <ImageIcon size={18} aria-hidden="true" /> : <Loader2 size={18} class="animate-spin" aria-hidden="true" />}
            <span>{failed ? t('privateNotesImageLoadFailed') : t('privateNotesImageLoading')}</span>
          </div>
        )}
        <button
          type="button"
          class="flex items-center justify-between gap-3 px-3 py-2 text-xs text-white/80 hover:bg-white/10"
          onClick={() => void handleDownload()}
        >
          <span class="min-w-0 truncate">{attachmentLabel(attachment)}</span>
          {downloading ? <Loader2 size={14} class="animate-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      class="mt-2 flex items-center gap-3 rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15"
      onClick={() => void handleDownload()}
    >
      <FileUp size={18} class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1">
        <span class="block truncate">{attachmentLabel(attachment)}</span>
        {meta && <span class="block truncate text-xs text-white/70">{meta}</span>}
      </span>
      {downloading ? <Loader2 size={15} class="shrink-0 animate-spin" aria-hidden="true" /> : <Download size={15} class="shrink-0" aria-hidden="true" />}
    </button>
  );
}

export function PrivateNotes() {
  useEffect(() => {
    initLanguage();
  }, []);

  const [items, setItems] = useState<readonly PrivateNoteItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** UX-CONFIRM：自定义确认弹窗，替代 window.confirm */
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [encryptConfirmOpen, setEncryptConfirmOpen] = useState(false);
  const [encryptEnabling, setEncryptEnabling] = useState(false);
  const [encryptDialogError, setEncryptDialogError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<readonly PrivateNoteAttachmentItem[]>([]);
  const [serverEncryptionEnabled, setServerEncryptionEnabled] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const makeClient = useCallback(() => {
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return null;
    return createWorkerAClient({ baseUrl, getJwt: () => jwt });
  }, []);

  const loadNotes = useCallback(async (opts?: { append?: boolean; before?: string | null; q?: string }) => {
    const client = makeClient();
    if (!client) {
      setError(t('privateNotesLoginRequired'));
      setLoading(false);
      return;
    }
    if (opts?.append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const qRaw = (opts?.q ?? search.trim());
      const useClientSearch = serverEncryptionEnabled && qRaw.length > 0;
      const data = await client.listPrivateNotes({
        limit: 30,
        before: opts?.before ?? undefined,
        q: useClientSearch ? undefined : qRaw || undefined,
      });
      const masterKey = getPrivateNotesMasterKey();
      const decrypted = await Promise.all(data.items.map((item) => decryptPrivateNoteItem(item, masterKey)));
      let pageItems = decrypted;
      if (useClientSearch) {
        const qLower = qRaw.toLowerCase();
        pageItems = decrypted.filter((item) => item.content.toLowerCase().includes(qLower));
      }
      setItems((prev) => opts?.append ? noteSortDesc([...prev, ...pageItems]) : pageItems);
      setCursor(data.cursor);
      setHasMore(data.has_more);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('privateNotesLoadFailed'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [makeClient, search, serverEncryptionEnabled]);

  const refreshEncryptionStatus = useCallback(async () => {
    const client = makeClient();
    if (!client) return;
    try {
      const remote = await client.getPrivateNotesWrappedKey();
      setServerEncryptionEnabled(remote.enabled);
      const passwordHash = getDmKekMaterial();
      if (passwordHash && remote.enabled) {
        await hydratePrivateNotesMasterKey(client, passwordHash);
      }
    } catch {
      // 加密状态读取失败不阻断列表
    }
  }, [makeClient]);

  useOwnerCredentials(() => {
    void refreshEncryptionStatus().then(() => loadNotes({ q: search.trim() }));
  });

  useEffect(() => {
    if (!ownerCredentialsReady.value) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void loadNotes({ q: search.trim() });
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, loadNotes]);

  async function handleCreate(): Promise<void> {
    const content = draft.trim();
    if (!content && pendingAttachments.length === 0) return;
    const client = makeClient();
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      const masterKey = getPrivateNotesMasterKey();
      const storedContent = await encryptPrivateNoteContentForApi(content, masterKey);
      const created = await client.createPrivateNote({
        content: storedContent,
        attachmentIds: pendingAttachments.map((att) => att.id),
      });
      const displayCreated = await decryptPrivateNoteItem(created, masterKey);
      setDraft('');
      setPendingAttachments([]);
      setItems((prev) => noteSortDesc([displayCreated, ...prev]));
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('privateNotesSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function confirmEnableEncryption(): Promise<void> {
    if (encryptEnabling) return;
    const client = makeClient();
    const passwordHash = getDmKekMaterial();
    if (!client || !passwordHash) {
      setEncryptConfirmOpen(false);
      setEncryptDialogError(null);
      setError(t('privateNotesReloginForEncrypt'));
      return;
    }
    setEncryptEnabling(true);
    setEncryptDialogError(null);
    setError(null);
    setNotice(null);
    try {
      await enablePrivateNotesEncryption(client, passwordHash);
      setServerEncryptionEnabled(true);
      setEncryptConfirmOpen(false);
      setNotice(t('privateNotesEncryptEnabledNotice'));
    } catch (err) {
      // 失败时错误写在弹窗内，避免遮罩挡住页面横幅、用户误以为「点了没反应」
      setEncryptDialogError(err instanceof ApiError ? err.displayMessage : t('privateNotesEnableEncryptFailed'));
    } finally {
      setEncryptEnabling(false);
    }
  }

  async function handleAttachFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const client = makeClient();
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      const uploaded: PrivateNoteAttachmentItem[] = [];
      for (const file of Array.from(files).slice(0, 6)) {
        uploaded.push(await client.uploadPrivateNoteAttachment({ file, name: file.name }));
      }
      setPendingAttachments((prev) => [...prev, ...uploaded].slice(0, 10));
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('privateNotesUploadAttachmentFailed'));
    } finally {
      setSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleRemovePendingAttachment(id: string): Promise<void> {
    const client = makeClient();
    setPendingAttachments((prev) => prev.filter((att) => att.id !== id));
    if (!client) return;
    try {
      await client.deletePrivateNoteAttachment(id);
    } catch {
      // 删除待发送附件失败时，至少从当前 composer 移除，服务端软删可后续清理。
    }
  }

  async function handleUpdate(id: string): Promise<void> {
    const content = editingText.trim();
    const item = items.find((entry) => entry.id === id);
    if (!canSavePrivateNoteEdit(content, item?.attachments.length ?? 0)) return;
    const client = makeClient();
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      const masterKey = getPrivateNotesMasterKey();
      const storedContent = await encryptPrivateNoteContentForApi(content, masterKey);
      const updated = await client.updatePrivateNote(id, { content: storedContent });
      const displayUpdated = await decryptPrivateNoteItem(updated, masterKey);
      setItems((prev) => prev.map((item) => item.id === id ? displayUpdated : item));
      setEditingId(null);
      setEditingText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('privateNotesUpdateFailed'));
    } finally {
      setSaving(false);
    }
  }

  function requestDelete(id: string): void {
    setDeleteTargetId(id);
    setError(null);
  }

  async function confirmDelete(): Promise<void> {
    const id = deleteTargetId;
    if (!id) return;
    const client = makeClient();
    if (!client) return;
    setDeletingId(id);
    setError(null);
    try {
      await client.deletePrivateNote(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      setDeleteTargetId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('privateNotesDeleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleExport(): Promise<void> {
    const client = makeClient();
    if (!client) return;
    setTransferring(true);
    setError(null);
    setNotice(null);
    try {
      const snapshot = await client.exportPrivateNotes();
      const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = exportFileName();
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setNotice(t('privateNotesExportNotice', undefined, { count: snapshot.meta.counts.notes }));
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('privateNotesExportFailed'));
    } finally {
      setTransferring(false);
    }
  }

  async function handleImportFile(files: FileList | null): Promise<void> {
    const file = files?.[0];
    if (!file) return;
    const client = makeClient();
    if (!client) return;
    setTransferring(true);
    setError(null);
    setNotice(null);
    try {
      const snapshot = JSON.parse(await file.text()) as unknown;
      const result = await client.importPrivateNotes(snapshot);
      await loadNotes({ q: search.trim() });
      setNotice(
        t('privateNotesImportNotice', undefined, {
          imported: result.imported_notes,
          skipped: result.skipped_notes,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('privateNotesImportFailed'));
    } finally {
      setTransferring(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  }

  if (!ownerCredentialsReady.value || loading) {
    return (
      <div class="flex min-h-[60vh] items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        {t('privateNotesLoading')}
      </div>
    );
  }

  const displayItems = noteSortAsc(items);

  return (
    <section class="flex h-full min-h-0 flex-col">
      <header class="sticky top-0 z-10 border-b border-zinc-200/80 bg-white/95 px-4 py-3 backdrop-blur dark:border-zinc-800/80 dark:bg-black/95">
        <div class="flex items-center justify-between gap-3">
          <h1 class="text-xl font-bold text-zinc-950 dark:text-zinc-50">{t('privateNotesTitle')}</h1>
          <div class="ml-auto flex items-center gap-2">
            {!serverEncryptionEnabled && (
              <button
                type="button"
                class="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                aria-label={t('privateNotesEnableEncryptAria')}
                title={t('privateNotesEnableEncryptAria')}
                disabled={saving || transferring}
                onClick={() => {
                  setEncryptDialogError(null);
                  setEncryptConfirmOpen(true);
                }}
              >
                <Lock size={17} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              class="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
              aria-label={t('privateNotesExportAria')}
              title={t('privateNotesExportAria')}
              disabled={transferring}
              onClick={() => void handleExport()}
            >
              {transferring ? <Loader2 size={17} class="animate-spin" aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}
            </button>
            <input
              ref={importInputRef}
              type="file"
              class="hidden"
              accept="application/json"
              aria-label={t('privateNotesImportSelectAria')}
              onChange={(event) => void handleImportFile((event.target as HTMLInputElement).files)}
            />
            <button
              type="button"
              class="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
              aria-label={t('privateNotesImportAria')}
              title={t('privateNotesImportAria')}
              disabled={transferring}
              onClick={() => importInputRef.current?.click()}
            >
              <FileUp size={17} aria-hidden="true" />
            </button>
          </div>
          <div class="relative min-w-0 flex-1 max-w-[18rem]">
            <Search class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={16} aria-hidden="true" />
            <input
              class="hailuo-focus h-10 w-full rounded-full border border-zinc-200 bg-zinc-50 pl-9 pr-3 text-sm outline-none transition focus:border-sky-400 focus:bg-white dark:border-zinc-800 dark:bg-zinc-950 dark:focus:border-sky-500"
              value={search}
              placeholder={t('privateNotesSearchPlaceholder')}
              aria-label={t('privateNotesSearchAria')}
              onInput={(event) => setSearch((event.target as HTMLInputElement).value)}
            />
          </div>
        </div>
      </header>

      {/* 附件不走帖子 R2：默认 KV，过大失败；Filebase/B2 另议 */}
      <p
        class="mx-4 mt-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300"
        role="note"
      >
        {t('privateNotesKvStorageHint')}
      </p>

      {serverEncryptionEnabled && !hasPrivateNotesMasterKeyInSession() && (
        <p class="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200" role="status">
          {t('privateNotesEncryptedHint')}
        </p>
      )}
      {serverEncryptionEnabled && search.trim().length > 0 && (
        <p class="mx-4 mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200" role="status">
          {t('privateNotesEncryptedSearchHint')}
        </p>
      )}
      {error && (
        <p class="mx-4 mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p class="mx-4 mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200" role="status">
          {notice}
        </p>
      )}

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {hasMore && (
          <div class="mb-4 flex justify-center">
            <button
              type="button"
              class="inline-flex h-9 items-center justify-center rounded-full border border-zinc-200 px-4 text-sm text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
              disabled={loadingMore}
              onClick={() => void loadNotes({ append: true, before: cursor, q: search.trim() })}
            >
              {loadingMore ? t('privateNotesLoadingMore') : t('privateNotesLoadMore')}
            </button>
          </div>
        )}

        {displayItems.length === 0 ? (
          <div class="flex min-h-[45vh] items-center justify-center text-center">
            <p class="text-sm text-zinc-500 dark:text-zinc-400">
              {search.trim() ? t('privateNotesEmptySearch') : t('privateNotesEmpty')}
            </p>
          </div>
        ) : (
          <ol class="space-y-3">
            {displayItems.map((item) => {
              const isEditing = editingId === item.id;
              return (
                <li key={item.id} class="flex justify-end">
                  <article class="max-w-[86%] rounded-2xl rounded-br-md bg-sky-600 px-4 py-3 text-white shadow-sm dark:bg-sky-500">
                    {isEditing ? (
                      <div class="space-y-2">
                        <textarea
                          class="hailuo-focus min-h-[6rem] w-full resize-y rounded-xl border border-sky-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-400"
                          value={editingText}
                          maxLength={CONTENT_MAX_CHARS}
                          onInput={(event) => setEditingText((event.target as HTMLTextAreaElement).value)}
                        />
                        <div class="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            class="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/90 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={t('privateNotesSaveAria')}
                            disabled={saving || !canSavePrivateNoteEdit(editingText.trim(), item.attachments.length)}
                            onClick={() => void handleUpdate(item.id)}
                          >
                            {saving ? <Loader2 size={17} class="animate-spin" aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
                          </button>
                          <button
                            type="button"
                            class="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/90 hover:bg-white/15"
                            aria-label={t('privateNotesCancelEditAria')}
                            onClick={() => {
                              setEditingId(null);
                              setEditingText('');
                            }}
                          >
                            <X size={17} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p class="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{item.content}</p>
                        {item.attachments.map((attachment) => (
                          <AttachmentPreview key={attachment.id} attachment={attachment} />
                        ))}
                        <footer class="mt-2 flex items-center justify-between gap-3 text-xs text-white/75">
                          <span>{renderTime(item)}</span>
                          <span class="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              class="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/15"
                              aria-label={t('privateNotesEditAria')}
                              onClick={() => {
                                setEditingId(item.id);
                                setEditingText(item.content);
                              }}
                            >
                              <Edit3 size={15} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              class="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label={t('privateNotesDeleteAria')}
                              disabled={deletingId === item.id}
                              onClick={() => requestDelete(item.id)}
                            >
                              {deletingId === item.id ? <Loader2 size={15} class="animate-spin" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                            </button>
                          </span>
                        </footer>
                      </>
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <form
        class="border-t border-zinc-200/80 bg-white px-4 py-3 dark:border-zinc-800/80 dark:bg-black"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        {pendingAttachments.length > 0 && (
          <div class="mb-3 flex flex-wrap gap-2">
            {pendingAttachments.map((attachment) => (
              <span
                key={attachment.id}
                class="inline-flex max-w-full items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
              >
                <Paperclip size={13} aria-hidden="true" />
                <span class="max-w-[12rem] truncate">{attachmentLabel(attachment)}</span>
                <button
                  type="button"
                  class="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-zinc-200 dark:hover:bg-zinc-800"
                  aria-label={t('privateNotesRemoveAttachmentAria')}
                  onClick={() => void handleRemovePendingAttachment(attachment.id)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div class="flex items-end gap-2">
          <label class="sr-only" for="private-note-composer">{t('privateNotesComposerLabel')}</label>
          <input
            ref={fileInputRef}
            type="file"
            class="hidden"
            multiple
            aria-label={t('privateNotesSelectAttachmentAria')}
            onChange={(event) => void handleAttachFiles((event.target as HTMLInputElement).files)}
          />
          <button
            type="button"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-zinc-200 text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
            aria-label={t('privateNotesAddAttachmentAria')}
            disabled={saving || pendingAttachments.length >= 10}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={18} aria-hidden="true" />
          </button>
          <textarea
            id="private-note-composer"
            class="hailuo-focus-field max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm leading-5 outline-none transition placeholder:text-zinc-400 focus:bg-white dark:border-zinc-800 dark:bg-zinc-950"
            placeholder={t('privateNotesComposerPlaceholder')}
            value={draft}
            maxLength={CONTENT_MAX_CHARS}
            onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                void handleCreate();
              }
            }}
          />
          <button
            type="submit"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:bg-sky-500 dark:hover:bg-sky-400 dark:disabled:bg-zinc-800"
            aria-label={t('privateNotesSendAria')}
            disabled={saving || (draft.trim().length === 0 && pendingAttachments.length === 0)}
          >
            {saving ? <Loader2 size={18} class="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={deleteTargetId !== null}
        pending={deletingId !== null}
        title={t('privateNotesDeleteDialogTitle')}
        body={<p>{t('privateNotesDeleteConfirm')}</p>}
        cancelLabel={t('privateNotesDeleteDialogCancel')}
        confirmLabel={t('privateNotesDeleteDialogConfirm')}
        confirmPendingLabel={t('privateNotesDeleteDialogPending')}
        icon={<Trash2 size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (deletingId === null) setDeleteTargetId(null);
        }}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={encryptConfirmOpen}
        pending={encryptEnabling}
        title={t('privateNotesEnableEncryptDialogTitle')}
        body={
          <>
            <p>{t('privateNotesEnableEncryptConfirm')}</p>
            {encryptDialogError && (
              <p class="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200" role="alert">
                {encryptDialogError}
              </p>
            )}
          </>
        }
        cancelLabel={t('privateNotesEnableEncryptDialogCancel')}
        confirmLabel={t('privateNotesEnableEncryptDialogConfirm')}
        confirmPendingLabel={t('privateNotesEnableEncryptDialogPending')}
        icon={<Lock size={20} strokeWidth={2} aria-hidden="true" />}
        onCancel={() => {
          if (!encryptEnabling) {
            setEncryptConfirmOpen(false);
            setEncryptDialogError(null);
          }
        }}
        onConfirm={() => void confirmEnableEncryption()}
      />
    </section>
  );
}

const CONTENT_MAX_CHARS = 10_000;
