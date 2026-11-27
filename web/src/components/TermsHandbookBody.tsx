/** @jsxImportSource preact */
import type { VNode } from 'preact';
import type { Language } from '../lib/i18n';
import { getTermsDoc } from '../lib/termsHandbook';

type Props = {
  lang: Language;
  /** 紧凑样式（模态框内） */
  compact?: boolean;
};

/** 渲染项目许可与使用手册正文（中英文由 lang 决定）。 */
export function TermsHandbookBody({ lang, compact = false }: Props): VNode {
  const doc = getTermsDoc(lang);
  const titleClass = compact
    ? 'text-lg font-bold text-zinc-900 dark:text-zinc-50'
    : 'text-2xl font-bold text-zinc-900 dark:text-zinc-50';

  return (
    <div class={compact ? 'space-y-4 text-sm' : 'space-y-6 text-base'}>
      <header>
        <h1 class={titleClass}>{doc.title}</h1>
        <p class="mt-2 text-sm font-medium text-fg2">{doc.intro}</p>
      </header>

      {doc.sections.map((section) => (
        <section key={section.title}>
          <h2 class="mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">{section.title}</h2>
          <div class="space-y-2 text-zinc-700 dark:text-zinc-300">
            {section.blocks.map((block, idx) => {
              if (block.type === 'p') {
                return (
                  <p key={idx} class="leading-relaxed">
                    {block.text}
                  </p>
                );
              }
              return (
                <ul key={idx} class="list-disc space-y-1 pl-5 leading-relaxed">
                  {block.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              );
            })}
          </div>
        </section>
      ))}

      <p class="text-sm text-zinc-500 dark:text-zinc-400">{doc.footerNote}</p>
    </div>
  );
}
