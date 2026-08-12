-- Expand-only migration. Keep the previous Worker's accepted_at column and
-- accepted_by_slack value until a separately reviewed contract migration.
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
      'accepted_by_slack',
      'accepted_by_trigger',
      'send_started',
      'delivered'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_at INTEGER,
  trigger_accepted_at INTEGER,
  send_started_at INTEGER,
  delivered_at INTEGER,
  slack_message_ts TEXT,
  slack_trace_id TEXT,
  slack_send_execution_id TEXT CHECK (
    slack_send_execution_id IS NULL
    OR (
      length(slack_send_execution_id) BETWEEN 3 AND 128
      AND slack_send_execution_id GLOB 'Fx[A-Za-z0-9]*'
      AND slack_send_execution_id NOT GLOB '*[^A-Za-z0-9]*'
    )
  ),
  legacy_unverified INTEGER NOT NULL DEFAULT 0
    CHECK (legacy_unverified IN (0, 1)),
  CHECK (
    status != 'delivered'
    OR (delivered_at IS NOT NULL AND slack_message_ts IS NOT NULL)
  )
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
  accepted_at,
  trigger_accepted_at,
  legacy_unverified
)
SELECT
  delivery_id,
  event_type,
  action,
  repository,
  destination,
  payload_json,
  CASE
    WHEN delivery_id = 'de345e40-95b1-11f1-8d38-fac15f0bb4cd'
      THEN 'manual_review'
    ELSE status
  END ,
  attempt_count,
  next_attempt_at,
  CASE
    WHEN delivery_id = 'de345e40-95b1-11f1-8d38-fac15f0bb4cd'
      THEN 'known_slack_workflow_timeout_message_absent'
    ELSE last_error
  END ,
  created_at,
  updated_at,
  CASE WHEN status = 'accepted_by_slack' THEN NULL ELSE accepted_at END ,
  accepted_at,
  CASE WHEN status = 'accepted_by_slack' THEN 1 ELSE 0 END
FROM deliveries;

DROP TABLE deliveries;
ALTER TABLE deliveries_next RENAME TO deliveries;

CREATE INDEX idx_deliveries_recovery
  ON deliveries (status, next_attempt_at, updated_at);

CREATE INDEX idx_deliveries_retention
  ON deliveries (status, delivered_at);

CREATE INDEX idx_deliveries_destination_status
  ON deliveries (destination, status, updated_at);

CREATE UNIQUE INDEX idx_deliveries_slack_message
  ON deliveries (destination, slack_message_ts)
  WHERE slack_message_ts IS NOT NULL;

-- The previous Worker writes accepted_by_slack only after its trigger request
-- returns. Preserve that write contract during the expand window, but turn the
-- result into explicit unverified quarantine so the receipt-aware Worker can
-- never mistake it for destination proof or resend it blindly.
CREATE TRIGGER quarantine_old_worker_acceptance
AFTER UPDATE OF status ON deliveries
WHEN NEW.status = 'accepted_by_slack'
  AND NEW.legacy_unverified = 0
BEGIN
  UPDATE deliveries
  SET accepted_at = NULL,
      trigger_accepted_at = COALESCE(trigger_accepted_at, NEW.accepted_at),
      legacy_unverified = 1,
      last_error = 'legacy_old_worker_acceptance_quarantined'
  WHERE delivery_id = NEW.delivery_id
    AND status = 'accepted_by_slack';
END;

CREATE TABLE slack_workflow_traces (
  trace_id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'success', 'error')),
  relay_attempt INTEGER NOT NULL CHECK (relay_attempt > 0),
  send_execution_id TEXT CHECK (
    send_execution_id IS NULL
    OR (
      length(send_execution_id) BETWEEN 3 AND 128
      AND send_execution_id GLOB 'Fx[A-Za-z0-9]*'
      AND send_execution_id NOT GLOB '*[^A-Za-z0-9]*'
    )
  ),
  send_boundary_reached INTEGER NOT NULL DEFAULT 0
    CHECK (send_boundary_reached IN (0, 1)),
  pre_send_failure_proven INTEGER NOT NULL DEFAULT 0
    CHECK (pre_send_failure_proven IN (0, 1)),
  started_at_us INTEGER NOT NULL CHECK (started_at_us >= 0),
  completed_at_us INTEGER,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER,
  CHECK (send_boundary_reached = 0 OR pre_send_failure_proven = 0),
  CHECK (pre_send_failure_proven = 0 OR send_execution_id IS NOT NULL)
);

