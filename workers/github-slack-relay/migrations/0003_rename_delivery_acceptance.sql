CREATE TABLE deliveries_next (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  action TEXT NOT NULL,
  repository TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('alerts', 'activity')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'enqueueing',
      'queued',
      'sending',
      'dead_letter',
      'manual_review',
      'accepted_by_slack'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_at INTEGER
);

INSERT INTO deliveries_next (
  delivery_id,
  event_type,
  action,
  repository,
  destination,
  payload_json,
  status,
  attempt_count,
  next_attempt_at,
  last_error,
  created_at,
  updated_at,
  accepted_at
)
SELECT
  delivery_id,
  event_type,
  action,
  repository,
  destination,
  payload_json,
  CASE status
    WHEN 'delivered' THEN 'accepted_by_slack'
    ELSE status
  END,
  attempt_count,
  next_attempt_at,
  last_error,
  created_at,
  updated_at,
  delivered_at
FROM deliveries;

DROP TABLE deliveries;
ALTER TABLE deliveries_next RENAME TO deliveries;

CREATE INDEX idx_deliveries_recovery
  ON deliveries (status, next_attempt_at, updated_at);

CREATE INDEX idx_deliveries_retention
  ON deliveries (status, accepted_at);

CREATE INDEX idx_deliveries_destination_status
  ON deliveries (destination, status, updated_at);
