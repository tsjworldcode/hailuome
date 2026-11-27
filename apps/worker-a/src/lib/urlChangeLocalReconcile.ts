/**
 * M7-30h-5：registry confirm 成功但本地 sync 失败时的 D1 reconcile 队列 + Cron 重试。
 * M7-30j-2：processing + lease_until 条件抢占，防重叠 Cron 双同步。
 */
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { syncLocalAfterUrlChangeConfirm } from '../handlers/registryUrlChange';

const MAX_ATTEMPTS = 8;
/** processing lease */
export const URL_CHANGE_RECONCILE_LEASE_MS = 120_000;

function isoNow(): string {
  return new Date().toISOString();
}

function computeNextAttempt(attempts: number): string {
  const minutes = Math.min(60, 2 ** Math.max(0, attempts));
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** confirm 路径：registry 已成功，本地 sync 失败时入队。 */
export async function enqueueUrlChangeLocalReconcile(
  env: Env,
  input: { url_change_id: string; node_url: string; worker_b_url: string; last_error: string },
): Promise<void> {
  const now = isoNow();
  // A-5c-2：url_change_local_reconcile 表在 IDENTITY_DB（migration 0049 IDENTITY 域）
  const identityDb = resolveIdentityDb(env);
  await identityDb.prepare(
    `INSERT INTO url_change_local_reconcile
       (url_change_id, node_url, worker_b_url, status, attempts, last_error, next_attempt_at, lease_until, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'pending', 0, ?4, ?5, NULL, ?6, ?6)
     ON CONFLICT(url_change_id) DO UPDATE SET
       node_url = excluded.node_url,
       worker_b_url = excluded.worker_b_url,
       status = 'pending',
       last_error = excluded.last_error,
       next_attempt_at = excluded.next_attempt_at,
       lease_until = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.url_change_id,
      input.node_url,
      input.worker_b_url,
      input.last_error.slice(0, 500),
      now,
      now,
    )
    .run();
}

async function claimReconcileRow(
  env: Env,
  urlChangeId: string,
  now: string,
  leaseUntil: string,
): Promise<boolean> {
  // A-5c-2：同上
  const identityDb = resolveIdentityDb(env);
  try {
    const result = await identityDb.prepare(
      `UPDATE url_change_local_reconcile
          SET status = 'processing', lease_until = ?2, updated_at = ?2
        WHERE url_change_id = ?1
          AND (
            (
              status = 'pending'
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)
            )
            OR (
              status = 'processing'
              AND lease_until IS NOT NULL
              AND lease_until < ?3
            )
          )`,
    )
      .bind(urlChangeId, leaseUntil, now)
      .run();
    return (result.meta.changes ?? 0) === 1;
  } catch (err) {
    console.warn('[urlChangeLocalReconcile] claim 失败', urlChangeId, err);
    return false;
  }
}

/** Cron：重试 pending reconcile（fail-soft 单条；M7-30j-2 claim）。 */
export async function retryUrlChangeLocalReconcile(env: Env): Promise<{ processed: number; ok: number }> {
  const now = isoNow();
  const leaseUntil = new Date(Date.now() + URL_CHANGE_RECONCILE_LEASE_MS).toISOString();
  // A-5c-2：同上
  const identityDb = resolveIdentityDb(env);
  const rows = await identityDb.prepare(
    `SELECT url_change_id, node_url, worker_b_url, attempts
       FROM url_change_local_reconcile
      WHERE (
          status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
        )
        OR (
          status = 'processing'
          AND lease_until IS NOT NULL
          AND lease_until < ?1
        )
      ORDER BY created_at ASC
      LIMIT 5`,
  )
    .bind(now)
    .all<{ url_change_id: string; node_url: string; worker_b_url: string; attempts: number }>();

  let ok = 0;
  let processed = 0;
  // A-5c-2：for 循环内两处 UPDATE 也走 identityDb（与上方解析共享变量；如担心并发竞态可每次 resolve）
  for (const row of rows.results ?? []) {
    const claimed = await claimReconcileRow(env, row.url_change_id, now, leaseUntil);
    if (!claimed) continue;
    processed += 1;
    try {
      await syncLocalAfterUrlChangeConfirm(env, {
        node_url: row.node_url,
        worker_b_url: row.worker_b_url,
        url_change_id: row.url_change_id,
      });
      await identityDb.prepare(
        `UPDATE url_change_local_reconcile
            SET status = 'done', lease_until = NULL, updated_at = ?2
          WHERE url_change_id = ?1`,
      )
        .bind(row.url_change_id, isoNow())
        .run();
      ok += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const msg = err instanceof Error ? err.message : String(err);
      const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'pending';
      await identityDb.prepare(
        `UPDATE url_change_local_reconcile
            SET status = ?2,
                attempts = ?3,
                last_error = ?4,
                next_attempt_at = ?5,
                lease_until = NULL,
                updated_at = ?6
          WHERE url_change_id = ?1`,
      )
        .bind(
          row.url_change_id,
          status,
          attempts,
          msg.slice(0, 500),
          status === 'pending' ? computeNextAttempt(attempts) : null,
          isoNow(),
        )
        .run();
    }
  }
  return { processed, ok };
}
