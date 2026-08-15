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
  -- ADR §10 H39 (superseding H18's "migration 0010 is NOT edited for this"):
  -- the dispatcher owns ONE destination (§10 H2), and DISPATCH_CHANNELS knows
  -- only that one, so a schema-legal 'activity' row was a row every dispatcher
  -- query could return and no runtime path could serve. The CHECK is narrowed
  -- to the runtime's own set instead of scoping six queries around a row that
  -- should not exist. 0010 has never been applied (H3; re-verified live —
  -- d1_migrations on github-slack-alerts-db holds 0001..0009 only), so it is
  -- edited in place.
  destination TEXT NOT NULL CHECK (destination = 'alerts'),
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
  -- Same contract as SLACK_MESSAGE_TS_PATTERN (src/index.ts):
  -- /^\d{10,13}\.\d{6}$/ — 10-13 digits, one literal dot, exactly six
  -- digits. SQLite GLOB has no repetition ranges (and `*` matches ANY
  -- character sequence, so '1garbage.123456' satisfies a naive GLOB), so
  -- the format is composed from length + position + charset predicates:
  -- total length 17-20 => seconds length (total - 7) is 10-13; the 7th
  -- character from the right is the dot; the last 6 characters and the
  -- leading (total - 7) characters are digits only. Those three ranges
  -- partition every character of the value, so nothing is left unchecked.
  slack_message_ts TEXT CHECK (
    slack_message_ts IS NULL
    OR (
      length(slack_message_ts) BETWEEN 17 AND 20
      AND substr(slack_message_ts, -7, 1) = '.'
      AND substr(slack_message_ts, -6) NOT GLOB '*[^0-9]*'
      AND substr(slack_message_ts, 1, length(slack_message_ts) - 7)
        NOT GLOB '*[^0-9]*'
    )
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
-- non-delivered) are exempt by SQLite UNIQUE NULL semantics. With the H39
-- narrowing the pair carries one legal destination, so the index does the work
-- of UNIQUE(slack_message_ts) — which is exactly the property §6.4 names. The
-- column pair is kept: narrowing it is an unrequested change, and the pair is
-- what a restored second destination would need.
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

-- Copilot suppressed comment (F7) / ADR §4 item 4 (~1 msg/sec/channel):
-- durable per-destination send reservation for the dispatch path. Same
-- mechanism as the legacy relay_state.next_slack_at (src/store.ts
-- reserveSlackSlot) on the dispatcher's OWN table — the legacy tables stay
-- frozen (§6.8, R8). One row per destination; the consumer's upsert
-- self-heals a missing row, so no seed data is required. next_send_ms is in
-- milliseconds, like every other column of this migration (§6.4).
-- §10 H39: narrowed with dispatch_outbox for consistency of the pair. This
-- table was NOT part of the live class — every read and the upsert bind
-- `destination = ?` (src/dispatch/outbox.ts), so there is no unscoped query
-- here to poison. The residue was inert in both directions.
CREATE TABLE dispatch_rate_limit (
  destination TEXT PRIMARY KEY NOT NULL CHECK (destination = 'alerts'),
  next_send_ms INTEGER NOT NULL CHECK (next_send_ms >= 0)
);
