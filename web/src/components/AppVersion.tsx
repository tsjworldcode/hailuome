/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { t } from '../lib/i18n';
import { SettingsSectionHeader } from './settings/SettingsSectionHeader';

const version = signal<string>('');
const loaded = signal<boolean>(false);

export function AppVersion(): VNode | null {
  useEffect(() => {
    if (loaded.value) return;
    loaded.value = true;
    void (async () => {
      try {
        const res = await fetch('/site-version.json', { cache: 'no-store' });
        const parsed = (await res.json()) as { version?: unknown };
        if (typeof parsed.version === 'string' && parsed.version.trim()) {
          version.value = parsed.version.trim();
        }
      } catch {
        version.value = '';
      }
    })();
  }, []);

  if (!version.value) return null;

  return (
    <>
      <SettingsSectionHeader sectionKey="appVersion" title={t('appVersionAria')} />
      <p class="text-center text-[11px] leading-5 text-slate-400 dark:text-zinc-500" aria-label={t('appVersionAria')}>
        v{version.value}
      </p>
    </>
  );
}
