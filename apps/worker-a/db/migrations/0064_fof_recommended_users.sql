-- M17-4-2b：好友的好友（FoF）推荐缓存（DB_IMPORT / 全表目录镜像）
CREATE TABLE IF NOT EXISTS fof_recommended_users (
  node_url TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  worker_b_url TEXT NOT NULL,
  mutual_count INTEGER NOT NULL DEFAULT 1 CHECK (mutual_count >= 1),
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fof_recommended_mutual
  ON fof_recommended_users (mutual_count DESC, fetched_at DESC);