CREATE INDEX idx_slack_workflow_traces_delivery
  ON slack_workflow_traces (delivery_id, updated_at);

CREATE TABLE slack_delivery_recovery_audit (
  delivery_id TEXT PRIMARY KEY NOT NULL
    CHECK (delivery_id = 'de345e40-95b1-11f1-8d38-fac15f0bb4cd'),
  destination TEXT NOT NULL CHECK (destination = 'activity'),
  absence_proof_reference TEXT NOT NULL
    CHECK (
      length(absence_proof_reference) BETWEEN 71 AND 500
      AND substr(
        absence_proof_reference,
        1,
        length('https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-')
      ) = 'https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-'
      AND substr(
        absence_proof_reference,
        length('https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-') + 1
      ) NOT GLOB '*[^0-9]*'
    ),
  authorization_reference TEXT NOT NULL
    CHECK (
      length(authorization_reference) BETWEEN 71 AND 500
      AND substr(
        authorization_reference,
        1,
        length('https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-')
      ) = 'https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-'
      AND substr(
        authorization_reference,
        length('https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-') + 1
      ) NOT GLOB '*[^0-9]*'
      AND authorization_reference != absence_proof_reference
    ),
  absence_proof_sha256 TEXT NOT NULL
    CHECK (
      length(absence_proof_sha256) = 64
      AND absence_proof_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authorization_sha256 TEXT NOT NULL
    CHECK (
      length(authorization_sha256) = 64
      AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
      AND authorization_sha256 != absence_proof_sha256
    ),
  authorized_by TEXT NOT NULL
    CHECK (
      length(authorized_by) BETWEEN 1 AND 39
      AND authorized_by GLOB '[A-Za-z0-9]*'
      AND authorized_by NOT GLOB '*[^A-Za-z0-9-]*'
      AND substr(authorized_by, -1) GLOB '[A-Za-z0-9]'
    ),
  authorized_at INTEGER NOT NULL CHECK (authorized_at > 0),
  prior_status TEXT NOT NULL DEFAULT 'manual_review'
    CHECK (prior_status = 'manual_review'),
  prior_reason TEXT NOT NULL DEFAULT
    'known_slack_workflow_timeout_message_absent'
    CHECK (prior_reason = 'known_slack_workflow_timeout_message_absent'),
  released_at INTEGER NOT NULL
    CHECK (released_at > 0 AND released_at = authorized_at)
);

CREATE TRIGGER validate_known_slack_delivery_recovery
BEFORE INSERT ON slack_delivery_recovery_audit
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM deliveries
    WHERE delivery_id = NEW.delivery_id
      AND destination = NEW.destination
      AND status = 'manual_review'
      AND last_error = 'known_slack_workflow_timeout_message_absent'
      AND legacy_unverified = 1
  ) THEN RAISE(ABORT, 'known_loss_recovery_precondition_failed') END);
END;

CREATE TRIGGER release_known_slack_delivery_recovery
AFTER INSERT ON slack_delivery_recovery_audit
BEGIN
  UPDATE deliveries
  SET status = 'pending',
      next_attempt_at = NEW.authorized_at,
      updated_at = NEW.authorized_at,
      last_error = 'explicit_known_loss_recovery_authorized',
      legacy_unverified = 0
  WHERE delivery_id = NEW.delivery_id
    AND destination = NEW.destination
    AND status = 'manual_review'
    AND last_error = 'known_slack_workflow_timeout_message_absent'
    AND legacy_unverified = 1;

  SELECT (CASE WHEN changes() != 1
    THEN RAISE(ABORT, 'known_loss_recovery_compare_and_swap_failed') END);
END;

ALTER TABLE relay_state
ADD COLUMN slack_activity_checkpoint_us INTEGER NOT NULL DEFAULT 0
CHECK (slack_activity_checkpoint_us >= 0);

-- The expanded schema is deliberately inert. A later, authenticated rollout
-- step performs the sole allowed false -> true transition after the exact
-- Worker and Slack revisions have both been proven.
ALTER TABLE relay_state
ADD COLUMN slack_delivery_protocol_active INTEGER NOT NULL DEFAULT 0
CHECK (slack_delivery_protocol_active IN (0, 1));

