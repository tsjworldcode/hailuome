/** @jsxImportSource preact */
/**
 * M9-7 / S1–S5：节点搬家 UI。
 * 加密导出、staging 导入、对账展示、切流脚本指引（Web 绝不自动切 binding）。
 */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { ClipboardCopy, Download, RefreshCw, Upload } from 'lucide-preact';
import {
  decryptNodeExportJson,
  encryptNodeExportJson,
  isNodeExportEncryptedFile,
  NodeExportCryptoError,
  parseNodeExportEncryptedFile,
} from '@hailuo/shared-crypto';
import { getOwnerJwt, getWorkerAUrl } from '../lib/auth';
import { ApiError, getErrorMessage } from '../lib/errors';
import {
  createWorkerAClient,
  type NodeImportReconcileReport,
} from '../lib/workerA';
import { t } from '../lib/i18n';
import { SETTINGS_SECTION_CLASS } from '../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './settings/SettingsSectionHeader';

/** 与 scripts/cutover-db-import.ps1 一致；仅展示，不由浏览器执行 */
const CUTOVER_SCRIPT_CMD =
  'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cutover-db-import.ps1';

const exporting = signal(false);
const importing = signal(false);
const confirmingImport = signal(false);
const pendingBundle = signal<unknown | null>(null);
/** 待确认导入是否来自明文 v1（非正规路径） */
const pendingPlaintextV1 = signal(false);
const exportPass = signal('');
const exportPassConfirm = signal('');
const importPass = signal('');
const panelStatus = signal<{ readonly type: 'idle' | 'success' | 'error'; readonly msg: string }>({
  type: 'idle',
  msg: '',
});
/** M9-7-S5：staging 对账快照 */
const importReady = signal<boolean | null>(null);
const reconcileReport = signal<NodeImportReconcileReport | null>(null);
const statusLoading = signal(false);
const cutoverCopied = signal(false);

function setPanelStatus(type: 'idle' | 'success' | 'error', msg: string): void {
  panelStatus.value = { type, msg };
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
  if (!baseUrl) throw new Error(t('composerMissingEndpoint'));
  return createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
}

function looksLikePlainNodeExportV1(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const meta = (raw as Record<string, unknown>).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return (meta as Record<string, unknown>).schema_version === 'hailuo-node-export-v1';
}

function applyReconcileSnapshot(
  ready: boolean | null,
  report: NodeImportReconcileReport | null | undefined,
): void {
  importReady.value = ready;
  reconcileReport.value = report ?? null;
}

function summarizeReconcile(report: NodeImportReconcileReport): string {
  const countOk = Object.values(report.table_counts).filter((c) => c.ok).length;
  const countTotal = Object.keys(report.table_counts).length;
  const hashOk = Object.values(report.sample_hashes).filter((h) => h.ok).length;
  const hashTotal = Object.keys(report.sample_hashes).length;
  if (report.ok) {
    return t('nodeMigrateReconcileOkSummary', undefined, {
      counts: String(countOk),
      hashes: String(hashOk),
    });
  }
  const mismatches = report.mismatches.slice(0, 3).join('; ') || '—';
  return t('nodeMigrateReconcileFailSummary', undefined, {
    counts: `${countOk}/${countTotal}`,
    hashes: `${hashOk}/${hashTotal}`,
    mismatches,
  });
}

async function refreshImportStatus(silent = false): Promise<void> {
  if (statusLoading.value) return;
  statusLoading.value = true;
  if (!silent) setPanelStatus('idle', '');
  try {
    const client = createClient();
    const status = await client.getNodeImportStatus();
    applyReconcileSnapshot(status.import_ready, status.reconcile);
    if (!silent) {
      setPanelStatus(
        'success',
        status.import_ready
          ? t('nodeMigrateStatusReady')
          : t('nodeMigrateStatusNotReady'),
      );
    }
  } catch (err) {
    if (err instanceof ApiError && err.body?.error_code === 'NODE_IMPORT_STAGING_MISSING') {
      applyReconcileSnapshot(null, null);
      if (!silent) setPanelStatus('error', t('nodeMigrateImportStagingMissing'));
    } else if (!silent) {
      const msg = err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, err instanceof Error ? err.message : t('nodeMigrateStatusFailed'));
      setPanelStatus('error', msg);
    }
  } finally {
    statusLoading.value = false;
  }
}

