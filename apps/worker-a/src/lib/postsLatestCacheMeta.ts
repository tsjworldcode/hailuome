/**
 * M13-18：posts 公开缓存元数据（IDENTITY `system_config`）同库合批清除。
 *
 * - D1 API：两句 UPDATE 合 1 次 `batch`（减往返，不减日行写）
 * - 行写：仍 2 行；失败整批回滚，保留 dirty 供补刷
 * - 禁止与 CONTENT_DB / 其它 binding 的 prepare 混进同一 batch
 */

/** 构造同库两句 UPDATE；调用方必须传入 IDENTITY 物理库。 */
export function preparePostsLatestCacheMetaClearStatements(
  identityDb: D1Database,
  nowIso: string,
): D1PreparedStatement[] {
  return [
    identityDb
      .prepare(
        `UPDATE system_config SET value = 'false', updated_at = ?
          WHERE key = 'posts_latest_dirty'`,
      )
      .bind(nowIso),
    identityDb
      .prepare(
        `UPDATE system_config SET value = ?, updated_at = ?
          WHERE key = 'posts_latest_last_refresh_at'`,
      )
      .bind(nowIso, nowIso),
  ];
}

/** 清 dirty + 写 last_refresh_at；同库 batch 原子。 */
export async function clearPostsLatestCacheMeta(
  identityDb: D1Database,
  nowIso: string,
): Promise<D1Result[]> {
  return identityDb.batch(preparePostsLatestCacheMetaClearStatements(identityDb, nowIso));
}
