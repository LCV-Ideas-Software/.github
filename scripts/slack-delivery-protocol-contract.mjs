import { pathToFileURL } from "node:url";

import {
  exactSlackDeliveryProtocolGuardDefinitions,
  SEALED_SLACK_DELIVERY_PROTOCOL_GUARDS,
} from "../workers/github-slack-relay/src/slack-delivery-protocol-guards.ts";

const MAX_INPUT_BYTES = 1_000_000;
export const SEALED_PROTOCOL_REVISION =
  "e0131a758123cf210d9cc9e7e537b72dc0441a90";
export const SEALED_PROTOCOL_ACTIVATED_AT = 1_786_579_752_661;
export const SEALED_PROTOCOL_ACTIVATION_ID =
  "18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7";
export const SEALED_PROTOCOL_SCHEMA_REVISION =
  "0005_reconcile_live_slack_receipts";
export const SEALED_PROTOCOL_MIGRATION =
  "0006_seal_slack_delivery_protocol.sql";

const EXPECTED_ROW_KEYS = [
  "duplicate_delivery_execution_id_groups",
  "duplicate_slack_trace_execution_id_groups",
  "sealed_delete_guard_sql",
  "relay_state_guard_trigger_count",
  "sealed_insert_guard_sql",
  "sealed_migration_count",
  "sealed_update_guard_sql",
  "slack_delivery_protocol_active",
  "slack_delivery_protocol_activated_at",
  "slack_delivery_protocol_activation_id",
  "slack_delivery_protocol_confirmation_open",
  "slack_delivery_protocol_revision",
  "slack_delivery_protocol_schema_revision",
  "transient_guard_trigger_count",
].sort();

export const SLACK_DELIVERY_PROTOCOL_CONTRACT_SQL = [
  "SELECT slack_delivery_protocol_active, slack_delivery_protocol_revision, slack_delivery_protocol_activated_at, slack_delivery_protocol_activation_id, slack_delivery_protocol_schema_revision, slack_delivery_protocol_confirmation_open,",
  "(SELECT COUNT(*) FROM (SELECT slack_send_execution_id FROM deliveries WHERE slack_send_execution_id IS NOT NULL GROUP BY slack_send_execution_id HAVING COUNT(*) > 1)) AS duplicate_delivery_execution_id_groups,",
  "(SELECT COUNT(*) FROM (SELECT send_execution_id FROM slack_workflow_traces WHERE send_execution_id IS NOT NULL GROUP BY send_execution_id HAVING COUNT(*) > 1)) AS duplicate_slack_trace_execution_id_groups,",
  "(SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'relay_state') AS relay_state_guard_trigger_count,",
  "(SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'relay_state' AND name = 'enforce_sealed_slack_delivery_protocol_delete') AS sealed_delete_guard_sql,",
  "(SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'relay_state' AND name = 'enforce_sealed_slack_delivery_protocol_insert') AS sealed_insert_guard_sql,",
  "(SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'relay_state' AND name = 'enforce_sealed_slack_delivery_protocol_update') AS sealed_update_guard_sql,",
  "(SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name IN ('enforce_one_time_slack_delivery_protocol_revision_bridge', 'enforce_one_way_slack_delivery_protocol_confirmation')) AS transient_guard_trigger_count,",
  "(SELECT COUNT(*) FROM d1_migrations WHERE name = '0006_seal_slack_delivery_protocol.sql') AS sealed_migration_count",
  "FROM relay_state WHERE singleton_id = 1",
].join(" ");

function fail(reason) {
  throw new Error(`Slack delivery protocol sealed contract ${reason}.`);
}

function plainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function validateSlackDeliveryProtocolContract(source) {
  if (
    typeof source !== "string" ||
    source === "" ||
    Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES
  ) {
    fail("received missing or oversized D1 output");
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("received malformed D1 JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !plainObject(parsed[0]) ||
    parsed[0].success !== true ||
    !Array.isArray(parsed[0].results) ||
    parsed[0].results.length !== 1 ||
    !plainObject(parsed[0].results[0])
  ) {
    fail("received an incomplete D1 result");
  }

  const row = parsed[0].results[0];
  if (
    JSON.stringify(Object.keys(row).sort()) !==
    JSON.stringify(EXPECTED_ROW_KEYS)
  ) {
    fail("received an unexpected D1 row shape");
  }
  for (const key of [
    "duplicate_delivery_execution_id_groups",
    "duplicate_slack_trace_execution_id_groups",
    "relay_state_guard_trigger_count",
    "transient_guard_trigger_count",
    "sealed_migration_count",
  ]) {
    if (!Number.isSafeInteger(row[key]) || row[key] < 0) {
      fail(`received a malformed ${key}`);
    }
  }
  if (
    row.duplicate_delivery_execution_id_groups !== 0 ||
    row.duplicate_slack_trace_execution_id_groups !== 0
  ) {
    fail("found duplicate Slack function execution owners");
  }
  if (
    row.relay_state_guard_trigger_count !== 3 ||
    row.transient_guard_trigger_count !== 0 ||
    row.sealed_migration_count !== 1
  ) {
    fail("found an incomplete sealed schema inventory");
  }
  if (
    !exactSlackDeliveryProtocolGuardDefinitions(
      [
        {
          name: "enforce_sealed_slack_delivery_protocol_delete",
          tbl_name: "relay_state",
          sql: row.sealed_delete_guard_sql,
        },
        {
          name: "enforce_sealed_slack_delivery_protocol_insert",
          tbl_name: "relay_state",
          sql: row.sealed_insert_guard_sql,
        },
        {
          name: "enforce_sealed_slack_delivery_protocol_update",
          tbl_name: "relay_state",
          sql: row.sealed_update_guard_sql,
        },
      ],
      SEALED_SLACK_DELIVERY_PROTOCOL_GUARDS,
    )
  ) {
    fail("found altered sealed guard definitions");
  }
  if (
    row.slack_delivery_protocol_active !== 1 ||
    row.slack_delivery_protocol_revision !== SEALED_PROTOCOL_REVISION ||
    row.slack_delivery_protocol_activated_at !==
      SEALED_PROTOCOL_ACTIVATED_AT ||
    row.slack_delivery_protocol_activation_id !==
      SEALED_PROTOCOL_ACTIVATION_ID ||
    row.slack_delivery_protocol_schema_revision !==
      SEALED_PROTOCOL_SCHEMA_REVISION ||
    row.slack_delivery_protocol_confirmation_open !== 0
  ) {
    fail("found a tuple that is not the reviewed historical seal");
  }
  return Object.freeze({ state: "sealed_exact_contract" });
}

async function readBoundedStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) {
      fail("received oversized D1 output");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--print-sql") {
      process.stdout.write(`${SLACK_DELIVERY_PROTOCOL_CONTRACT_SQL}\n`);
      process.exit(0);
    }
    if (process.argv.length !== 2) {
      fail("received unsupported command-line arguments");
    }
    const result = validateSlackDeliveryProtocolContract(
      await readBoundedStdin(),
    );
    console.log(`Slack delivery protocol contract: ${result.state}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed closed";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