async function handleExport(): Promise<void> {
  if (exporting.value) return;
  const pass = exportPass.value;
  const confirm = exportPassConfirm.value;
  if (pass !== confirm) {
    setPanelStatus('error', t('nodeMigratePassMismatch'));
    return;
  }
  exporting.value = true;
  setPanelStatus('idle', '');
  try {
    const client = createClient();
    const buffer = await client.exportNodeBundle();
    const plaintextJson = new TextDecoder().decode(buffer);
    const encrypted = await encryptNodeExportJson(plaintextJson, pass);
    const json = JSON.stringify(encrypted, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `hailuo-node-export-v2-enc-${formatTimestampForFilename(new Date())}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setPanelStatus('success', t('nodeMigrateExportSuccess'));
  } catch (err) {
    if (err instanceof NodeExportCryptoError) {
      setPanelStatus('error', err.message);
    } else {
      const msg = err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, err instanceof Error ? err.message : t('nodeMigrateExportFailed'));
      setPanelStatus('error', msg);
    }
  } finally {
    exporting.value = false;
  }
}

async function handleImportFile(file: File): Promise<void> {
  if (importing.value) return;
  importing.value = true;
  setPanelStatus('idle', '');
  try {
    const text = await file.text();
    const raw = JSON.parse(text) as unknown;

    if (isNodeExportEncryptedFile(raw)) {
      const pass = importPass.value;
      if (!pass) {
        setPanelStatus('error', t('nodeMigratePassRequired'));
        return;
      }
      const plaintextJson = await decryptNodeExportJson(parseNodeExportEncryptedFile(raw), pass);
      const bundle = JSON.parse(plaintextJson) as unknown;
      if (!looksLikePlainNodeExportV1(bundle)) {
        setPanelStatus('error', t('nodeMigrateImportInvalid'));
        return;
      }
      pendingBundle.value = bundle;
      pendingPlaintextV1.value = false;
      confirmingImport.value = true;
      return;
    }

    if (looksLikePlainNodeExportV1(raw)) {
      // S1 定稿：明文 v1 仅作紧急/本地逃生；正规路径须 v2-enc
      pendingBundle.value = raw;
      pendingPlaintextV1.value = true;
      confirmingImport.value = true;
      return;
    }

    setPanelStatus('error', t('nodeMigrateImportInvalid'));
  } catch (err) {
    if (err instanceof NodeExportCryptoError) {
      setPanelStatus('error', err.code === 'NODE_EXPORT_DEC_FAILED'
        ? t('nodeMigrateDecryptFailed')
        : err.message);
    } else {
      setPanelStatus('error', t('nodeMigrateImportInvalid'));
    }
  } finally {
    importing.value = false;
  }
}

async function handleImportConfirm(): Promise<void> {
  const bundle = pendingBundle.value;
  if (!bundle || importing.value) return;
  importing.value = true;
  setPanelStatus('idle', '');
  try {
    const client = createClient();
    // M9-7-S2：默认正规路径（staging / DB_IMPORT）；不传 unsafe_inplace_import
    const result = await client.importNodeBundle(bundle, true, false);
    const tableCount = Object.keys(result.imported_tables).length;
    const skipped = result.skipped_tables?.length ?? 0;
    applyReconcileSnapshot(result.import_ready === true, result.reconcile);
    const reconcileHint = result.reconcile
      ? summarizeReconcile(result.reconcile)
      : '';
    setPanelStatus(
      'success',
      t('nodeMigrateImportSuccess', undefined, {
        tables: String(tableCount),
        skipped: String(skipped),
        steps: reconcileHint || result.operator_steps.slice(0, 1).join(' '),
      }),
    );
    pendingBundle.value = null;
    pendingPlaintextV1.value = false;
    confirmingImport.value = false;
  } catch (err) {
    if (err instanceof ApiError && err.body?.error_code === 'NODE_IMPORT_UNSAFE_REQUIRED') {
      setPanelStatus('error', t('nodeMigrateImportUnsafeRequired'));
    } else if (err instanceof ApiError && err.body?.error_code === 'NODE_IMPORT_CONFIRM_REQUIRED') {
      setPanelStatus('error', t('nodeMigrateImportConfirmRequired'));
    } else if (err instanceof ApiError && err.body?.error_code === 'NODE_IMPORT_STAGING_MISSING') {
      setPanelStatus('error', t('nodeMigrateImportStagingMissing'));
    } else if (err instanceof ApiError && err.body?.error_code === 'NODE_IMPORT_RECONCILE_FAILED') {
      // 对账失败时 staging 已写入 import_ready=false；刷新状态以展示明细
      setPanelStatus('error', err.displayMessage);
      await refreshImportStatus(true);
    } else {
      const msg = err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, err instanceof Error ? err.message : t('nodeMigrateImportFailed'));
      setPanelStatus('error', msg);
    }
  } finally {
    importing.value = false;
  }
}

function handleImportCancel(): void {
  pendingBundle.value = null;
  pendingPlaintextV1.value = false;
  confirmingImport.value = false;
}

async function handleCopyCutoverCmd(): Promise<void> {
  try {
    await navigator.clipboard.writeText(CUTOVER_SCRIPT_CMD);
    cutoverCopied.value = true;
    window.setTimeout(() => {
      cutoverCopied.value = false;
    }, 2000);
  } catch {
    setPanelStatus('error', t('nodeMigrateCutoverCopyFailed'));
  }
}

function ReconcilePanel(): VNode | null {
  const report = reconcileReport.value;
  const ready = importReady.value;
  if (ready === null && !report) return null;

  const countEntries = report ? Object.entries(report.table_counts) : [];
  const hashEntries = report ? Object.entries(report.sample_hashes) : [];

  return (
    <div
      class={
        'mt-4 rounded-md border px-3 py-3 text-sm ' +
        (ready
          ? 'border-emerald-300 bg-emerald-50/80 dark:border-emerald-800 dark:bg-emerald-950/40'
          : 'border-slate-300 bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900/60')
      }
      aria-labelledby="node-migrate-reconcile-heading"
    >
      <h3 id="node-migrate-reconcile-heading" class="text-sm font-semibold text-slate-900 dark:text-zinc-100">
        {t('nodeMigrateReconcileTitle')}
      </h3>
      <p class="mt-1 text-xs text-slate-600 dark:text-zinc-400">
        {ready === true
          ? t('nodeMigrateStatusReady')
          : ready === false
            ? t('nodeMigrateStatusNotReady')
            : t('nodeMigrateStatusUnknown')}
      </p>
      {report ? (
        <>
          <p class="mt-2 text-xs text-slate-700 dark:text-zinc-300">{summarizeReconcile(report)}</p>
          {countEntries.length > 0 ? (
            <ul class="mt-2 max-h-32 overflow-y-auto space-y-0.5 text-xs font-mono text-slate-600 dark:text-zinc-400">
              {countEntries.map(([table, c]) => (
                <li key={table}>
                  {c.ok ? '✓' : '✗'} {table}: {c.actual}/{c.expected}
                </li>
              ))}
            </ul>
          ) : null}
          {hashEntries.length > 0 ? (
            <ul class="mt-2 space-y-0.5 text-xs font-mono text-slate-600 dark:text-zinc-400">
              {hashEntries.map(([table, h]) => (
                <li key={table}>
                  {h.ok ? '✓' : '✗'} hash:{table} ({h.sample_rows})
                </li>
              ))}
            </ul>
          ) : null}
          {report.reconciled_at ? (
            <p class="mt-2 text-[11px] text-slate-500 dark:text-zinc-500">
              {t('nodeMigrateReconciledAt', undefined, { at: report.reconciled_at })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function CutoverGuide(): VNode {
  return (
    <div
      class="mt-4 rounded-md border border-sky-200 bg-sky-50/70 px-3 py-3 dark:border-sky-900 dark:bg-sky-950/30"
      aria-labelledby="node-migrate-cutover-heading"
    >
      <h3 id="node-migrate-cutover-heading" class="text-sm font-semibold text-slate-900 dark:text-zinc-100">
        {t('nodeMigrateCutoverTitle')}
      </h3>
      <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
        {t('nodeMigrateCutoverDesc')}
      </p>
      <ol class="mt-2 list-decimal space-y-1 pl-4 text-xs text-slate-700 dark:text-zinc-300">
        <li>{t('nodeMigrateCutoverStep1')}</li>
        <li>{t('nodeMigrateCutoverStep2')}</li>
        <li>{t('nodeMigrateCutoverStep3')}</li>
      </ol>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <code class="block max-w-full flex-1 break-all rounded border border-sky-200 bg-white px-2 py-1.5 text-[11px] text-slate-800 dark:border-sky-900 dark:bg-zinc-950 dark:text-zinc-200">
          {CUTOVER_SCRIPT_CMD}
        </code>
        <button
          type="button"
          onClick={() => void handleCopyCutoverCmd()}
          class="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-white px-2 py-1.5 text-xs font-medium text-sky-900 transition hover:bg-sky-100 dark:border-sky-800 dark:bg-zinc-900 dark:text-sky-100 dark:hover:bg-zinc-800"
        >
          <ClipboardCopy size={14} strokeWidth={1.75} aria-hidden="true" />
          {cutoverCopied.value ? t('nodeMigrateCutoverCopied') : t('nodeMigrateCutoverCopy')}
        </button>
      </div>
      <p class="mt-2 text-[11px] text-slate-500 dark:text-zinc-500">{t('nodeMigrateCutoverNoAuto')}</p>
    </div>
  );
}

export function NodeMigratePanel(): VNode {
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshImportStatus(true);
  }, []);

  return (
    <section class={SETTINGS_SECTION_CLASS}>
      <SettingsSectionHeader sectionKey="nodeMigrate" title={t('nodeMigrateTitle')} />
      <p class="mt-1 text-sm text-slate-600 dark:text-zinc-400">
        {t('nodeMigrateDesc')}
      </p>

      {panelStatus.value.type !== 'idle' && (
        <div
          class={
            'mt-3 rounded-md border px-3 py-2 text-sm ' +
            (panelStatus.value.type === 'success'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100'
              : 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100')
          }
          role="status"
        >
          {panelStatus.value.msg}
        </div>
      )}

      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <label class="block text-xs text-slate-600 dark:text-zinc-400">
          {t('nodeMigratePassLabel')}
          <input
            type="password"
            autocomplete="new-password"
            value={exportPass.value}
            onInput={(e) => {
              exportPass.value = (e.currentTarget as HTMLInputElement).value;
            }}
            disabled={exporting.value || importing.value || confirmingImport.value}
            class="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </label>
        <label class="block text-xs text-slate-600 dark:text-zinc-400">
          {t('nodeMigratePassConfirmLabel')}
          <input
            type="password"
            autocomplete="new-password"
            value={exportPassConfirm.value}
            onInput={(e) => {
              exportPassConfirm.value = (e.currentTarget as HTMLInputElement).value;
            }}
            disabled={exporting.value || importing.value || confirmingImport.value}
            class="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </label>
      </div>

      <div class="mt-3">
        <label class="block text-xs text-slate-600 dark:text-zinc-400">
          {t('nodeMigrateImportPassLabel')}
          <input
            type="password"
            autocomplete="off"
            value={importPass.value}
            onInput={(e) => {
              importPass.value = (e.currentTarget as HTMLInputElement).value;
            }}
            disabled={exporting.value || importing.value || confirmingImport.value}
            class="mt-1 w-full max-w-md rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </label>
        <p class="mt-1 text-xs text-slate-500 dark:text-zinc-500">{t('nodeMigratePassHint')}</p>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exporting.value || importing.value || confirmingImport.value}
          class="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          <Download size={14} strokeWidth={1.75} aria-hidden="true" />
          {exporting.value ? t('nodeMigrateExporting') : t('nodeMigrateExport')}
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={exporting.value || importing.value || confirmingImport.value}
          class="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
          {importing.value ? t('nodeMigrateImporting') : t('nodeMigrateImport')}
        </button>

        <button
          type="button"
          onClick={() => void refreshImportStatus(false)}
          disabled={statusLoading.value || exporting.value || importing.value}
          class="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          {statusLoading.value ? t('nodeMigrateStatusRefreshing') : t('nodeMigrateStatusRefresh')}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          class="hidden"
          onChange={(e) => {
            const file = (e.currentTarget as HTMLInputElement).files?.[0];
            if (file) void handleImportFile(file);
            (e.currentTarget as HTMLInputElement).value = '';
          }}
        />

        {confirmingImport.value ? (
          <div
            class="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 dark:border-amber-700 dark:bg-amber-950"
            role="group"
            aria-label={t('nodeMigrateImportConfirmAria')}
          >
            <span class="text-xs text-amber-900 dark:text-amber-100">
              {pendingPlaintextV1.value
                ? t('nodeMigrateImportPlaintextWarn')
                : t('nodeMigrateImportConfirmPrompt')}
            </span>
            <button
              type="button"
              onClick={() => void handleImportConfirm()}
              disabled={importing.value}
              class="rounded-md bg-amber-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-400"
            >
              {importing.value ? t('nodeMigrateImporting') : t('nodeMigrateImportConfirm')}
            </button>
            <button
              type="button"
              onClick={handleImportCancel}
              disabled={importing.value}
              class="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-700 dark:bg-zinc-900 dark:text-amber-200 dark:hover:bg-zinc-800"
            >
              {t('nodeMigrateCancel')}
            </button>
          </div>
        ) : null}
      </div>

      <ReconcilePanel />
      <CutoverGuide />

      <p class="mt-3 text-xs text-slate-500 dark:text-zinc-500">
        {t('nodeMigrateFootnote')}
      </p>
    </section>
  );
}
