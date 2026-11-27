/** @jsxImportSource preact */
/**
 * M-REFACTOR-1d + M7-26h + M7-26h-2b/2c：Settings 薄壳
 * - 5 大分组 + 左侧固定二级导航（md+，不随正文滚）+ 移动端 chip
 * - advanced 默认折叠：进入时不渲染 8 个 section，点展开后再显示
 * - 2c：分组 Hero（大图标 + 标题 + 描述 + 计数徽章）
 *
 * §F-02 严守：不引业务 client / 不读 worker-a 字面量；分类与图标来自 SSOT。
 */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ChevronDown } from 'lucide-preact';
import { ThemeToggle } from '../ThemeToggle';
import { LanguageToggle } from '../LanguageToggle';
import { SettingsDeferredSection } from '../SettingsDeferredSection';
import { AppVersion } from '../AppVersion';
import { t } from '../../lib/i18n';
import {
  statusType,
  statusMsg,
  mustChangeCredentials,
  loggedInHandle,
  sessionHydrating,
  useSettingsSessionEffects,
} from './hooks/useSettingsSession';
import { refreshProfileForm } from './hooks/usePublicProfileSettings';
import { refreshRegistrationProfileForm } from './hooks/useRegistrySettings';
import { refreshReadProtectionMode } from './hooks/useReadProtectionSettings';
import { SettingsCategoryNav } from './SettingsCategoryNav';
import {
  SETTINGS_CATEGORIES,
  findSectionDef,
  type SettingsCategoryKey,
  type SettingsSectionKey,
} from '../../lib/settingsCategories';
import {
  SETTINGS_FILTER_INPUT_CLASS,
  SETTINGS_GROUP_GAP_CLASS,
  SETTINGS_GROUP_HERO_BADGE_CLASS,
  SETTINGS_GROUP_HERO_CLASS,
  SETTINGS_GROUP_HERO_COLLAPSED_BADGE_CLASS,
  SETTINGS_GROUP_HERO_DESC_CLASS,
  SETTINGS_GROUP_HERO_ICON_WRAPPER_CLASS,
  SETTINGS_GROUP_HERO_TITLE_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsAccountSection } from './SettingsAccountSection';
import { SettingsRegistryProfileSection } from './SettingsRegistryProfileSection';
import { SettingsUrlChangeSection } from './SettingsUrlChangeSection';
import { SettingsPublicProfileSection } from './SettingsPublicProfileSection';
import { SettingsEndpointSection } from './SettingsEndpointSection';
import { SettingsReadProtectionSection } from './SettingsReadProtectionSection';
import { SettingsMediaStorageSection } from './SettingsMediaStorageSection';
import { SettingsFollowerTokenSection } from './SettingsFollowerTokenSection';
import { SettingsHiddenPostsSection } from './SettingsHiddenPostsSection';
import { SettingsRegistryDiagnosticsSection } from './SettingsRegistryDiagnosticsSection';
import { SettingsOwnerEngagementSection } from './SettingsOwnerEngagementSection';
import { SettingsOwnerSessionsSection } from './SettingsOwnerSessionsSection';
import { SettingsDmPrivacySection } from './SettingsDmPrivacySection';
import { SettingsFriendRequestsSection } from './SettingsFriendRequestsSection';
import { SettingsRtcIceSection } from './SettingsRtcIceSection';

