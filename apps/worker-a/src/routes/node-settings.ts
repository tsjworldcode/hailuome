/**
 * 站主节点设置（JWT 鉴权）：D1 system_config 为权威，同步到 STATE_KV 供 Worker B 只读。
 * SEC-AUDIT-ENFORCED-FORCE-2：默认 token-required；FORCE 关时 PATCH 可改五档（含 public-read）。
 */
import { resolveIdentityDb } from '../db/bindings';
import { Hono } from 'hono';
import type { FollowerTokenMode } from '@hailuo/shared-types';
import {
  isFollowerTokenModeProgramForced,
  normalizeFollowerTokenMode,
  parseFollowerTokenModeForWrite,
  resolveForcedFollowerTokenMode,
} from '@hailuo/shared-utils';
import type { Env, AppVariables } from '../env';
import { mediaStorageSettingsApp } from './node-settings-media-storage';

export const FOLLOWER_TOKEN_MODE_CONFIG_KEY = 'follower_token_mode';
/** Worker B 只读；与 blacklist 同步同 KV namespace */
export const FOLLOWER_TOKEN_MODE_KV_KEY = 'node:follower_token_mode';

export type FollowerTokenModeSource = 'd1' | 'env' | 'program';

function nowIso(): string {
  return new Date().toISOString();
}

function modeFromEnv(env: Env): FollowerTokenMode {
  return normalizeFollowerTokenMode(env.FOLLOWER_TOKEN_MODE);
}

/** M14-7：读到遗留 `enforced` 时写回 canonical `following-only`。 */
async function writeCanonicalModeIfNeeded(env: Env, storedRaw: string, canonical: FollowerTokenMode): Promise<void> {
  if (storedRaw.trim() === canonical) return;
  const iso = nowIso();
  try {
    await resolveIdentityDb(env)
      .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(FOLLOWER_TOKEN_MODE_CONFIG_KEY, canonical, iso)
      .run();
    await env.STATE_KV.put(FOLLOWER_TOKEN_MODE_KV_KEY, canonical);
  } catch (err) {
    console.error('[node-settings] enforced alias 写回失败', err);
  }
}

async function readStoredMode(
  env: Env,
): Promise<{ mode: FollowerTokenMode; source: FollowerTokenModeSource }> {
  // 恒强制：Settings GET 与 Worker B 运行时一致；不读 D1/env
  if (isFollowerTokenModeProgramForced()) {
    return { mode: resolveForcedFollowerTokenMode(), source: 'program' };
  }
  try {
    const row = await resolveIdentityDb(env)
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(FOLLOWER_TOKEN_MODE_CONFIG_KEY)
      .first<{ value: string }>();
    if (row?.value) {
      const mode = normalizeFollowerTokenMode(row.value);
      if (row.value.trim() !== mode) {
        await writeCanonicalModeIfNeeded(env, row.value, mode);
      }
      return { mode, source: 'd1' };
    }
  } catch (err) {
    console.error('[node-settings] 读 follower_token_mode 失败，回落 env', err);
  }
  return { mode: modeFromEnv(env), source: 'env' };
}

async function syncModeToKv(env: Env, mode: FollowerTokenMode): Promise<void> {
  await env.STATE_KV.put(FOLLOWER_TOKEN_MODE_KV_KEY, mode);
}

export const nodeSettingsApp = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** GET /api/node-settings/follower-token-mode */
nodeSettingsApp.get('/follower-token-mode', async (c) => {
  const { mode, source } = await readStoredMode(c.env);
  return c.json({ ok: true, data: { mode, source } });
});

