/** @jsxImportSource preact */
/**
 * M10-5b：私信加密全量备份 UI（挂载于 LocalDataPanel 内，独立模块以隔离 Worker A client）。
 */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import { Lock, Upload, Download } from 'lucide-preact';
import { getOwnerJwt, getWorkerAUrl } from '../lib/auth';
import { fetchPasswordKdfParams } from '../lib/ownerPassword';
import {
  buildDmBackup,
  decryptDmBackupFromJson,
  encryptDmBackup,
  importDmBackup,
  validateBackupPassphrase,
  type DmBackupPlaintext,
  DmBackupError,
} from '../lib/dmBackup';
import { isDmLegacyIdentityPending } from '../lib/dmSession';
import { createWorkerAClient } from '../lib/workerA';
import { t } from '../lib/i18n';

const dmExportOpen = signal(false);
const dmImportOpen = signal(false);
const dmExportPass = signal('');
const dmExportPassConfirm = signal('');
const dmImportPass = signal('');
const dmExporting = signal(false);
const dmImporting = signal(false);
const pendingDmImport = signal<DmBackupPlaintext | null>(null);
const dmPanelStatus = signal<{ readonly type: 'idle' | 'success' | 'error'; readonly msg: string }>({
  type: 'idle',
  msg: '',
});

function setDmStatus(type: 'idle' | 'success' | 'error', msg: string): void {
  dmPanelStatus.value = { type, msg };
}

function resetExportDialog(): void {
  dmExportOpen.value = false;
  dmExportPass.value = '';
  dmExportPassConfirm.value = '';
}

function resetImportDialog(): void {
  dmImportOpen.value = false;
  dmImportPass.value = '';
}

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

function createClient() {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) throw new DmBackupError('ENDPOINT_MISSING', t('composerMissingEndpoint'));
  return createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
}