function Settings(): VNode {
  useSettingsSessionEffects({
    refreshProfileForm,
    refreshRegistrationProfileForm,
    refreshReadProtectionMode,
  });

  // 当前分组；默认落到第一组（账号与安全）
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryKey>(
    SETTINGS_CATEGORIES[0].key,
  );
  /** M7-26h-2b：advanced 默认折叠；离开 advanced 后再次进入仍折叠 */
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  /** UX-APPLE-4：本分组本地筛选（不发请求） */
  const [filterQuery, setFilterQuery] = useState('');
  /**
   * UX-APPLE-1d：只读至首次聚焦，挡住密码管理器把站主用户名（如 admin）灌进筛选框，
   * 否则 1 秒后全部 section 被滤掉，只剩「没有匹配的设置项」。
   */
  const [filterReadonly, setFilterReadonly] = useState(true);

  // 兜底：若筛选值恰好等于站主 handle 且滤空，视为自动填充，立即清空
  useEffect(() => {
    const handle = loggedInHandle.value?.trim().toLowerCase();
    if (!handle) return;
    if (filterQuery.trim().toLowerCase() !== handle) return;
    setFilterQuery('');
  }, [filterQuery, loggedInHandle.value]);

  const handleSelectCategory = (key: SettingsCategoryKey): void => {
    if (key !== 'advanced') {
      setAdvancedExpanded(false);
    }
    setFilterQuery('');
    setActiveCategory(key);
  };

  const handleToggleAdvanced = (): void => {
    setAdvancedExpanded((prev) => !prev);
  };

  const statusBox = (() => {
    if (statusType.value === 'idle' || !statusMsg.value) return null;
    const cls =
      statusType.value === 'success'
        ? 'mb-3 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
        : 'mb-3 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-200';
    return (
      <div class={cls} role="status" aria-live="polite">
        {statusMsg.value}
      </div>
    );
  })();

  // 订阅 session：账号区依赖 loggedInHandle；首屏 hydrating 时勿整页空白
  const ownerHandle = loggedInHandle.value;
  const hydrating = sessionHydrating.value;

  const activeDef = SETTINGS_CATEGORIES.find((c) => c.key === activeCategory) ?? SETTINGS_CATEGORIES[0];
  const isAdvanced = activeCategory === 'advanced';
  const filterQ = filterQuery.trim().toLowerCase();
  // 筛选时若在高级分组，临时展开以便看到匹配项；离开筛选或清空后仍尊重折叠态
  const forceExpandForFilter = isAdvanced && filterQ.length > 0;
  const advancedCollapsed = isAdvanced && !advancedExpanded && !forceExpandForFilter;

  const sectionMatches = (sectionKey: SettingsSectionKey): boolean => {
    if (!filterQ) return true;
    const def = findSectionDef(sectionKey);
    if (!def) return false;
    const hay = `${sectionKey} ${t(def.descKey)}`.toLowerCase();
    return hay.includes(filterQ);
  };

  const baseSections = advancedCollapsed ? [] : activeDef.sections.filter(sectionMatches);
  const visibleSections = new Set(baseSections);
  const sectionCount = activeDef.sections.length;
  const filteredEmpty = !advancedCollapsed && filterQ.length > 0 && baseSections.length === 0;
  const CategoryIcon = activeDef.icon;
  const showSessionLoading =
    !advancedCollapsed &&
    !ownerHandle &&
    hydrating &&
    (visibleSections.has('account') ||
      visibleSections.has('registryProfile') ||
      visibleSections.has('totp') ||
      visibleSections.has('urlChange') ||
      visibleSections.has('ownerSessions') ||
      visibleSections.has('ownerEngagement') ||
      visibleSections.has('publicProfile'));

  // 把每个 section 包成一个 helper：分组不在当前集合 → 返 null
  const show = (sectionKey: SettingsSectionKey, render: () => VNode | null): VNode | null => {
    return visibleSections.has(sectionKey) ? render() : null;
  };

  return (
    <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col md:flex-row md:gap-6">
      <SettingsCategoryNav
        active={activeCategory}
        onSelect={handleSelectCategory}
        advancedExpanded={advancedExpanded}
        onToggleAdvanced={handleToggleAdvanced}
      />

      {/* 唯一纵向滚动容器：左栏不在这里面，所以不会跟着滑 */}
      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-16">
        {/* UX-APPLE-4：本页筛选（纯前端） */}
        <div class="mb-3 px-1">
          <label class="sr-only" htmlFor="settings-filter">
            {t('settingsFilterAria')}
          </label>
          <input
            id="settings-filter"
            type="search"
            name="hailuo-settings-page-filter"
            value={filterQuery}
            onInput={(e) => setFilterQuery((e.currentTarget as HTMLInputElement).value)}
            onFocus={() => setFilterReadonly(false)}
            placeholder={t('settingsFilterPlaceholder')}
            class={SETTINGS_FILTER_INPUT_CLASS}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
            readOnly={filterReadonly}
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            data-form-type="other"
            data-testid="settings-filter"
          />
        </div>

        {/* M7-26h-2c / UX-APPLE-4：轻量 Hero — 小图标 + 标题 + 计数徽章 */}
        <div
          class={SETTINGS_GROUP_HERO_CLASS}
          role="region"
          aria-label={t('settingsGroupHeroAria')}
          aria-labelledby="settings-active-category-heading"
        >
          <div class={SETTINGS_GROUP_HERO_ICON_WRAPPER_CLASS} aria-hidden="true">
            <CategoryIcon size={20} strokeWidth={1.75} />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-y-1">
              <h2
                id="settings-active-category-heading"
                class={SETTINGS_GROUP_HERO_TITLE_CLASS}
              >
                {t(activeDef.labelKey)}
              </h2>
              {advancedCollapsed ? (
                <span class={SETTINGS_GROUP_HERO_COLLAPSED_BADGE_CLASS}>
                  {t('settingsCategoryAdvancedCollapsed', undefined, { n: sectionCount })}
                </span>
              ) : (
                <span
                  class={SETTINGS_GROUP_HERO_BADGE_CLASS}
                  aria-label={t('settingsGroupBadgeAria', undefined, { n: sectionCount })}
                >
                  {t('settingsCategorySectionCount', undefined, { n: sectionCount })}
                </span>
              )}
            </div>
            <p class={SETTINGS_GROUP_HERO_DESC_CLASS}>{t(activeDef.descKey)}</p>
          </div>
          {isAdvanced ? (
            <button
              type="button"
              class="shrink-0 rounded-lg p-1.5 text-sky-600 hover:bg-sky-100 dark:text-sky-300 dark:hover:bg-sky-900/40"
              aria-expanded={advancedExpanded}
              aria-label={
                advancedExpanded
                  ? t('settingsCategoryAdvancedCollapse')
                  : t('settingsCategoryAdvancedExpand')
              }
              onClick={handleToggleAdvanced}
            >
              <ChevronDown
                size={16}
                aria-hidden="true"
                class={
                  advancedExpanded
                    ? 'rotate-180 transition-transform duration-150'
                    : 'transition-transform duration-150'
                }
              />
            </button>
          ) : null}
        </div>

        {/* 分组 Hero 与下方 section 之间的视觉间隙 */}
        <div class={SETTINGS_GROUP_GAP_CLASS} aria-hidden="true" />

        {statusBox}

        {advancedCollapsed ? (
          <div
            class="flex flex-col items-start gap-3 rounded-xl border border-dashed border-zinc-300 bg-zinc-50/60 px-4 py-8 dark:border-zinc-700 dark:bg-zinc-900/40"
            role="status"
          >
            <p class="text-[14px] text-zinc-600 dark:text-zinc-400">
              {t('settingsCategoryAdvancedCollapsed', undefined, {
                n: sectionCount,
              })}
            </p>
            <p class="text-[13px] text-fg3">
              {t(activeDef.descKey)}
            </p>
            <button
              type="button"
              class={SETTINGS_PRIMARY_BTN_CLASS}
              onClick={() => setAdvancedExpanded(true)}
            >
              {t('settingsCategoryAdvancedExpand')}
            </button>
          </div>
        ) : null}

        {filteredEmpty ? (
          <p class="px-1 py-6 text-sm text-zinc-500 dark:text-zinc-400" role="status">
            {t('settingsFilterEmpty')}
          </p>
        ) : null}

        {showSessionLoading ? (
          <p
            class="px-1 py-6 text-sm text-zinc-500 dark:text-zinc-400"
            role="status"
            aria-live="polite"
            data-testid="settings-session-loading"
          >
            {t('settingsSessionLoading')}
          </p>
        ) : null}

        {show('account', () => <SettingsAccountSection />)}

        {show('totp', () => (
          <SettingsDeferredSection
            strategy="immediate"
            loader={() => import('../TotpSettings').then((m) => ({ default: m.TotpSettings }))}
            componentProps={{ mustChangeCredentials: mustChangeCredentials.value }}
            minHeight="8rem"
            skeletonLabel={t('settingsDeferredLoadingTotp')}
          />
        ))}

        {show('registryProfile', () => <SettingsRegistryProfileSection />)}
        {show('urlChange', () => <SettingsUrlChangeSection />)}

        {show('endpoint', () => <SettingsEndpointSection />)}
        {show('readProtection', () => <SettingsReadProtectionSection />)}
        {show('mediaStorage', () => <SettingsMediaStorageSection />)}
        {show('followerToken', () => <SettingsFollowerTokenSection />)}

        {show('publicProfile', () => <SettingsPublicProfileSection />)}
        {show('hiddenPosts', () => <SettingsHiddenPostsSection />)}
        {show('dmPrivacy', () => <SettingsDmPrivacySection />)}
        {show('friendRequests', () => <SettingsFriendRequestsSection />)}

        {show('theme', () => <ThemeToggle />)}
        {show('language', () => <LanguageToggle />)}

        {show('ownerSessions', () => <SettingsOwnerSessionsSection />)}
        {show('registryDiagnostics', () => <SettingsRegistryDiagnosticsSection />)}
        {show('ownerEngagement', () => <SettingsOwnerEngagementSection />)}
        {show('rtcIce', () => <SettingsRtcIceSection />)}

        {show('nodeMigrate', () => (
          <SettingsDeferredSection
            strategy="visible"
            loader={() => import('../NodeMigratePanel').then((m) => ({ default: m.NodeMigratePanel }))}
            componentProps={{}}
            minHeight="10rem"
            skeletonLabel={t('settingsDeferredLoadingNodeMigrate')}
          />
        ))}
        {show('hostedL0', () => (
          <SettingsDeferredSection
            strategy="visible"
            loader={() => import('../HostedL0Panel').then((m) => ({ default: m.HostedL0Panel }))}
            componentProps={{}}
            minHeight="10rem"
            skeletonLabel={t('settingsDeferredLoadingHostedL0')}
          />
        ))}
        {show('localData', () => (
          <SettingsDeferredSection
            strategy="visible"
            loader={() => import('../LocalDataPanel').then((m) => ({ default: m.LocalDataPanel }))}
            componentProps={{}}
            minHeight="12rem"
            skeletonLabel={t('settingsDeferredLoadingLocalData')}
          />
        ))}

        {show('appVersion', () => <AppVersion />)}
      </div>
    </div>
  );
}

export { Settings };
