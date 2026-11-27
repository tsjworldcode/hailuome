-- M14-3：互粉读帖证明 nonce 去重（防重放）
CREATE TABLE IF NOT EXISTS read_proof_nonces (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_worker_b_url TEXT NOT NULL,
  reader_worker_b_url TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(owner_worker_b_url, reader_worker_b_url, nonce)
);

CREATE INDEX IF NOT EXISTS idx_read_proof_nonces_created
  ON read_proof_nonces (created_at);
