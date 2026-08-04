ALTER TABLE deliveries
ADD COLUMN destination TEXT NOT NULL DEFAULT 'alerts'
CHECK (destination IN ('alerts', 'activity'));

CREATE INDEX IF NOT EXISTS idx_deliveries_destination_status
  ON deliveries (destination, status, updated_at);