async function handleDmExportConfirm(): Promise<void> {
  if (dmExporting.value) return;
  const pass = dmExportPass.value;
  const confirm = dmExportPassConfirm.value;
  if (pass !== confirm) {
    setDmStatus('error', t('dmBackupPassMismatch'));
    return;
  }
  const strength = validateBackupPassphrase(pass);
  if (!strength.ok) {
    setDmStatus('error', strength.reason);
    return;
  }
  dmExporting.value = true;
  setDmStatus('idle', '');
  try {
    const client = createClient();
    const jwt = getOwnerJwt();
    if (!jwt) throw new DmBackupError('SESSION_MISSING', t('dmBackupSessionMissing'));
    const [snapshot, kdfParams] = await Promise.all([
      buildDmBackup(client, {
        exportOrigin: typeof window !== 'undefined' ? window.location.origin : '',
        identityLegacy: isDmLegacyIdentityPending(),
      }),
      fetchPasswordKdfParams(getWorkerAUrl()!, jwt),
    ]);
    const encrypted = await encryptDmBackup(snapshot, pass, kdfParams.iterations);
    const json = JSON.stringify(encrypted, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hailuo-dm-backup-${formatTimestampForFilename(new Date())}.hailuo-dm-backup.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
    resetExportDialog();
    const c = snapshot.meta.counts;
    setDmStatus(
      'success',
      t('dmBackupExportSuccess', undefined, {
        inbox: c.messages_inbox,
        outbox: c.messages_outbox,
        keys: c.wrapped_keys,
      }),
    );
  } catch (err) {
    const msg =
      err instanceof DmBackupError
        ? err.message
        : err instanceof Error
          ? err.message
          : t('dmBackupExportFailed');
    setDmStatus('error', msg);
  } finally {
    dmExporting.value = false;
  }
}

async function handleDmImportFile(file: File): Promise<void> {
  if (dmImporting.value) return;
  const pass = dmImportPass.value;
  if (!pass) {
    setDmStatus('error', t('dmBackupPassRequired'));
    return;
  }
  dmImporting.value = true;
  setDmStatus('idle', '');
  try {
    const json = await file.text();
    const snapshot = await decryptDmBackupFromJson(json, pass);
    pendingDmImport.value = snapshot;
    resetImportDialog();
  } catch (err) {
    pendingDmImport.value = null;
    const msg =
      err instanceof DmBackupError
        ? err.message
        : err instanceof Error
          ? err.message
          : t('dmBackupDecryptFailed');
    setDmStatus('error', msg);
  } finally {
    dmImporting.value = false;
  }
}

async function handleDmImportConfirm(): Promise<void> {
  const snapshot = pendingDmImport.value;
  if (!snapshot || dmImporting.value) return;
  dmImporting.value = true;
  try {
    const client = createClient();
    const result = await importDmBackup(client, snapshot);
    pendingDmImport.value = null;
    setDmStatus(
      'success',
      t('dmBackupImportSuccess', undefined, {
        inserted: result.messages_inserted,
        skipped: result.messages_skipped,
        keys: result.wrapped_keys_upserted,
        identity: result.wrapped_identity_imported ? t('dmBackupImportIdentityYes') : t('dmBackupImportIdentityNo'),
      }),
    );
  } catch (err) {
    const msg =
      err instanceof DmBackupError
        ? err.message
        : err instanceof Error
          ? err.message
          : t('dmBackupImportFailed');
    setDmStatus('error', msg);
  } finally {
    dmImporting.value = false;
  }
}

function handleDmImportCancel(): void {
  pendingDmImport.value = null;
}

export function DmBackupPanel(): VNode {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const status = dmPanelStatus.value;

  return (
    <div class="mt-4 rounded-md border border-sky-200 bg-sky-50/80 p-3 dark:border-sky-900 dark:bg-sky-950/40">
      <div class="flex items-center gap-1.5 text-sm font-medium text-sky-900 dark:text-sky-100">
        <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
        {t('dmBackupSectionTitle')}
      </div>
      <p class="mt-1 text-xs leading-5 text-sky-900/90 dark:text-sky-100/90">{t('dmBackupSectionDescription')}</p>
      <p class="mt-1 text-xs leading-5 text-sky-800/80 dark:text-sky-200/80">{t('dmBackupPlaintextHint')}</p>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        class="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const target = e.currentTarget;
          const file = target.files?.[0];
          if (file) void handleDmImportFile(file);
          target.value = '';
        }}
      />

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setDmStatus('idle', '');
            dmExportOpen.value = true;
          }}
          disabled={dmExporting.value || dmImporting.value || pendingDmImport.value !== null}
          class="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-white px-3 py-1.5 text-sm font-medium text-sky-900 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-800 dark:bg-zinc-900 dark:text-sky-100 dark:hover:bg-zinc-800"
        >
          <Download size={14} strokeWidth={1.75} aria-hidden="true" />
          {dmExporting.value ? t('dmBackupExporting') : t('dmBackupExportButton')}
        </button>
        <button
          type="button"
          onClick={() => {
            setDmStatus('idle', '');
            dmImportOpen.value = true;
          }}
          disabled={dmImporting.value || dmExporting.value || pendingDmImport.value !== null}
          class="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-white px-3 py-1.5 text-sm font-medium text-sky-900 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-800 dark:bg-zinc-900 dark:text-sky-100 dark:hover:bg-zinc-800"
        >
          <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
          {dmImporting.value ? t('dmBackupImporting') : t('dmBackupImportButton')}
        </button>
      </div>

      {dmExportOpen.value ? (
        <div
          class="mt-3 rounded-md border border-sky-300 bg-white px-3 py-3 dark:border-sky-800 dark:bg-zinc-900"
          role="group"
          aria-labelledby="dm-export-title"
        >
          <div id="dm-export-title" class="text-sm font-medium text-slate-900 dark:text-zinc-50">
            {t('dmBackupExportDialogTitle')}
          </div>
          <p class="mt-1 text-xs text-slate-600 dark:text-zinc-400">{t('dmBackupExportDialogHint')}</p>
          <label class="mt-2 block text-xs font-medium text-slate-700 dark:text-zinc-300">
            {t('dmBackupPassLabel')}
            <input
              type="password"
              autoComplete="new-password"
              value={dmExportPass.value}
              onInput={(e) => {
                dmExportPass.value = (e.currentTarget as HTMLInputElement).value;
              }}
              class="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label class="mt-2 block text-xs font-medium text-slate-700 dark:text-zinc-300">
            {t('dmBackupPassConfirmLabel')}
            <input
              type="password"
              autoComplete="new-password"
              value={dmExportPassConfirm.value}
              onInput={(e) => {
                dmExportPassConfirm.value = (e.currentTarget as HTMLInputElement).value;
              }}
              class="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={dmExporting.value}
              onClick={() => void handleDmExportConfirm()}
              class="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {dmExporting.value ? t('dmBackupExporting') : t('dmBackupExportConfirm')}
            </button>
            <button
              type="button"
              disabled={dmExporting.value}
              onClick={resetExportDialog}
              class="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-zinc-700"
            >
              {t('localDataCancel')}
            </button>
          </div>
        </div>
      ) : null}

      {dmImportOpen.value ? (
        <div
          class="mt-3 rounded-md border border-sky-300 bg-white px-3 py-3 dark:border-sky-800 dark:bg-zinc-900"
          role="group"
          aria-labelledby="dm-import-title"
        >
          <div id="dm-import-title" class="text-sm font-medium text-slate-900 dark:text-zinc-50">
            {t('dmBackupImportDialogTitle')}
          </div>
          <p class="mt-1 text-xs text-slate-600 dark:text-zinc-400">{t('dmBackupImportDialogHint')}</p>
          <label class="mt-2 block text-xs font-medium text-slate-700 dark:text-zinc-300">
            {t('dmBackupPassLabel')}
            <input
              type="password"
              autoComplete="current-password"
              value={dmImportPass.value}
              onInput={(e) => {
                dmImportPass.value = (e.currentTarget as HTMLInputElement).value;
              }}
              class="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={dmImporting.value}
              onClick={() => fileInputRef.current?.click()}
              class="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('dmBackupChooseFile')}
            </button>
            <button
              type="button"
              disabled={dmImporting.value}
              onClick={resetImportDialog}
              class="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-zinc-700"
            >
              {t('localDataCancel')}
            </button>
          </div>
        </div>
      ) : null}

      {pendingDmImport.value ? (
        <div
          class="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 dark:border-amber-700 dark:bg-amber-950"
          role="group"
          aria-labelledby="dm-import-confirm-title"
        >
          <div id="dm-import-confirm-title" class="text-sm font-medium text-amber-900 dark:text-amber-100">
            {t('dmBackupImportConfirmTitle')}
          </div>
          <ul class="mt-2 list-disc pl-5 text-xs leading-5 text-amber-900 dark:text-amber-100">
            <li>
              {t('localDataCountLine', undefined, {
                label: t('dmBackupCountInbox'),
                count: pendingDmImport.value.meta.counts.messages_inbox,
              })}
            </li>
            <li>
              {t('localDataCountLine', undefined, {
                label: t('dmBackupCountOutbox'),
                count: pendingDmImport.value.meta.counts.messages_outbox,
              })}
            </li>
            <li>
              {t('localDataCountLine', undefined, {
                label: t('dmBackupCountKeys'),
                count: pendingDmImport.value.meta.counts.wrapped_keys,
              })}
            </li>
          </ul>
          <div class="mt-2 text-xs text-amber-900 dark:text-amber-100">
            <strong>{t('localDataImportWarningLabel')}</strong>
            {t('dmBackupImportWarningBody')}
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={dmImporting.value}
              onClick={() => void handleDmImportConfirm()}
              class="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {dmImporting.value ? t('dmBackupImporting') : t('dmBackupImportConfirmButton')}
            </button>
            <button
              type="button"
              disabled={dmImporting.value}
              onClick={handleDmImportCancel}
              class="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs dark:border-amber-700 dark:bg-zinc-900"
            >
              {t('localDataCancel')}
            </button>
          </div>
        </div>
      ) : null}

      {status.type !== 'idle' && status.msg ? (
        <div
          class={
            'mt-3 rounded-md border px-3 py-2 text-sm ' +
            (status.type === 'success'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100'
              : 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100')
          }
          role="status"
        >
          {status.msg}
        </div>
      ) : null}
    </div>
  );
}
