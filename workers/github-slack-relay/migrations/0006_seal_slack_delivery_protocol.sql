-- Permanently seal the one-shot Slack delivery protocol activation.
--
-- This migration deliberately accepts only the exact tuple observed in
-- production after the successful recovery rollout. A second execution is a
-- no-op only when D1 has already recorded this migration and the tuple is
-- still exactly sealed. D1 applies each migration transactionally, so a guard
-- failure rolls every statement in this file back together.

CREATE TABLE slack_delivery_protocol_seal_check (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  state_verified INTEGER NOT NULL CHECK (state_verified = 1)
);

INSERT INTO slack_delivery_protocol_seal_check (
  singleton_id,
  state_verified
)
VALUES (
  1,
  CASE WHEN (
    EXISTS (
      SELECT 1
      FROM relay_state
      WHERE singleton_id = 1
        AND slack_delivery_protocol_active = 1
        AND slack_delivery_protocol_revision =
          'e0131a758123cf210d9cc9e7e537b72dc0441a90'
        AND slack_delivery_protocol_activated_at = 1786579752661
        AND slack_delivery_protocol_activation_id =
          '18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7'
        AND slack_delivery_protocol_schema_revision =
          '0005_reconcile_live_slack_receipts'
        AND slack_delivery_protocol_confirmation_open = 1
    )
    AND (
      SELECT COUNT(*)
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name = 'relay_state'
    ) = 2
    AND EXISTS (
      SELECT 1
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name =
          'enforce_one_time_slack_delivery_protocol_revision_bridge'
        AND tbl_name = 'relay_state'
        AND sql = 'CREATE TRIGGER enforce_one_time_slack_delivery_protocol_revision_bridge
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
    AND NEW.slack_delivery_protocol_revision NOT GLOB ''*[^0-9a-f]*''
    AND NEW.slack_delivery_protocol_activated_at > 0
    AND NEW.slack_delivery_protocol_activation_id IS NOT NULL
    AND length(NEW.slack_delivery_protocol_activation_id) = 64
    AND NEW.slack_delivery_protocol_activation_id NOT GLOB ''*[^0-9a-f]*''
    AND NEW.slack_delivery_protocol_schema_revision =
      ''0005_reconcile_live_slack_receipts''
    AND NEW.slack_delivery_protocol_confirmation_open = 1
  )
  OR
  (
    OLD.singleton_id = 1
    AND NEW.singleton_id = 1
    AND OLD.slack_delivery_protocol_active = 1
    AND NEW.slack_delivery_protocol_active = 1
    AND OLD.slack_delivery_protocol_revision =
      ''afe5250504d37543845b07f44af7bfc30a548feb''
    AND NEW.slack_delivery_protocol_revision IS NOT NULL
    AND NEW.slack_delivery_protocol_revision !=
      OLD.slack_delivery_protocol_revision
    AND length(NEW.slack_delivery_protocol_revision) = 40
    AND NEW.slack_delivery_protocol_revision NOT GLOB ''*[^0-9a-f]*''
    AND OLD.slack_delivery_protocol_activated_at > 0
    AND NEW.slack_delivery_protocol_activated_at >
      OLD.slack_delivery_protocol_activated_at
    AND OLD.slack_delivery_protocol_activation_id IS NOT NULL
    AND NEW.slack_delivery_protocol_activation_id IS NOT NULL
    AND NEW.slack_delivery_protocol_activation_id !=
      OLD.slack_delivery_protocol_activation_id
    AND length(NEW.slack_delivery_protocol_activation_id) = 64
    AND NEW.slack_delivery_protocol_activation_id NOT GLOB ''*[^0-9a-f]*''
    AND OLD.slack_delivery_protocol_schema_revision =
      ''0004_confirm_slack_delivery''
    AND NEW.slack_delivery_protocol_schema_revision =
      ''0005_reconcile_live_slack_receipts''
    AND OLD.slack_delivery_protocol_confirmation_open = 1
    AND NEW.slack_delivery_protocol_confirmation_open = 1
  )
)
BEGIN
  SELECT RAISE(ABORT, ''slack_delivery_protocol_activation_is_one_way'');
END'
    )
    AND EXISTS (
      SELECT 1
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name =
          'enforce_one_way_slack_delivery_protocol_confirmation'
        AND tbl_name = 'relay_state'
        AND sql = 'CREATE TRIGGER enforce_one_way_slack_delivery_protocol_confirmation
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
  SELECT RAISE(ABORT, ''slack_delivery_protocol_confirmation_is_one_way'');
END'
    )
    AND (
      SELECT COUNT(*)
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name IN (
          'enforce_sealed_slack_delivery_protocol_update',
          'enforce_sealed_slack_delivery_protocol_delete',
          'enforce_sealed_slack_delivery_protocol_insert'
        )
    ) = 0
    OR (
      EXISTS (
        SELECT 1
        FROM relay_state
        WHERE singleton_id = 1
          AND slack_delivery_protocol_active = 1
          AND slack_delivery_protocol_revision =
            'e0131a758123cf210d9cc9e7e537b72dc0441a90'
          AND slack_delivery_protocol_activated_at = 1786579752661
          AND slack_delivery_protocol_activation_id =
            '18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7'
          AND slack_delivery_protocol_schema_revision =
            '0005_reconcile_live_slack_receipts'
          AND slack_delivery_protocol_confirmation_open = 0
      )
      AND EXISTS (
        SELECT 1
        FROM d1_migrations
        WHERE name = '0006_seal_slack_delivery_protocol.sql'
      )
      AND (
        SELECT COUNT(*)
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND tbl_name = 'relay_state'
      ) = 3
      AND EXISTS (
        SELECT 1 FROM sqlite_schema
        WHERE type = 'trigger'
          AND name = 'enforce_sealed_slack_delivery_protocol_delete'
          AND tbl_name = 'relay_state'
          AND sql = 'CREATE TRIGGER enforce_sealed_slack_delivery_protocol_delete
BEFORE DELETE ON relay_state
WHEN OLD.singleton_id = 1
BEGIN
  SELECT RAISE(ABORT, ''slack_delivery_protocol_is_sealed'');
END'
      )
      AND EXISTS (
        SELECT 1 FROM sqlite_schema
        WHERE type = 'trigger'
          AND name = 'enforce_sealed_slack_delivery_protocol_insert'
          AND tbl_name = 'relay_state'
          AND sql = 'CREATE TRIGGER enforce_sealed_slack_delivery_protocol_insert
BEFORE INSERT ON relay_state
WHEN NEW.singleton_id = 1
BEGIN
  SELECT RAISE(ABORT, ''slack_delivery_protocol_is_sealed'');
END'
      )
      AND EXISTS (
        SELECT 1 FROM sqlite_schema
        WHERE type = 'trigger'
          AND name = 'enforce_sealed_slack_delivery_protocol_update'
          AND tbl_name = 'relay_state'
          AND sql = 'CREATE TRIGGER enforce_sealed_slack_delivery_protocol_update
BEFORE UPDATE ON relay_state
WHEN OLD.singleton_id = 1
AND (
  NEW.singleton_id IS NOT 1
  OR NEW.slack_delivery_protocol_active IS NOT 1
  OR NEW.slack_delivery_protocol_revision IS NOT
    ''e0131a758123cf210d9cc9e7e537b72dc0441a90''
  OR NEW.slack_delivery_protocol_activated_at IS NOT 1786579752661
  OR NEW.slack_delivery_protocol_activation_id IS NOT
    ''18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7''
  OR NEW.slack_delivery_protocol_schema_revision IS NOT
    ''0005_reconcile_live_slack_receipts''
  OR NEW.slack_delivery_protocol_confirmation_open IS NOT 0
)
BEGIN
  SELECT RAISE(ABORT, ''slack_delivery_protocol_is_sealed'');
END'
      )
    )
  ) THEN 1 ELSE 0 END
);

