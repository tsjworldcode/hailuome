/**
 * M7-30-GROUP-URL：群相关表 old Worker B URL → new（幂等）。
 * SSOT：docs/m7-30-group-url-change-plan.md
 */
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { hasMessagingShard1 } from './messagingShard';

export type GroupUrlMigrateResult = {
  ok: true;
  oldUrl: string;
  newUrl: string;
  touched: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

async function runUpdate(
  db: D1Database,
  sql: string,
  ...binds: (string | number)[]
): Promise<number> {
  const result = await db.prepare(sql).bind(...binds).run();
  return Number(result.meta.changes ?? 0);
}

/**
 * 将 MESSAGING（及可选 shard）中所有命中 oldUrl 的群路由字段改为 newUrl。
 * old===new 或空 → no-op。
 */
export async function applyGroupUrlMigration(
  env: Env,
  oldRaw: string,
  newRaw: string,
): Promise<GroupUrlMigrateResult> {
  const oldUrl = normalizeGroupMemberUrl(oldRaw);
  const newUrl = normalizeGroupMemberUrl(newRaw);
  if (!oldUrl || !newUrl || oldUrl === newUrl) {
    return { ok: true, oldUrl, newUrl, touched: 0 };
  }

  const db = messagingDb(env);
  const now = nowIso();
  let touched = 0;

  touched += await runUpdate(
    db,
    `UPDATE groups SET owner_worker_b_url = ?, updated_at = ? WHERE owner_worker_b_url = ?`,
    newUrl,
    now,
    oldUrl,
  );

  // PK (group_id, member_worker_b_url)：若同群已有新址行，先删旧行
  {
    const { results: conflictGroups } = await db
      .prepare(`SELECT group_id FROM group_members WHERE member_worker_b_url = ?`)
      .bind(newUrl)
      .all<{ group_id: string }>();
    for (const g of conflictGroups ?? []) {
      await db
        .prepare(`DELETE FROM group_members WHERE group_id = ? AND member_worker_b_url = ?`)
        .bind(g.group_id, oldUrl)
        .run();
    }
  }
  touched += await runUpdate(
    db,
    `UPDATE group_members SET member_worker_b_url = ? WHERE member_worker_b_url = ?`,
    newUrl,
    oldUrl,
  );

  {
    const { results: conflictGroups } = await db
      .prepare(`SELECT group_id FROM group_pending_members WHERE member_worker_b_url = ?`)
      .bind(newUrl)
      .all<{ group_id: string }>();
    for (const g of conflictGroups ?? []) {
      await db
        .prepare(`DELETE FROM group_pending_members WHERE group_id = ? AND member_worker_b_url = ?`)
        .bind(g.group_id, oldUrl)
        .run();
    }
  }
  touched += await runUpdate(
    db,
    `UPDATE group_pending_members SET member_worker_b_url = ? WHERE member_worker_b_url = ?`,
    newUrl,
    oldUrl,
  );

  {
    const { results: conflictKeys } = await db
      .prepare(`SELECT group_id, epoch FROM group_wrapped_keys WHERE member_worker_b_url = ?`)
      .bind(newUrl)
      .all<{ group_id: string; epoch: number }>();
    for (const k of conflictKeys ?? []) {
      await db
        .prepare(
          `DELETE FROM group_wrapped_keys WHERE group_id = ? AND epoch = ? AND member_worker_b_url = ?`,
        )
        .bind(k.group_id, k.epoch, oldUrl)
        .run();
    }
  }
  touched += await runUpdate(
    db,
    `UPDATE group_wrapped_keys SET member_worker_b_url = ? WHERE member_worker_b_url = ?`,
    newUrl,
    oldUrl,
  );

  const { results: edges } = await db
    .prepare(
      `SELECT group_id, tree_id, parent_worker_b_url, child_worker_b_url
         FROM group_relay_edges
        WHERE parent_worker_b_url = ? OR child_worker_b_url = ?`,
    )
    .bind(oldUrl, oldUrl)
    .all<{
      group_id: string;
      tree_id: number;
      parent_worker_b_url: string;
      child_worker_b_url: string;
    }>();

  for (const edge of edges ?? []) {
    const parent =
      normalizeGroupMemberUrl(edge.parent_worker_b_url) === oldUrl
        ? newUrl
        : edge.parent_worker_b_url;
    const child =
      normalizeGroupMemberUrl(edge.child_worker_b_url) === oldUrl
        ? newUrl
        : edge.child_worker_b_url;
    await db
      .prepare(
        `DELETE FROM group_relay_edges
          WHERE group_id = ? AND tree_id = ?
            AND parent_worker_b_url = ? AND child_worker_b_url = ?`,
      )
      .bind(edge.group_id, edge.tree_id, edge.parent_worker_b_url, edge.child_worker_b_url)
      .run();
    if (parent === child) continue;
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO group_relay_edges
           (group_id, tree_id, parent_worker_b_url, child_worker_b_url)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(edge.group_id, edge.tree_id, parent, child)
      .run();
    touched += Number(inserted.meta.changes ?? 0);
  }

  touched += await runUpdate(
    db,
    `UPDATE group_sync_state SET parent_worker_b_url = ?, updated_at = ? WHERE parent_worker_b_url = ?`,
    newUrl,
    now,
    oldUrl,
  );

  touched += await runUpdate(
    db,
    `UPDATE group_outbox SET owner_worker_b_url = ?, updated_at = ? WHERE owner_worker_b_url = ?`,
    newUrl,
    now,
    oldUrl,
  );

  touched += await runUpdate(
    db,
    `UPDATE group_invites SET owner_worker_b_url = ? WHERE owner_worker_b_url = ?`,
    newUrl,
    oldUrl,
  );

  touched += await runUpdate(
    db,
    `UPDATE group_invites SET consumed_by_worker_b_url = ? WHERE consumed_by_worker_b_url = ?`,
    newUrl,
    oldUrl,
  );

  const msgDbs: D1Database[] = [db];
  if (hasMessagingShard1(env) && env.MESSAGING_SHARD_1) {
    msgDbs.push(env.MESSAGING_SHARD_1);
  }
  for (const msgDb of msgDbs) {
    for (const table of ['group_messages', 'member_group_messages'] as const) {
      touched += await runUpdate(
        msgDb,
        `UPDATE ${table} SET sender_worker_b_url = ? WHERE sender_worker_b_url = ?`,
        newUrl,
        oldUrl,
      );
    }
  }

  return { ok: true, oldUrl, newUrl, touched };
}
