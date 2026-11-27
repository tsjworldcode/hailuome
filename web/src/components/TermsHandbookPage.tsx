/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { language, t } from '../lib/i18n';
import { TermsHandbookBody } from './TermsHandbookBody';

/** /terms 页面 island：跟随站点语言切换中英文手册。 */
export function TermsHandbookPage(): VNode {
  return (
    <div class="mx-auto max-w-2xl px-4 py-10">
      <TermsHandbookBody lang={language.value} />
      <p class="mt-8 text-sm text-zinc-500 dark:text-zinc-400">
        <a href="/register" class="text-sky-600 hover:underline dark:text-sky-400">
          {t('registryBackToRegister')}
        </a>
      </p>
    </div>
  );
}
