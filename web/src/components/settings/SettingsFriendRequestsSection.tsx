/** @jsxImportSource preact */
/**
 * M17-2：设置 — 好友开关 + 待处理请求 + 批量导入
 */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { getOwnerJwt, getWorkerAUrl } from '../../lib/auth';
import { createWorkerAClient } from '../../lib/workerA';
import { ApiError } from '../../lib/errors';
import { parseFriendImportBatch, FRIEND_IMPORT_MAX } from '../../lib/hailuoUri';
import { t } from '../../lib/i18n';
import { showToast } from '../../lib/toast';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_SECTION_DESC_CLASS,
  SETTINGS_INPUT_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
  SETTINGS_OPTION_ROW_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';

function makeClient() {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) return null;
  return createWorkerAClient({ baseUrl, getJwt: getOwnerJwt });
}

export function SettingsFriendRequestsSection(): VNode {
  const [allowIncoming, setAllowIncoming] = useState(true);
  const [loadingSetting, setLoadingSetting] = useState(true);
  const [savingSetting, setSavingSetting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [settingError, setSettingError] = useState<string | null>(null);

  useEffect(() => {
    const client = makeClient();
    if (!client) {
      setLoadingSetting(false);
      return;
    }
    void client
      .getFriendRequestsSetting()
      .then((data) => {
        setAllowIncoming(data.allow_incoming);
      })
      .catch((err) => {
        setSettingError(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'));
      })
      .finally(() => setLoadingSetting(false));
  }, []);

  async function toggleAllow(next: boolean): Promise<void> {
    const client = makeClient();
    if (!client) {
      showToast(t('ownerConfigureWriteLayer'), 'error');
      return;
    }
    setSavingSetting(true);
    setSettingError(null);
    try {
      const data = await client.setFriendRequestsSetting(next);
      setAllowIncoming(data.allow_incoming);
    } catch (err) {
      setSettingError(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'));
    } finally {
      setSavingSetting(false);
    }
  }

  async function runImport(): Promise<void> {
    const client = makeClient();
    if (!client) {
      showToast(t('ownerConfigureWriteLayer'), 'error');
      return;
    }
    const parsed = parseFriendImportBatch(importText);
    if (parsed.truncated) {
      showToast(t('friendImportTruncated'), 'info');
    }
    if (parsed.errors.length > 0 && parsed.items.length === 0) {
      showToast(t('friendImportFailed'), 'error');
      return;
    }
    if (parsed.items.length === 0) {
      showToast(t('friendImportFailed'), 'error');
      return;
    }

    setImporting(true);
    let ok = 0;
    let fail = 0;
    // 顺序发送，禁止并发（频控 + 跨节点语义）
    for (const item of parsed.items.slice(0, FRIEND_IMPORT_MAX)) {
      try {
        await client.sendFriendRequest({
          target_node_url: item.node_url,
          target_handle: item.handle,
        });
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setImporting(false);
    showToast(t('friendImportSuccess', undefined, { ok, fail }), fail > 0 ? 'error' : 'info');
    if (ok > 0) setImportText('');
  }

  return (
    <section class={SETTINGS_SECTION_CLASS} data-testid="settings-friend-requests">
      <SettingsSectionHeader sectionKey="friendRequests" title={t('settingsFriendRequestsTitle')} />
      <p class={SETTINGS_SECTION_DESC_CLASS}>{t('friendAllowIncoming')}</p>

      {settingError && (
        <p class="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
          {settingError}
        </p>
      )}

      <label class={SETTINGS_OPTION_ROW_CLASS + ' mt-3 text-sm'}>
        <input
          type="checkbox"
          checked={allowIncoming}
          disabled={loadingSetting || savingSetting}
          onChange={(e) => void toggleAllow((e.currentTarget as HTMLInputElement).checked)}
          class="mt-0.5"
          data-testid="friend-allow-incoming"
        />
        <span class="text-slate-700 dark:text-zinc-200">{t('friendAllowIncoming')}</span>
      </label>

      {/* M17-17：请求列表迁到消息 → 通讯录；设置只留策略开关 + 批量导入 */}
      <p class="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        <a
          href="/messages?tab=contacts"
          class="font-medium text-sky-600 hover:underline dark:text-sky-400"
          data-testid="settings-friends-moved-hint"
        >
          {t('settingsFriendsMovedHint')}
        </a>
      </p>

      <div class="mt-6 space-y-2">
        <h3 class="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{t('friendImportBatch')}</h3>
        <p class="text-xs text-zinc-500 dark:text-zinc-400">{t('friendImportHint')}</p>
        <textarea
          class={SETTINGS_INPUT_CLASS + ' min-h-[7rem] font-mono text-xs'}
          value={importText}
          onInput={(e) => setImportText((e.currentTarget as HTMLTextAreaElement).value)}
          placeholder={'alice@https://alice.example.com\nbob@https://bob.example.com'}
          disabled={importing}
          data-testid="friend-import-textarea"
          aria-label={t('friendImportBatch')}
        />
        <button
          type="button"
          class={SETTINGS_PRIMARY_BTN_CLASS}
          disabled={importing || !importText.trim()}
          onClick={() => void runImport()}
          data-testid="friend-import-submit"
        >
          {importing ? t('registryCertifySubmitting') : t('friendImportBatch')}
        </button>
      </div>
    </section>
  );
}
