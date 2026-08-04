CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  action TEXT NOT NULL,
  repository TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'enqueueing',
      'queued',
      'sending',
      'dead_letter',
      'manual_review',
      'delivered'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_deliveries_recovery
  ON deliveries (status, next_attempt_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_deliveries_retention
  ON deliveries (status, delivered_at);

CREATE TABLE IF NOT EXISTS relay_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  next_slack_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO relay_state (singleton_id, next_slack_at)
VALUES (1, 0);
