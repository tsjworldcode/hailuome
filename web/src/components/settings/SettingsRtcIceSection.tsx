/** @jsxImportSource preact */
/** M-RTC-1b：语音通话 ICE / TURN 配置（仅本机；TURN 运营方可看见双方网络地址） */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n';
import {
  clearRtcIceConfig,
  hasTurnConfigured,
  loadRtcIceConfig,
  saveRtcIceConfig,
  type RtcIceConfig,
} from '../../lib/rtc/iceServers';
import {
  SETTINGS_INPUT_CLASS,
  SETTINGS_OPTION_ROW_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
  SETTINGS_SECONDARY_BTN_CLASS,
  SETTINGS_SECTION_CLASS,
  SETTINGS_SECTION_DESC_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';

function configToForm(c: RtcIceConfig) {
  return {
    stunUrls: c.stun_urls.join('\n'),
    turnUrls: c.turn_urls.join('\n'),
    turnUsername: c.turn_username,
    turnCredential: c.turn_credential,
    relayOnly: c.relay_only,
    stripHost: c.strip_host,
  };
}

export function SettingsRtcIceSection(): VNode {
  const [stunUrls, setStunUrls] = useState('');
  const [turnUrls, setTurnUrls] = useState('');
  const [turnUsername, setTurnUsername] = useState('');
  const [turnCredential, setTurnCredential] = useState('');
  const [relayOnly, setRelayOnly] = useState(false);
  const [stripHost, setStripHost] = useState(true);
  const [status, setStatus] = useState<'idle' | 'ok' | 'err'>('idle');
  const [statusText, setStatusText] = useState('');

  useEffect(() => {
    const c = loadRtcIceConfig();
    const form = configToForm(c);
    setStunUrls(form.stunUrls);
    setTurnUrls(form.turnUrls);
    setTurnUsername(form.turnUsername);
    setTurnCredential(form.turnCredential);
    setRelayOnly(form.relayOnly);
    setStripHost(form.stripHost);
  }, []);

  function handleSave(): void {
    const turnList = turnUrls
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const stunList = stunUrls
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const wantRelay = relayOnly;
    const draft: Omit<RtcIceConfig, 'v'> = {
      stun_urls: stunList,
      turn_urls: turnList,
      turn_username: turnUsername,
      turn_credential: turnCredential,
      relay_only: wantRelay,
      strip_host: stripHost,
    };
    const saved = saveRtcIceConfig(draft);
    if (wantRelay && !hasTurnConfigured(saved)) {
      setStatus('err');
      setStatusText(t('settingsRtcRelayNeedsTurn'));
      setRelayOnly(false);
      return;
    }
    setRelayOnly(saved.relay_only);
    setStatus('ok');
    setStatusText(t('settingsRtcIceSaved'));
  }

  function handleReset(): void {
    clearRtcIceConfig();
    const form = configToForm(loadRtcIceConfig());
    setStunUrls(form.stunUrls);
    setTurnUrls(form.turnUrls);
    setTurnUsername(form.turnUsername);
    setTurnCredential(form.turnCredential);
    setRelayOnly(form.relayOnly);
    setStripHost(form.stripHost);
    setStatus('ok');
    setStatusText(t('settingsRtcIceReset'));
  }

  return (
    <section class={SETTINGS_SECTION_CLASS}>
      <SettingsSectionHeader sectionKey="rtcIce" title={t('settingsRtcIceTitle')} />
      <p class={SETTINGS_SECTION_DESC_CLASS}>{t('settingsRtcIceDesc')}</p>
      <p class="mt-2 text-[13px] leading-5 text-amber-800 dark:text-amber-200/90">
        {t('settingsRtcIcePrivacyNote')}
      </p>

      <label class="mt-4 block text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {t('settingsRtcStunLabel')}
        <textarea
          class={`${SETTINGS_INPUT_CLASS} mt-1 min-h-[4.5rem] font-mono text-sm`}
          value={stunUrls}
          rows={2}
          spellcheck={false}
          autocomplete="off"
          placeholder="stun:stun.cloudflare.com:3478"
          onInput={(e) => setStunUrls((e.target as HTMLTextAreaElement).value)}
        />
      </label>

      <label class="mt-3 block text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {t('settingsRtcTurnLabel')}
        <textarea
          class={`${SETTINGS_INPUT_CLASS} mt-1 min-h-[4.5rem] font-mono text-sm`}
          value={turnUrls}
          rows={2}
          spellcheck={false}
          autocomplete="off"
          placeholder={'turn:turn.example.com:3478\nturns:turn.example.com:443'}
          onInput={(e) => setTurnUrls((e.target as HTMLTextAreaElement).value)}
        />
      </label>

      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <label class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
          {t('settingsRtcTurnUserLabel')}
          <input
            type="text"
            class={`${SETTINGS_INPUT_CLASS} mt-1`}
            value={turnUsername}
            autocomplete="off"
            onInput={(e) => setTurnUsername((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
          {t('settingsRtcTurnCredentialLabel')}
          <input
            type="password"
            class={`${SETTINGS_INPUT_CLASS} mt-1`}
            value={turnCredential}
            autocomplete="new-password"
            onInput={(e) => setTurnCredential((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <label class={`${SETTINGS_OPTION_ROW_CLASS} mt-2`}>
        <input
          type="checkbox"
          class="mt-1"
          checked={stripHost}
          onChange={(e) => setStripHost((e.target as HTMLInputElement).checked)}
        />
        <span>
          <span class="block text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {t('settingsRtcStripHostLabel')}
          </span>
          <span class="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
            {t('settingsRtcStripHostHint')}
          </span>
        </span>
      </label>

      <label class={SETTINGS_OPTION_ROW_CLASS}>
        <input
          type="checkbox"
          class="mt-1"
          checked={relayOnly}
          onChange={(e) => setRelayOnly((e.target as HTMLInputElement).checked)}
        />
        <span>
          <span class="block text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {t('settingsRtcRelayOnlyLabel')}
          </span>
          <span class="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
            {t('settingsRtcRelayOnlyHint')}
          </span>
        </span>
      </label>

      <div class="mt-4 flex flex-wrap gap-2">
        <button type="button" class={SETTINGS_PRIMARY_BTN_CLASS} onClick={() => handleSave()}>
          {t('settingsRtcIceSave')}
        </button>
        <button type="button" class={SETTINGS_SECONDARY_BTN_CLASS} onClick={() => handleReset()}>
          {t('settingsRtcIceClear')}
        </button>
      </div>

      {status !== 'idle' && statusText ? (
        <p
          class={`mt-3 text-sm ${
            status === 'ok'
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-rose-700 dark:text-rose-300'
          }`}
          role="status"
        >
          {statusText}
        </p>
      ) : null}
    </section>
  );
}
