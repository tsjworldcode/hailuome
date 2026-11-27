/** @jsxImportSource preact */
/**
 * M7-26g：Settings 重子模块分段 dynamic import。
 * - immediate：Settings mount 后立刻拉 chunk（如 TotpSettings）
 * - visible：进入视口再拉 chunk（如 LocalDataPanel / UrlChangeWizard）
 */
import type { VNode, ComponentType } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SETTINGS_SECTION_SKELETON_CLASS } from '../lib/settingsSectionStyles';
import { t } from '../lib/i18n';

export type SettingsDeferredStrategy = 'immediate' | 'visible';

// dynamic import 的组件 props 各异，运行时由 Settings 传入；此处用宽松类型避免 TS 误报
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LazyComponent = ComponentType<any>;

type Props = {
  readonly strategy?: SettingsDeferredStrategy;
  readonly loader: () => Promise<{ default: LazyComponent }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly componentProps: any;
  readonly minHeight?: string;
  readonly skeletonLabel?: string;
};

export function SettingsDeferredSection({
  strategy = 'visible',
  loader,
  componentProps,
  minHeight = '8rem',
  skeletonLabel = t('settingsDeferredLoading'),
}: Props): VNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(strategy === 'immediate');
  const [Comp, setComp] = useState<LazyComponent | null>(null);

  useEffect(() => {
    if (strategy !== 'visible' || shouldLoad) return;
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShouldLoad(true);
          io.disconnect();
        }
      },
      { rootMargin: '280px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [strategy, shouldLoad]);

  useEffect(() => {
    if (!shouldLoad || Comp) return;
    let cancelled = false;
    void loader().then((mod) => {
      if (!cancelled && mod.default) setComp(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
    // loader 由调用方 inline 传入， intentionally 不列入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldLoad, Comp]);

  return (
    <div ref={hostRef} style={Comp ? undefined : { minHeight }}>
      {Comp ? (
        <Comp {...componentProps} />
      ) : (
        <div
          class={SETTINGS_SECTION_SKELETON_CLASS}
          role="status"
          aria-busy="true"
          aria-label={skeletonLabel}
        />
      )}
    </div>
  );
}
