/**
 * UX-UI-X-ALIGN：设置页分区样式（对齐 X）
 * - 不用灰底嵌套大卡片
 * - 白底 + 浅色横线分隔（#eff3f4 量级）
 * - 输入框保留可辨边框，但不用 border-2 zinc-500
 */

/** 设置页主分区：横线分隔，无灰底卡片 */
export const SETTINGS_SECTION_CLASS =
  'min-w-0 border-b border-[#eff3f4] bg-white px-0 py-6 transition-colors dark:border-[#2f3336] dark:bg-black sm:px-1';

/** 懒加载占位骨架 */
export const SETTINGS_SECTION_SKELETON_CLASS =
  'min-h-[8rem] animate-pulse border-b border-[#eff3f4] bg-zinc-100/60 dark:border-[#2f3336] dark:bg-zinc-900/40';

/** 分区标题 */
export const SETTINGS_SECTION_TITLE_CLASS =
  'text-[17px] font-bold tracking-tight text-zinc-950 dark:text-zinc-50';

/** 分区说明 */
export const SETTINGS_SECTION_DESC_CLASS =
  'mt-1 text-[13px] leading-5 text-zinc-500 dark:text-zinc-400';

/** 表单输入（1px zinc-300，可辨但不笨重） */
export const SETTINGS_INPUT_CLASS =
  'w-full rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-[15px] text-zinc-900 placeholder:text-zinc-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-500';

/** 密码输入：右侧留出眼睛按钮的位置（UX-SHOW-PWD） */
export const SETTINGS_PASSWORD_INPUT_CLASS =
  'w-full rounded-xl border border-zinc-300 bg-white py-2.5 pl-3 pr-11 text-[15px] text-zinc-900 placeholder:text-zinc-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-500';

/** 选项行（读帖保护 / 存储模式等）：列表行而非小卡片 */
export const SETTINGS_OPTION_ROW_CLASS =
  'flex cursor-pointer items-start gap-3 border-b border-[#eff3f4] px-1 py-3.5 last:border-b-0 hover:bg-zinc-50/80 dark:border-[#2f3336] dark:hover:bg-zinc-900/50';

/** 主按钮 */
export const SETTINGS_PRIMARY_BTN_CLASS =
  'rounded-full bg-sky-500 px-5 py-2 text-sm font-bold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-500 dark:hover:bg-sky-400';

/** 次按钮 */
export const SETTINGS_SECONDARY_BTN_CLASS =
  'rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900';

/* ────────────────────────────────────────────────────────────────────── *
 * M7-26h-2：分组 Hero + section header + 分组间隙样式常量
 *  - Hero：浅色渐变 + 圆角图标块，强化分组入口
 *  - Section header：图标 + 描述行，让用户扫一眼就知道去哪个 section
 *  - Gap：分组间 32px 大间隙
 * ────────────────────────────────────────────────────────────────────── */

/** 分组 Hero：UX-APPLE-4 缩小图标块、去掉重渐变，降低「运维台」感 */
export const SETTINGS_GROUP_HERO_CLASS =
  'flex items-start gap-3 border-b border-zinc-200/80 px-1 pb-3 pt-4 dark:border-zinc-800/80';

/** 分组 Hero 内图标方块：缩小为 9×9 */
export const SETTINGS_GROUP_HERO_ICON_WRAPPER_CLASS =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-600 ring-1 ring-sky-200/80 dark:bg-sky-900/40 dark:text-sky-300 dark:ring-sky-800';

/** 分组 Hero 标题 */
export const SETTINGS_GROUP_HERO_TITLE_CLASS =
  'text-[18px] font-semibold leading-tight tracking-tight text-zinc-950 dark:text-zinc-50';

/** 分组 Hero 描述：13px 灰字 */
export const SETTINGS_GROUP_HERO_DESC_CLASS =
  'mt-0.5 text-[13px] leading-5 text-zinc-500 dark:text-zinc-400';

/** 分组 Hero 计数徽章（"5 项"）— 保留 */
export const SETTINGS_GROUP_HERO_BADGE_CLASS =
  'ml-2 inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:bg-sky-900/40 dark:text-sky-300';

/** 分组 Hero 折叠徽章（高级默认折叠 · UX-AUDIT-8：虚线边框更安静） */
export const SETTINGS_GROUP_HERO_COLLAPSED_BADGE_CLASS =
  'ml-2 inline-flex items-center rounded-full border border-dashed border-zinc-300 bg-transparent px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:border-zinc-600 dark:text-zinc-400';

/** 筛选框（UX-APPLE-4：本页本地筛选） */
export const SETTINGS_FILTER_INPUT_CLASS =
  'w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-[14px] text-zinc-900 placeholder:text-zinc-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-500';

/** 分组 Hero 右侧 chevron（高级项专用，默认朝下，展开旋转 180°） */
export const SETTINGS_GROUP_HERO_CHEVRON_CLASS =
  'ml-auto mt-2 h-4 w-4 shrink-0 text-sky-600 transition-transform duration-150 dark:text-sky-300';

/** 分组 Hero 替代右侧 chevron（在非高级分类上也可加号的占位） */
export const SETTINGS_GROUP_HERO_CHEVRON_ROTATED_CLASS =
  'ml-auto mt-2 h-4 w-4 shrink-0 rotate-180 text-sky-600 transition-transform duration-150 dark:text-sky-300';

/** 分组间视觉间隙：32px 大空白 + 分组顶部柔光分隔 */
export const SETTINGS_GROUP_GAP_CLASS = 'h-8';

/** Section 标题头部：图标 + 标题，flex 行 */
export const SETTINGS_SECTION_HEADER_CLASS =
  'mb-3 flex items-center gap-2';

/** Section 头部图标 */
export const SETTINGS_SECTION_HEADER_ICON_CLASS =
  'shrink-0 text-sky-600 dark:text-sky-400';

/** Section 描述：一行说明这管什么 */
export const SETTINGS_SECTION_HEADER_DESC_CLASS =
  'mt-1 text-[13px] leading-5 text-zinc-500 dark:text-zinc-400';
