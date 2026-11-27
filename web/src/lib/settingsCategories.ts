/**
 * M7-26h：设置页 5 大分组的 SSOT（Single Source of Truth）。
 *
 * 背景：设置页自 M-REFACTOR-1d 后扁平展开 16+ 个 section，对站主不友好：
 *   - 内容多且无分组
 *   - 不知道每个设置属于哪里
 *   - 想改一项要滚很久
 *
 * 设计：把现有 section 按"用户视角的功能域"归并到 5 个分组，每个分组在
 * SettingsCategoryNav 是一行带 lucide 图标的导航项；点中后 Settings 组件
 * 只渲染当前分组包含的 section，其它分组隐藏。
 *
 * 关键约束：
 *   - `key` 是分组唯一标识（URL hash / 测试断言都用它）
 *   - `sections` 是分组包含的 section key（与 Settings index 内组件变量名同源）
 *   - `icon` 必须从 lucide-preact 导入（避免动态 import 拖慢首屏）
 *   - `labelKey` / `descKey` 必须在 zh + en 两个 locale 都注册（test 会查）
 *   - 不要在本文件写任何 Worker A / Worker B 字面量（§F-02 红线）
 *
 * 演进规则：新增分组或 section 时，只改本文件 + i18n + Settings index 渲染映射，
 * 不要散落写分类逻辑到组件内。
 */

import type { LucideIcon } from 'lucide-preact';
import {
  ShieldCheck,
  Server,
  Lock,
  Palette,
  SlidersHorizontal,
  // M7-26h-2：22 个 section 各自的图标
  KeyRound,
  Smartphone,
  Globe,
  Link2,
  Clock,
  Shield,
  HardDrive,
  BadgeCheck,
  UserCog,
  EyeOff,
  UserPlus,
  Languages,
  Activity,
  ChartColumn, // lucide 新名；旧 BarChart2 已移除
  Radio,
  Move,
  Cloud,
  Database,
  Info,
} from 'lucide-preact';
import type { TranslationKey } from './i18n';

/** SettingsCategoryKey 是分组枚举；URL hash / 测试断言 / 历史 anchor 都用它 */
export type SettingsCategoryKey =
  | 'account'
  | 'node'
  | 'privacy'
  | 'appearance'
  | 'advanced';

/** SettingsSectionKey 是单个 section 的稳定标识 */
export type SettingsSectionKey =
  | 'account'
  | 'registryProfile'
  | 'urlChange'
  | 'totp'
  | 'ownerSessions'
  | 'endpoint'
  | 'readProtection'
  | 'mediaStorage'
  | 'followerToken'
  | 'publicProfile'
  | 'hiddenPosts'
  | 'dmPrivacy'
  | 'friendRequests'
  | 'theme'
  | 'language'
  | 'registryDiagnostics'
  | 'ownerEngagement'
  | 'rtcIce'
  | 'nodeMigrate'
  | 'hostedL0'
  | 'localData'
  | 'appVersion';

export interface SettingsCategoryDef {
  readonly key: SettingsCategoryKey;
  /** i18n key：分类显示名（中英文各自一份） */
  readonly labelKey: TranslationKey;
  /** i18n key：分类副标题（一句话说明这组管什么） */
  readonly descKey: TranslationKey;
  /** lucide-preact 图标组件（分类维度，由 SettingsCategoryNav 静态引用） */
  readonly icon: LucideIcon;
  /** 该分组包含的 section key 列表（顺序即渲染顺序） */
  readonly sections: ReadonlyArray<SettingsSectionKey>;
}

/** 5 大分组：日常优先（账号→外观→隐私→节点），高级殿后且默认折叠 */
export const SETTINGS_CATEGORIES: ReadonlyArray<SettingsCategoryDef> = [
  {
    key: 'account',
    labelKey: 'settingsCategoryAccountLabel',
    descKey: 'settingsCategoryAccountDesc',
    icon: ShieldCheck,
    // UX-APPLE-4：日常子集 — 密码 / TOTP / 登记资料；换域名与会话迁入 advanced
    sections: [
      'account',
      'totp',
      'registryProfile',
    ],
  },
  {
    key: 'appearance',
    labelKey: 'settingsCategoryAppearanceLabel',
    descKey: 'settingsCategoryAppearanceDesc',
    icon: Palette,
    sections: ['theme', 'language'],
  },
  {
    key: 'privacy',
    labelKey: 'settingsCategoryPrivacyLabel',
    descKey: 'settingsCategoryPrivacyDesc',
    icon: Lock,
    sections: [
      'publicProfile',
      'hiddenPosts',
      'dmPrivacy',
      'friendRequests',
    ],
  },
  {
    key: 'node',
    labelKey: 'settingsCategoryNodeLabel',
    descKey: 'settingsCategoryNodeDesc',
    icon: Server,
    sections: [
      'endpoint',
      'readProtection',
      'mediaStorage',
      'followerToken',
    ],
  },
  {
    key: 'advanced',
    labelKey: 'settingsCategoryAdvancedLabel',
    descKey: 'settingsCategoryAdvancedDesc',
    icon: SlidersHorizontal,
    sections: [
      'urlChange',
      'ownerSessions',
      'registryDiagnostics',
      'ownerEngagement',
      'rtcIce',
      'nodeMigrate',
      'hostedL0',
      'localData',
      'appVersion',
    ],
  },
];

/** 由 categoryKey 快速查找分类定义；找不到则回落到第一组 */
export function findSettingsCategory(
  key: string | null | undefined,
): SettingsCategoryDef {
  const matched = SETTINGS_CATEGORIES.find((c) => c.key === key);
  return matched ?? SETTINGS_CATEGORIES[0];
}

