-- One-time bridge for the reviewed live Slack receipt repair. The source SHA
-- is deliberately fixed so this cannot become a general revision bypass.
CREATE UNIQUE INDEX idx_deliveries_slack_send_execution
  ON deliveries (slack_send_execution_id)
  WHERE slack_send_execution_id IS NOT NULL;

ALTER TABLE slack_workflow_traces
ADD COLUMN slack_channel_id TEXT CHECK (
  slack_channel_id IS NULL OR slack_channel_id IN ('C0BMUK793NV', 'C0BMQMW3L4E')
);

ALTER TABLE slack_workflow_traces
ADD COLUMN slack_message_ts TEXT;

CREATE UNIQUE INDEX idx_slack_workflow_traces_send_execution
  ON slack_workflow_traces (send_execution_id)
  WHERE send_execution_id IS NOT NULL;

CREATE UNIQUE INDEX idx_slack_workflow_traces_message
  ON slack_workflow_traces (slack_channel_id, slack_message_ts)
  WHERE slack_message_ts IS NOT NULL;

DROP TRIGGER enforce_one_way_slack_delivery_protocol_activation;
DROP TRIGGER enforce_one_way_slack_delivery_protocol_confirmation;

-- Rebuild the singleton so the activated tuple can identify the new contract
-- without weakening the 0004 source constraint used by the deployed bridge.
CREATE TABLE relay_state_next (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  next_slack_at INTEGER NOT NULL DEFAULT 0,
  slack_activity_checkpoint_us INTEGER NOT NULL DEFAULT 0
    CHECK (slack_activity_checkpoint_us >= 0),
  slack_delivery_protocol_active INTEGER NOT NULL DEFAULT 0
    CHECK (slack_delivery_protocol_active IN (0, 1)),
  slack_delivery_protocol_revision TEXT CHECK (
    slack_delivery_protocol_revision IS NULL
    OR (
      length(slack_delivery_protocol_revision) = 40
      AND slack_delivery_protocol_revision NOT GLOB '*[^0-9a-f]*'
    )
  ),
  slack_delivery_protocol_activated_at INTEGER CHECK (
    slack_delivery_protocol_activated_at IS NULL
    OR slack_delivery_protocol_activated_at > 0
  ),
  slack_delivery_protocol_activation_id TEXT CHECK (
    slack_delivery_protocol_activation_id IS NULL
    OR (
      length(slack_delivery_protocol_activation_id) = 64
      AND slack_delivery_protocol_activation_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  slack_delivery_protocol_schema_revision TEXT CHECK (
    slack_delivery_protocol_schema_revision IS NULL
    OR slack_delivery_protocol_schema_revision IN (
      '0004_confirm_slack_delivery',
      '0005_reconcile_live_slack_receipts'
    )
  ),
  slack_delivery_protocol_confirmation_open INTEGER NOT NULL DEFAULT 1
    CHECK (slack_delivery_protocol_confirmation_open IN (0, 1))
);

INSERT INTO relay_state_next (
  singleton_id,
  next_slack_at,
  slack_activity_checkpoint_us,
  slack_delivery_protocol_active,
  slack_delivery_protocol_revision,
  slack_delivery_protocol_activated_at,
  slack_delivery_protocol_activation_id,
  slack_delivery_protocol_schema_revision,
  slack_delivery_protocol_confirmation_open
)
SELECT
  singleton_id,
  next_slack_at,
  slack_activity_checkpoint_us,
  slack_delivery_protocol_active,
  slack_delivery_protocol_revision,
  slack_delivery_protocol_activated_at,
  slack_delivery_protocol_activation_id,
  slack_delivery_protocol_schema_revision,
  slack_delivery_protocol_confirmation_open
FROM relay_state;

DROP TABLE relay_state;
ALTER TABLE relay_state_next RENAME TO relay_state;

CREATE TRIGGER enforce_one_time_slack_delivery_protocol_revision_bridge
BEFORE UPDATE OF
  slack_delivery_protocol_active,
  slack_delivery_protocol_revision,
  slack_delivery_protocol_activated_at,
  slack_delivery_protocol_activation_id,
  slack_delivery_protocol_schema_revision
ON relay_state
WHEN NOT (
  (
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
      '0005_reconcile_live_slack_receipts'
    AND NEW.slack_delivery_protocol_confirmation_open = 1
  )
  OR
  (
    OLD.singleton_id = 1
    AND NEW.singleton_id = 1
    AND OLD.slack_delivery_protocol_active = 1
    AND NEW.slack_delivery_protocol_active = 1
    AND OLD.slack_delivery_protocol_revision =
      'afe5250504d37543845b07f44af7bfc30a548feb'
    AND NEW.slack_delivery_protocol_revision IS NOT NULL
    AND NEW.slack_delivery_protocol_revision !=
      OLD.slack_delivery_protocol_revision
    AND length(NEW.slack_delivery_protocol_revision) = 40
    AND NEW.slack_delivery_protocol_revision NOT GLOB '*[^0-9a-f]*'
    AND OLD.slack_delivery_protocol_activated_at > 0
    AND NEW.slack_delivery_protocol_activated_at >
      OLD.slack_delivery_protocol_activated_at
    AND OLD.slack_delivery_protocol_activation_id IS NOT NULL
    AND NEW.slack_delivery_protocol_activation_id IS NOT NULL
    AND NEW.slack_delivery_protocol_activation_id !=
      OLD.slack_delivery_protocol_activation_id
    AND length(NEW.slack_delivery_protocol_activation_id) = 64
    AND NEW.slack_delivery_protocol_activation_id NOT GLOB '*[^0-9a-f]*'
    AND OLD.slack_delivery_protocol_schema_revision =
      '0004_confirm_slack_delivery'
    AND NEW.slack_delivery_protocol_schema_revision =
      '0005_reconcile_live_slack_receipts'
    AND OLD.slack_delivery_protocol_confirmation_open = 1
    AND NEW.slack_delivery_protocol_confirmation_open = 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'slack_delivery_protocol_activation_is_one_way');
END;

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
