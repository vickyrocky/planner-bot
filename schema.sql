CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,             -- short code shown in chat, e.g. K7
  enc TEXT NOT NULL,              -- AES-GCM encrypted task text (base64 of iv + ciphertext)
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' or 'done'
  created_at INTEGER NOT NULL,    -- ms since epoch
  closed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
