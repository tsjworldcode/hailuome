/**
 * EPOCH-REKEY-1/2：隔绝 vs 真换钥门禁 + commit 齐备判定。
 *
 * REKEY-1：踢人只隔绝；禁止假 wrap / 乱翻 epoch。
 * REKEY-2 / OWNER-KEY-5：优先群主节点 `owner-rekey` 写齐 next wraps 后 CAS；
 * 浏览器 Batch Wrap + `rekey-commit` 仅迁移期兜底。
 */

/** 单次分批上传上限（Free CPU / D1；与计划 B4 对齐） */
export const REKEY_WRAP_BATCH_MAX = 32;

/** X25519 raw 公钥：64 位小写 hex（与 dm_pubkey 同形，职责分离） */
export function isValidMemberDhPubkeyHex(raw: string): boolean {
  return /^[0-9a-f]{64}$/.test(raw);
}

/**
 * SEC-AUDIT-2026-10-16：下一 epoch 群钥指纹 = SHA-256(raw group_key) 的 64 hex。
 * Worker 只比对同源，不解包密文。
 */
export function isValidGroupKeyFingerprint(raw: string): boolean {
  return /^[0-9a-f]{64}$/.test(raw);
}

export function normalizeGroupKeyFingerprint(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const hex = raw.trim().toLowerCase();
  return isValidGroupKeyFingerprint(hex) ? hex : '';
}

export type RekeyWrapCandidate = {
  member_worker_b_url: string;
  wrapped_key_json: string;
  /** 下一 epoch 必填；缺省/混指纹则 commit 拒绝 */
  key_fingerprint?: string | null;
};

/** 踢人路径的唯一合法决策：仅隔绝、不翻 epoch、不把留下成员打 pending。 */
export type KickIsolationDecision = {
  mode: 'isolation_only';
  advance_epoch: false;
  mark_remaining_pending: false;
};

export type KickRekeyPolicyResult =
  | { ok: true; decision: KickIsolationDecision }
  | { ok: false; error_code: 'GROUP_REKEY_NOT_READY'; message: string };

/**
 * 踢人请求上的换钥策略。
 * 附带任何 wrap 都视为试图在 DH/Batch 未就绪时假换钥 → 拒绝。
 */
export function decideKickRekeyPolicy(input?: {
  wrappedKeys?: readonly RekeyWrapCandidate[] | null;
}): KickRekeyPolicyResult {
  const wraps = input?.wrappedKeys ?? [];
  if (wraps.length > 0) {
    return {
      ok: false,
      error_code: 'GROUP_REKEY_NOT_READY',
      message: '踢人仅隔绝；尚未能为全员密封新钥，禁止附带 wrap 冒充换钥',
    };
  }
  return {
    ok: true,
    decision: {
      mode: 'isolation_only',
      advance_epoch: false,
      mark_remaining_pending: false,
    },
  };
}

/** wraps 是否覆盖全部留下的活跃成员 URL（规范化后精确匹配；空 json 不算可读）。 */
export function wrapsCoverActiveMembers(
  remainingActiveUrls: readonly string[],
  wraps: readonly RekeyWrapCandidate[],
  normalizeUrl: (url: string) => string = (u) => u,
): boolean {
  if (remainingActiveUrls.length === 0) return true;
  const byUrl = new Map<string, string>();
  for (const w of wraps) {
    if (typeof w.member_worker_b_url !== 'string' || typeof w.wrapped_key_json !== 'string') {
      return false;
    }
    const url = normalizeUrl(w.member_worker_b_url);
    const json = w.wrapped_key_json.trim();
    if (!url || !json) return false;
    byUrl.set(url, json);
  }
  for (const raw of remainingActiveUrls) {
    const url = normalizeUrl(raw);
    const json = byUrl.get(url);
    if (!json) return false;
  }
  return true;
}

/**
 * REKEY-2 commit 入口守卫：wraps 未齐备则禁止推进 epoch。
 */
export function canAdvanceGroupEpoch(input: {
  remainingActiveUrls: readonly string[];
  wraps: readonly RekeyWrapCandidate[];
  normalizeUrl?: (url: string) => string;
}): boolean {
  return wrapsCoverActiveMembers(
    input.remainingActiveUrls,
    input.wraps,
    input.normalizeUrl,
  );
}

/**
 * SEC-AUDIT-2026-10-16：sealable 成员的 next wraps 必须覆盖齐全且共享同一非空 fingerprint。
 * 防分批重试/双管理员并发把不同 group_key 的 wrap 混进同一 epoch。
 */
export function wrapsShareHomogeneousFingerprint(input: {
  remainingActiveUrls: readonly string[];
  wraps: readonly RekeyWrapCandidate[];
  normalizeUrl?: (url: string) => string;
}):
  | { ok: true; fingerprint: string }
  | { ok: false; reason: 'incomplete' | 'missing' | 'mixed' } {
  const normalizeUrl = input.normalizeUrl ?? ((u: string) => u);
  if (
    !canAdvanceGroupEpoch({
      remainingActiveUrls: input.remainingActiveUrls,
      wraps: input.wraps,
      normalizeUrl,
    })
  ) {
    return { ok: false, reason: 'incomplete' };
  }
  const byUrl = new Map<string, RekeyWrapCandidate>();
  for (const w of input.wraps) {
    byUrl.set(normalizeUrl(w.member_worker_b_url), w);
  }
  let fingerprint: string | null = null;
  for (const raw of input.remainingActiveUrls) {
    const url = normalizeUrl(raw);
    const row = byUrl.get(url);
    const fp = normalizeGroupKeyFingerprint(row?.key_fingerprint ?? '');
    if (!fp) return { ok: false, reason: 'missing' };
    if (fingerprint === null) fingerprint = fp;
    else if (fingerprint !== fp) return { ok: false, reason: 'mixed' };
  }
  // remaining 为空时 canAdvance 已 true；无 sealable 不应走到 commit
  if (!fingerprint) return { ok: false, reason: 'missing' };
  return { ok: true, fingerprint };
}

/**
 * SEC-AUDIT-2026-10-15：按是否已登记有效 member_dh_pubkey 拆分活跃成员。
 * - sealable：可密封，commit 必须为他们备齐 next-epoch wraps
 * - deferred：离线/未登记 DH；不挡换钥，commit 后标 pending_key 待上线补钥
 */
export function partitionActiveMembersByDh(
  rows: readonly { member_worker_b_url: string; member_dh_pubkey: string | null }[],
  normalizeUrl: (url: string) => string = (u) => u,
): { sealableUrls: string[]; deferredUrls: string[] } {
  const sealableUrls: string[] = [];
  const deferredUrls: string[] = [];
  for (const r of rows) {
    const url = normalizeUrl(r.member_worker_b_url);
    if (!url) continue;
    const dh = (r.member_dh_pubkey ?? '').trim().toLowerCase();
    if (isValidMemberDhPubkeyHex(dh)) sealableUrls.push(url);
    else deferredUrls.push(url);
  }
  return { sealableUrls, deferredUrls };
}

/** 归一化入参里的 X25519 DH 公钥；非法返回空串。 */
export function normalizeMemberDhPubkeyHex(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const hex = raw.trim().toLowerCase();
  return isValidMemberDhPubkeyHex(hex) ? hex : '';
}