ALTER TABLE relay_state
ADD COLUMN slack_delivery_protocol_revision TEXT
CHECK (
  slack_delivery_protocol_revision IS NULL
  OR (
    length(slack_delivery_protocol_revision) = 40
    AND slack_delivery_protocol_revision NOT GLOB '*[^0-9a-f]*'
  )
);

ALTER TABLE relay_state
ADD COLUMN slack_delivery_protocol_activated_at INTEGER
CHECK (
  slack_delivery_protocol_activated_at IS NULL
  OR slack_delivery_protocol_activated_at > 0
);

ALTER TABLE relay_state
ADD COLUMN slack_delivery_protocol_activation_id TEXT
CHECK (
  slack_delivery_protocol_activation_id IS NULL
  OR (
    length(slack_delivery_protocol_activation_id) = 64
    AND slack_delivery_protocol_activation_id NOT GLOB '*[^0-9a-f]*'
  )
);

ALTER TABLE relay_state
ADD COLUMN slack_delivery_protocol_schema_revision TEXT
CHECK (
  slack_delivery_protocol_schema_revision IS NULL
  OR slack_delivery_protocol_schema_revision = '0004_confirm_slack_delivery'
);

ALTER TABLE relay_state
ADD COLUMN slack_delivery_protocol_confirmation_open INTEGER NOT NULL DEFAULT 1
CHECK (slack_delivery_protocol_confirmation_open IN (0, 1));

CREATE TRIGGER enforce_one_way_slack_delivery_protocol_activation
BEFORE UPDATE OF
  slack_delivery_protocol_active,
  slack_delivery_protocol_revision,
  slack_delivery_protocol_activated_at,
  slack_delivery_protocol_activation_id,
  slack_delivery_protocol_schema_revision
ON relay_state
WHEN NOT (
  OLD.singleton_id = 1
  AND NEW.singleton_id = 1
  AND OLD.slack_delivery_protocol_active = 0
  AND OLD.slack_delivery_protocol_revision IS NULL
  AND OLD.slack_delivery_protocol_activated_at IS NULL
  AND OLD.slack_delivery_protocol_activation_id IS NULL
  AND OLD.slack_delivery_protocol_schema_revision IS NULL
  AND OLD.slack_delivery_protocol_confirmation_open = 1
  AND NEW.slack_delivery_protocol_active = 1
  AND NEW.slack_delivery_protocol_revision IS NOT NULL
  AND length(NEW.slack_delivery_protocol_revision) = 40
  AND NEW.slack_delivery_protocol_revision NOT GLOB '*[^0-9a-f]*'
  AND NEW.slack_delivery_protocol_activated_at > 0
  AND NEW.slack_delivery_protocol_activation_id IS NOT NULL
  AND length(NEW.slack_delivery_protocol_activation_id) = 64
  AND NEW.slack_delivery_protocol_activation_id NOT GLOB '*[^0-9a-f]*'
  AND NEW.slack_delivery_protocol_schema_revision =
    '0004_confirm_slack_delivery'
  AND NEW.slack_delivery_protocol_confirmation_open = 1
)
BEGIN
  SELECT RAISE(ABORT, 'slack_delivery_protocol_activation_is_one_way');
END;

-- The separately reviewed contract migration may close confirmation after the
-- rollout evidence is frozen. It cannot reopen the confirmation window or
-- alter any activation tuple field.
CREATE TRIGGER enforce_one_way_slack_delivery_protocol_confirmation
BEFORE UPDATE OF slack_delivery_protocol_confirmation_open ON relay_state
WHEN NOT (
  OLD.singleton_id = 1
  AND NEW.singleton_id = 1
  AND OLD.slack_delivery_protocol_active = 1
  AND NEW.slack_delivery_protocol_active = 1
  AND OLD.slack_delivery_protocol_confirmation_open = 1
  AND NEW.slack_delivery_protocol_confirmation_open = 0
  AND NEW.slack_delivery_protocol_revision =
    OLD.slack_delivery_protocol_revision
  AND NEW.slack_delivery_protocol_activated_at =
    OLD.slack_delivery_protocol_activated_at
  AND NEW.slack_delivery_protocol_activation_id =
    OLD.slack_delivery_protocol_activation_id
  AND NEW.slack_delivery_protocol_schema_revision =
    OLD.slack_delivery_protocol_schema_revision
)
BEGIN
  SELECT RAISE(ABORT, 'slack_delivery_protocol_confirmation_is_one_way');
END;
