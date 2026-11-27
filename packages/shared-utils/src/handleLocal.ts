/**
 * 本地 handle 格式（登记 / 粉丝互动等写路径）。
 * 与 hailuo-registry `qualifiedHandle.ts` HANDLE_LOCAL_RE 保持同步（M9-PH-4 跨仓源码字面量契约）。
 */

/**
 * 登记硬规则（HANDLE-ZH-1 + HANDLE-BYTE-LEN · 与 registry / HC 口径对齐）：
 * 最小 5 字节 / 最大 32 字节（**UTF-8 真实物理存储字节**：1 英文/数字 = 1 字节，
 * 1 汉字 = 3 字节）、小写字母或中文开头、禁止连续 4 相同字符；
 * 可含数字 / 连字符 / 下划线 / 中文；禁止 `:` `@` `#`（区域后缀由注册中心写入）。
 *
 * 中文注释：正则只管「字符集 + 开头 + 禁四同」，**长度一律走字节函数**；
 * 正则里不再写 `{4,31}`，否则中文名会被按「字符数」误判。
 */
export const HANDLE_LOCAL_RE = /^(?!.*(.)\1{3})[a-z\u4e00-\u9fff][a-z0-9_\u4e00-\u9fff-]*$/;

/** lookup / 搜人存量兼容：旧规可数字开头；亦允许中文与 `-`/`_`。 */
export const HANDLE_LOCAL_RE_LEGACY = /^[a-z0-9\u4e00-\u9fff][a-z0-9_\u4e00-\u9fff-]{0,31}$/;

/**
 * HANDLE-BYTE-LEN：handle 长度上下限（**UTF-8 真实物理存储字节**）。
 *
 * - 1 个英文字母 / 数字 / 连字符 / 下划线 = 1 字节
 * - 1 个汉字（CJK `\u4e00-\u9fff`）= 3 字节
 *
 * 三仓（registry / node-cf / handle-center）必须用同一套字节口径，避免
 * 「注册中心放行、节点仓拒绝」或反之的跨仓裂缝。
 */
export const HANDLE_MIN_BYTES = 5;
export const HANDLE_MAX_BYTES = 32;

/** 一次性复用的 UTF-8 编码器（Workers edge runtime / 浏览器 / Node 均有）。 */
const handleByteEncoder = new TextEncoder();

/** handle 的 UTF-8 真实物理存储字节数（TextEncoder 口径）。 */
export function handleUtf8ByteLength(handle: string): number {
  return handleByteEncoder.encode(handle).length;
}

/** handle 字节长度是否落在 [HANDLE_MIN_BYTES, HANDLE_MAX_BYTES]。 */
export function isHandleByteLengthValid(handle: string): boolean {
  const bytes = handleUtf8ByteLength(handle);
  return bytes >= HANDLE_MIN_BYTES && bytes <= HANDLE_MAX_BYTES;
}

/**
 * 保留前缀（与 registry `reservedHandles.ts` 同源）。
 * 权威拒绝在注册中心登记链路；节点侧预检只为早失败与文案一致。
 */
export const RESERVED_HANDLE_PREFIX = 'hailuo-registry';

export const HANDLE_LOCAL_RULES_USER_MESSAGE_ZH =
  '海螺名须 5–32 字节（UTF-8，1 个汉字占 3 字节）、以小写字母或中文开头，且不能出现连续 4 个相同字符（可含数字、连字符、下划线与中文；不要自己加 : @ #）';

export const HANDLE_LOCAL_RULES_USER_MESSAGE_EN =
  'Handle must be 5–32 bytes (UTF-8, one Chinese character counts as 3 bytes), start with a lowercase letter or Chinese character, may contain digits/hyphen/underscore/Chinese, and must not contain 4 identical characters in a row (do not include : @ #)';

export const HANDLE_RESERVED_USER_MESSAGE_ZH =
  `海螺名不能以「${RESERVED_HANDLE_PREFIX}」开头（与生态官方账号保留前缀冲突）`;

export const HANDLE_RESERVED_USER_MESSAGE_EN =
  `Handle cannot start with "${RESERVED_HANDLE_PREFIX}" (reserved for official accounts)`;

/** 是否命中保留前缀（调用前应已 toLowerCase）。 */
export function isReservedHandlePrefix(handle: string): boolean {
  return handle.startsWith(RESERVED_HANDLE_PREFIX);
}

/** 登记 / 发 token 等写路径校验（裸本地段；含 `:` `@` `#` 一律非法；不含保留字检查）。 */
export function isValidRegisterHandleLocal(handle: string): boolean {
  if (handle.includes(':')) return false;
  if (handle.includes('@')) return false;
  if (handle.includes('#')) return false;
  if (!HANDLE_LOCAL_RE.test(handle)) return false;
  // 中文注释：长度按 UTF-8 真实物理存储字节判（5–32 字节），不是字符数
  return isHandleByteLengthValid(handle);
}

/** 搜人 / 解析读路径（兼容存量短名）。 */
export function isValidLegacyHandleLocal(handle: string): boolean {
  return HANDLE_LOCAL_RE_LEGACY.test(handle);
}

/**
 * M-F2 · 归一化「本地 handle 段」（跨节点加好友口径统一）。
 *
 * 背景：注册中心对外可能下发**限定名**（`alice@reg2`；主中心为裸名），而节点本地
 * `users.handle` 存的是**裸本地名**（`alice`）。加好友跨节点链路里直接字符串比较会误判：
 *   - 发起端：`target_handle` 含 `@` → 被 handle 格式校验拒 → 请求根本发不出去；
 *   - 接收端：`row.target_handle !== localUser.handle` → NOT_RECIPIENT → 对方点「接受」失败。
 *
 * 归一化步骤：去首尾空白 → 转小写 → 去前导 `@` → 截断 `@registry_id` 后缀 → 下划线转连字符。
 * 归一化后仍按 `HANDLE_LOCAL_RE_LEGACY` 校验（短名兼容，登记严格规由注册中心把关）。
 *
 * 下划线转连字符与 `routes/follower-tokens.ts` / `routes/register.ts` / `lib/localNodeResolve.ts`
 * 同口径（BOOTSTRAP_HANDLE 形如 `hailuo_`+10 位后缀必须能对上登记名把 `_` 视同 `-`）。
 */
export function normalizeHandleLocalSegment(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^@+/, '');
  // HANDLE-QUAL-V1：`:` 是正式分隔符；`@` 继续兼容历史写法
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(0, at);
  return s.replace(/_/g, '-');
}