/** 由 sectionKey 反查它所属的分类（用于测试与日志） */
export function findCategoryBySection(
  section: SettingsSectionKey,
): SettingsCategoryDef | null {
  for (const cat of SETTINGS_CATEGORIES) {
    if (cat.sections.includes(section)) return cat;
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────── *
 * M7-26h-2：每个 section 的图标 + 描述 SSOT
 *  - 与 SETTINGS_CATEGORIES 解耦：category 只关心 group 维度的导航
 *  - section 才是用户在分组内真正点的 22 个目标
 *  - 新增 section 只需在下方数组里加一行；改 icon 或文案不影响 category 结构
 * ────────────────────────────────────────────────────────────────────── */

export interface SettingsSectionDef {
  readonly key: SettingsSectionKey;
  /** 该 section 所属的分组（用于快速反向查询） */
  readonly category: SettingsCategoryKey;
  /** lucide-preact 图标组件（section 头部渲染） */
  readonly icon: LucideIcon;
  /** i18n key：section 一行描述（zh + en 必须存在） */
  readonly descKey: TranslationKey;
}

/** 全部 section 的 SSOT（顺序 = 默认在分组内的渲染顺序；分组内顺序由 SETTINGS_CATEGORIES.sections 决定） */
export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSectionDef> = [
  /* 账号与安全（日常） */
  { key: 'account',            category: 'account',    icon: KeyRound,    descKey: 'settingsSectionAccountDesc' },
  { key: 'totp',               category: 'account',    icon: Smartphone,  descKey: 'settingsSectionTotpDesc' },
  { key: 'registryProfile',    category: 'account',    icon: Globe,       descKey: 'settingsSectionRegistryProfileDesc' },

  /* 外观（日常） */
  { key: 'theme',              category: 'appearance', icon: Palette,     descKey: 'settingsSectionThemeDesc' },
  { key: 'language',           category: 'appearance', icon: Languages,   descKey: 'settingsSectionLanguageDesc' },

  /* 隐私（日常） */
  { key: 'publicProfile',      category: 'privacy',    icon: UserCog,     descKey: 'settingsSectionPublicProfileDesc' },
  { key: 'hiddenPosts',        category: 'privacy',    icon: EyeOff,      descKey: 'settingsSectionHiddenPostsDesc' },
  { key: 'dmPrivacy',          category: 'privacy',    icon: Lock,        descKey: 'settingsSectionDmPrivacyDesc' },
  { key: 'friendRequests',     category: 'privacy',    icon: UserPlus,    descKey: 'settingsSectionFriendRequestsDesc' },

  /* 节点（半日常：读帖保护等） */
  { key: 'endpoint',           category: 'node',       icon: Server,      descKey: 'settingsSectionEndpointDesc' },
  { key: 'readProtection',     category: 'node',       icon: Shield,      descKey: 'settingsSectionReadProtectionDesc' },
  { key: 'mediaStorage',       category: 'node',       icon: HardDrive,   descKey: 'settingsSectionMediaStorageDesc' },
  { key: 'followerToken',      category: 'node',       icon: BadgeCheck,  descKey: 'settingsSectionFollowerTokenDesc' },

  /* 高级（运维 / 排障；URL 换绑与会话管理也归此） */
  { key: 'urlChange',          category: 'advanced',   icon: Link2,       descKey: 'settingsSectionUrlChangeDesc' },
  { key: 'ownerSessions',      category: 'advanced',   icon: Clock,       descKey: 'settingsSectionOwnerSessionsDesc' },
  { key: 'registryDiagnostics', category: 'advanced',  icon: Activity,    descKey: 'settingsSectionRegistryDiagnosticsDesc' },
  { key: 'ownerEngagement',     category: 'advanced',  icon: ChartColumn, descKey: 'settingsSectionOwnerEngagementDesc' },
  { key: 'rtcIce',              category: 'advanced',  icon: Radio,       descKey: 'settingsSectionRtcIceDesc' },
  { key: 'nodeMigrate',         category: 'advanced',  icon: Move,        descKey: 'settingsSectionNodeMigrateDesc' },
  { key: 'hostedL0',            category: 'advanced',  icon: Cloud,       descKey: 'settingsSectionHostedL0Desc' },
  { key: 'localData',           category: 'advanced',  icon: Database,    descKey: 'settingsSectionLocalDataDesc' },
  { key: 'appVersion',          category: 'advanced',  icon: Info,        descKey: 'settingsSectionAppVersionDesc' },
];

/** 由 categoryKey 派生该分组的全部 section 定义（顺序按 SETTINGS_CATEGORIES.sections） */
export function getSectionsForCategory(
  key: SettingsCategoryKey,
): ReadonlyArray<SettingsSectionDef> {
  const cat = SETTINGS_CATEGORIES.find((c) => c.key === key);
  if (!cat) return [];
  const byKey = new Map(SETTINGS_SECTIONS.map((s) => [s.key, s] as const));
  const out: SettingsSectionDef[] = [];
  for (const sk of cat.sections) {
    const def = byKey.get(sk);
    if (def) out.push(def);
  }
  return out;
}

/** 由 sectionKey 查找其定义；找不到返 null */
export function findSectionDef(
  key: string | null | undefined,
): SettingsSectionDef | null {
  if (!key) return null;
  return SETTINGS_SECTIONS.find((s) => s.key === key) ?? null;
}