/** PATCH /api/node-settings/follower-token-mode — body: { mode: canonical 五档 } */
nodeSettingsApp.patch('/follower-token-mode', async (c) => {
  // 程序恒强制：禁止站主改档（避免 D1/KV 与运行时漂移）
  if (isFollowerTokenModeProgramForced()) {
    return c.json(
      {
        ok: false,
        error_code: 'MODE_PROGRAM_LOCKED',
        message:
          '读帖保护已由程序恒强制为「读帖须凭证」（token-required），不可在设置中切换',
      },
      403,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '请求体必须为 JSON' }, 400);
  }

  const raw = typeof body.mode === 'string' ? body.mode.trim() : '';
  const mode = parseFollowerTokenModeForWrite(raw);
  if (!mode) {
    return c.json(
      {
        ok: false,
        error_code: 'INVALID_MODE',
        message: 'mode 必须为 public-read、token-required、following-only、mutual-only 或 owner-only',
      },
      400,
    );
  }
  const iso = nowIso();

  try {
    await resolveIdentityDb(c.env)
      .prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
      )
      .bind(FOLLOWER_TOKEN_MODE_CONFIG_KEY, mode, iso)
      .run();
    await syncModeToKv(c.env, mode);
  } catch (err) {
    console.error('[node-settings] 写入 follower_token_mode 失败', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '保存读帖保护模式失败，请重试' },
      500,
    );
  }

  return c.json({ ok: true, data: { mode, source: 'd1' as const } });
});

/** M17-2：加好友 inbox 开关（D1 system_config.friend_requests_inbox_enabled，默认 true） */
export const FRIEND_REQUESTS_INBOX_CONFIG_KEY = 'friend_requests_inbox_enabled';

async function readFriendRequestsAllowIncoming(env: Env): Promise<boolean> {
  try {
    const row = await resolveIdentityDb(env)
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(FRIEND_REQUESTS_INBOX_CONFIG_KEY)
      .first<{ value: string }>();
    const v = (row?.value ?? '').trim().toLowerCase();
    if (!v) return true;
    return v !== 'false' && v !== '0';
  } catch (err) {
    console.error('[node-settings] 读 friend_requests_inbox_enabled 失败，回落 true', err);
    return true;
  }
}

/** GET /api/node-settings/friend-requests */
nodeSettingsApp.get('/friend-requests', async (c) => {
  const allow_incoming = await readFriendRequestsAllowIncoming(c.env);
  return c.json({ ok: true, data: { allow_incoming } });
});

/** PATCH /api/node-settings/friend-requests — body: { allow_incoming: boolean } */
nodeSettingsApp.patch('/friend-requests', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '请求体必须为 JSON' }, 400);
  }
  if (typeof body.allow_incoming !== 'boolean') {
    return c.json(
      { ok: false, error_code: 'BAD_REQUEST', message: 'allow_incoming 必须为 boolean' },
      400,
    );
  }
  const value = body.allow_incoming ? 'true' : 'false';
  const iso = nowIso();
  try {
    await resolveIdentityDb(c.env)
      .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(FRIEND_REQUESTS_INBOX_CONFIG_KEY, value, iso)
      .run();
  } catch (err) {
    console.error('[node-settings] 写入 friend_requests_inbox_enabled 失败', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '保存加好友开关失败，请重试' },
      500,
    );
  }
  return c.json({ ok: true, data: { allow_incoming: body.allow_incoming } });
});

nodeSettingsApp.route('/media-storage', mediaStorageSettingsApp);

// V2-20：暴露 daily-sync 群号窗/锚点状态供 Settings 排障（JWT 鉴权；无敏感字段）
import { getConfigIntervalDays, getLastDailySyncReportedAt, readOwnerUserId } from '../lib/nodeSyncState';
/** GET /api/node-settings/group-lifecycle */
nodeSettingsApp.get('/group-lifecycle', async (c) => {
  const userId = await readOwnerUserId(c.env);
  if (!userId) {
    return c.json({ ok: true, data: { has_owner: false } });
  }
  const [config_interval_days, last_daily_sync_reported_at] = await Promise.all([
    getConfigIntervalDays(c.env, userId),
    getLastDailySyncReportedAt(c.env, userId),
  ]);
  return c.json({
    ok: true,
    data: {
      has_owner: true,
      // 缓存的中心 INTERVAL_DAYS；null = 未学（omit 中）
      config_interval_days,
      // 上次成功上报的 group_lifecycle.computed_at；null = 从未带块上报
      last_daily_sync_reported_at,
    },
  });
});
