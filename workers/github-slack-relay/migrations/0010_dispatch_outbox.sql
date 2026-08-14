-- ADR-001 (docs/adr/ADR-001-slack-dispatch-outbox.md) §6.4: additive outbox
-- dispatcher schema. Nothing in migrations 0001-0009 is altered; the legacy
-- tables stay frozen and readable (presence fence reads them forever).
-- One time unit everywhere: milliseconds. slack_message_ts is an opaque
-- Slack identifier, never arithmetic.
CREATE TABLE dispatch_outbox (
  delivery_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(delivery_id) BETWEEN 1 AND 128
    AND delivery_id NOT GLOB '*[^A-Za-z0-9-]*'
  ),
  destination TEXT NOT NULL CHECK (destination IN ('alerts', 'activity')),
  shadow INTEGER NOT NULL DEFAULT 0 CHECK (shadow IN (0, 1)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL CHECK (
    state IN (
      'queued',
      'sending',
      'ambiguous',
      'manual',
      'delivered',
      'dead_letter',
      'closed_manual'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  resolver_attempts INTEGER NOT NULL DEFAULT 0 CHECK (resolver_attempts >= 0),
  last_send_start_ms INTEGER CHECK (
    last_send_start_ms IS NULL OR last_send_start_ms > 0
  ),
  lease_until_ms INTEGER CHECK (lease_until_ms IS NULL OR lease_until_ms > 0),
  next_attempt_ms INTEGER CHECK (next_attempt_ms IS NULL OR next_attempt_ms > 0),
  verify_after_ms INTEGER CHECK (verify_after_ms IS NULL OR verify_after_ms > 0),
  verify_scans_remaining INTEGER NOT NULL DEFAULT 0 CHECK (
    verify_scans_remaining BETWEEN 0 AND 2
  ),
  slack_channel_id TEXT CHECK (
    slack_channel_id IS NULL
    OR (
      length(slack_channel_id) BETWEEN 9 AND 32
      AND slack_channel_id GLOB 'C*'
      AND slack_channel_id NOT GLOB '*[^A-Z0-9]*'
    )
  ),
  slack_message_ts TEXT CHECK (
    slack_message_ts IS NULL
    OR slack_message_ts GLOB '[0-9]*.[0-9][0-9][0-9][0-9][0-9][0-9]'
  ),
  last_error TEXT,
  created_ms INTEGER NOT NULL CHECK (created_ms > 0),
  updated_ms INTEGER NOT NULL CHECK (updated_ms >= created_ms),
  -- ADR §6.4 amended by §9.A1: a delivered row carries canonical proof (ts)
  -- unless it is a shadow row, which never performs Slack egress.
  CHECK (state != 'delivered' OR shadow = 1 OR slack_message_ts IS NOT NULL),
  -- Shadow rows never carry Slack identifiers (no egress ever happened).
  CHECK (
    shadow = 0 OR (slack_message_ts IS NULL AND slack_channel_id IS NULL)
  )
);

-- ADR §6.4: one real message per (destination, ts); NULL ts rows (shadow,
-- non-delivered) are exempt by SQLite UNIQUE NULL semantics.
CREATE UNIQUE INDEX idx_dispatch_outbox_destination_ts
  ON dispatch_outbox (destination, slack_message_ts);

-- Cron re-enqueue of stale queued rows + resolver scan of ambiguous rows +
-- /status per-state counters (ADR §6.3.1, §6.7, R13).
CREATE INDEX idx_dispatch_outbox_state
  ON dispatch_outbox (state, destination, updated_ms);

-- §6.3.3 post-resend verification scans: delivered rows re-enter the
-- resolver while verify_scans_remaining > 0.
CREATE INDEX idx_dispatch_outbox_verify
  ON dispatch_outbox (verify_after_ms)
  WHERE verify_scans_remaining > 0;

-- ADR §6.4: append-only audit of every transition, verdict and operator
-- action. delivery_id is NOT a foreign key on purpose: audit rows may
-- reference legacy GUIDs that never enter dispatch_outbox (ADR §6.9).
CREATE TABLE dispatch_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL CHECK (
    length(delivery_id) BETWEEN 1 AND 128
    AND delivery_id NOT GLOB '*[^A-Za-z0-9-]*'
  ),
  from_state TEXT NOT NULL CHECK (length(from_state) BETWEEN 1 AND 32),
  to_state TEXT NOT NULL CHECK (length(to_state) BETWEEN 1 AND 32),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  actor TEXT NOT NULL CHECK (
    actor IN ('ingress', 'consumer', 'resolver', 'cron', 'operator')
  ),
  at_ms INTEGER NOT NULL CHECK (at_ms > 0)
);

CREATE INDEX idx_dispatch_audit_delivery
  ON dispatch_audit (delivery_id, seq);