UPDATE relay_state
SET slack_delivery_protocol_confirmation_open = 0
WHERE singleton_id = 1
  AND slack_delivery_protocol_active = 1
  AND slack_delivery_protocol_revision =
    'e0131a758123cf210d9cc9e7e537b72dc0441a90'
  AND slack_delivery_protocol_activated_at = 1786579752661
  AND slack_delivery_protocol_activation_id =
    '18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7'
  AND slack_delivery_protocol_schema_revision =
    '0005_reconcile_live_slack_receipts'
  AND slack_delivery_protocol_confirmation_open = 1;

UPDATE slack_delivery_protocol_seal_check
SET state_verified = CASE WHEN EXISTS (
  SELECT 1
  FROM relay_state
  WHERE singleton_id = 1
    AND slack_delivery_protocol_active = 1
    AND slack_delivery_protocol_revision =
      'e0131a758123cf210d9cc9e7e537b72dc0441a90'
    AND slack_delivery_protocol_activated_at = 1786579752661
    AND slack_delivery_protocol_activation_id =
      '18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7'
    AND slack_delivery_protocol_schema_revision =
      '0005_reconcile_live_slack_receipts'
    AND slack_delivery_protocol_confirmation_open = 0
) THEN 1 ELSE 0 END
WHERE singleton_id = 1;

