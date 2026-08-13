export interface SlackDeliveryProtocolGuardDefinition {
  readonly name: string;
  readonly tableName: "relay_state";
  readonly schemaSql: string;
}

export const TRANSIENT_SLACK_DELIVERY_PROTOCOL_GUARDS = Object.freeze([
  Object.freeze({
    name: "enforce_one_time_slack_delivery_protocol_revision_bridge",
    tableName: "relay_state" as const,
    schemaSql: `CREATE TRIGGER enforce_one_time_slack_delivery_protocol_revision_bridge
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
END`,
  }),
  Object.freeze({
    name: "enforce_one_way_slack_delivery_protocol_confirmation",
    tableName: "relay_state" as const,
    schemaSql: `CREATE TRIGGER enforce_one_way_slack_delivery_protocol_confirmation
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
END`,
  }),
] satisfies readonly SlackDeliveryProtocolGuardDefinition[]);

export const SEALED_SLACK_DELIVERY_PROTOCOL_GUARDS = Object.freeze([
  Object.freeze({
    name: "enforce_sealed_slack_delivery_protocol_delete",
    tableName: "relay_state" as const,
    schemaSql: `CREATE TRIGGER enforce_sealed_slack_delivery_protocol_delete
BEFORE DELETE ON relay_state
WHEN OLD.singleton_id = 1
BEGIN
  SELECT RAISE(ABORT, 'slack_delivery_protocol_is_sealed');
END`,
  }),
  Object.freeze({
    name: "enforce_sealed_slack_delivery_protocol_insert",
    tableName: "relay_state" as const,
    schemaSql: `CREATE TRIGGER enforce_sealed_slack_delivery_protocol_insert
BEFORE INSERT ON relay_state
WHEN NEW.singleton_id = 1
BEGIN
  SELECT RAISE(ABORT, 'slack_delivery_protocol_is_sealed');
END`,
  }),
  Object.freeze({
    name: "enforce_sealed_slack_delivery_protocol_update",
    tableName: "relay_state" as const,
    schemaSql: `CREATE TRIGGER enforce_sealed_slack_delivery_protocol_update
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
END`,
  }),
] satisfies readonly SlackDeliveryProtocolGuardDefinition[]);

export function exactSlackDeliveryProtocolGuardDefinitions(
  rows: readonly {
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }[],
  expected: readonly SlackDeliveryProtocolGuardDefinition[],
): boolean {
  if (rows.length !== expected.length) return false;
  const orderedRows = [...rows].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const orderedExpected = [...expected].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return orderedExpected.every((definition, index) => {
    const row = orderedRows[index];
    return row !== undefined &&
      row.name === definition.name &&
      row.tbl_name === definition.tableName &&
      row.sql === definition.schemaSql;
  });
}
