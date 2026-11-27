/** @jsxImportSource preact */
/**
 * M7-26h-2d：单个设置 section 的微型头部
 * - 左侧 16px lucide 图标 + 标题
 * - 下一行 i18n 描述（来自 SETTINGS_SECTIONS SSOT）
 *
 * §F-02：只读 SSOT / i18n / 样式常量，不引业务 client。
 */
import type { ComponentChildren, VNode } from 'preact';
import { t } from '../../lib/i18n';
import {
  findSectionDef,
  type SettingsSectionKey,
} from '../../lib/settingsCategories';
import {
  SETTINGS_SECTION_HEADER_CLASS,
  SETTINGS_SECTION_HEADER_DESC_CLASS,
  SETTINGS_SECTION_HEADER_ICON_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from '../../lib/settingsSectionStyles';

export interface SettingsSectionHeaderProps {
  readonly sectionKey: SettingsSectionKey;
  /** 已翻译的标题文案（或含动态片段的 VNode） */
  readonly title: ComponentChildren;
  /** 标题行右侧操作（如收起/展开按钮） */
  readonly trailing?: ComponentChildren;
}

export function SettingsSectionHeader(props: SettingsSectionHeaderProps): VNode {
  const def = findSectionDef(props.sectionKey);
  const Icon = def?.icon;

  return (
    <>
      <div class="flex items-center justify-between gap-2">
        <div class={SETTINGS_SECTION_HEADER_CLASS + ' mb-0'}>
          {Icon ? (
            <Icon
              size={16}
              strokeWidth={2}
              aria-hidden="true"
              class={SETTINGS_SECTION_HEADER_ICON_CLASS}
            />
          ) : null}
          <h2 class={SETTINGS_SECTION_TITLE_CLASS}>{props.title}</h2>
        </div>
        {props.trailing ?? null}
      </div>
      {def ? (
        <p class={SETTINGS_SECTION_HEADER_DESC_CLASS}>{t(def.descKey)}</p>
      ) : null}
    </>
  );
}