-- The source check above proves the exact transient/final guard inventory for
-- either the first application or an explicitly ledger-backed direct replay.
-- IF EXISTS is therefore an execution convenience, not a way to hide drift.
DROP TRIGGER IF EXISTS enforce_one_time_slack_delivery_protocol_revision_bridge;
DROP TRIGGER IF EXISTS enforce_one_way_slack_delivery_protocol_confirmation;

DROP TRIGGER IF EXISTS enforce_sealed_slack_delivery_protocol_update;
DROP TRIGGER IF EXISTS enforce_sealed_slack_delivery_protocol_delete;
DROP TRIGGER IF EXISTS enforce_sealed_slack_delivery_protocol_insert;

CREATE TRIGGER enforce_sealed_slack_delivery_protocol_update
BEFORE UPDATE ON relay_state
WHEN OLD.singleton_id = 1
AND (
  NEW.singleton_id IS NOT 1
  OR NEW.slack_delivery_protocol_active IS NOT 1
  OR NEW.slack_delivery_protocol_revision IS NOT
    'e0131a758123cf210d9cc9e7e537b72dc0441a90'
  OR NEW.slack_delivery_protocol_activated_at IS NOT 1786579752661
  OR NEW.slack_delivery_protocol_activation_id IS NOT
    '18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7'
  OR NEW.slack_delivery_protocol_schema_revision IS NOT
    '0005_reconcile_live_slack_receipts'
  OR NEW.slack_delivery_protocol_confirmation_open IS NOT 0
)
BEGIN
  SELECT RAISE(ABORT, 'slack_delivery_protocol_is_sealed');
END;

CREATE TRIGGER enforce_sealed_slack_delivery_protocol_delete
BEFORE DELETE ON relay_state
WHEN OLD.singleton_id = 1
BEGIN
  SELECT RAISE(ABORT, 'slack_delivery_protocol_is_sealed');
END;

CREATE TRIGGER enforce_sealed_slack_delivery_protocol_insert
BEFORE INSERT ON relay_state
WHEN NEW.singleton_id = 1
BEGIN
  SELECT RAISE(ABORT, 'slack_delivery_protocol_is_sealed');
END;

UPDATE slack_delivery_protocol_seal_check
SET state_verified = CASE WHEN (
  (SELECT COUNT(*) FROM sqlite_schema
   WHERE type = 'trigger'
     AND tbl_name = 'relay_state') = 3
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'enforce_sealed_slack_delivery_protocol_delete'
      AND tbl_name = 'relay_state'
      AND sql = 'CREATE TRIGGER enforce_sealed_slack_delivery_protocol_delete
BEFORE DELETE ON relay_state
WHEN OLD.singleton_id = 1
BEGIN
  SELECT RAISE(ABORT, ''slack_delivery_protocol_is_sealed'');
END'
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'enforce_sealed_slack_delivery_protocol_insert'
      AND tbl_name = 'relay_state'
      AND sql = 'CREATE TRIGGER enforce_sealed_slack_delivery_protocol_insert
BEFORE INSERT ON relay_state
WHEN NEW.singleton_id = 1
BEGIN
  SELECT RAISE(ABORT, ''slack_delivery_protocol_is_sealed'');
END'
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'enforce_sealed_slack_delivery_protocol_update'
      AND tbl_name = 'relay_state'
      AND sql = 'CREATE TRIGGER enforce_sealed_slack_delivery_protocol_update
BEFORE UPDATE ON relay_state
WHEN OLD.singleton_id = 1
AND (
  NEW.singleton_id IS NOT 1
  OR NEW.slack_delivery_protocol_active IS NOT 1
  OR NEW.slack_delivery_protocol_revision IS NOT
    ''e0131a758123cf210d9cc9e7e537b72dc0441a90''
  OR NEW.slack_delivery_protocol_activated_at IS NOT 1786579752661
  OR NEW.slack_delivery_protocol_activation_id IS NOT
    ''18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7''
  OR NEW.slack_delivery_protocol_schema_revision IS NOT
    ''0005_reconcile_live_slack_receipts''
  OR NEW.slack_delivery_protocol_confirmation_open IS NOT 0
)
BEGIN
  SELECT RAISE(ABORT, ''slack_delivery_protocol_is_sealed'');
END'
  )
) THEN 1 ELSE 0 END
WHERE singleton_id = 1;

DROP TABLE slack_delivery_protocol_seal_check;
