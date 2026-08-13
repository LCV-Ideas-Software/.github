import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SEALED_PROTOCOL_ACTIVATED_AT,
  SEALED_PROTOCOL_ACTIVATION_ID,
  SEALED_PROTOCOL_MIGRATION,
  SEALED_PROTOCOL_REVISION,
  SEALED_PROTOCOL_SCHEMA_REVISION,
  SLACK_DELIVERY_PROTOCOL_CONTRACT_SQL,
  validateSlackDeliveryProtocolContract,
} from "./slack-delivery-protocol-contract.mjs";
import { SEALED_SLACK_DELIVERY_PROTOCOL_GUARDS } from "../workers/github-slack-relay/src/slack-delivery-protocol-guards.ts";

const migrationsDirectory = "workers/github-slack-relay/migrations";
const sealedGuardSql = Object.fromEntries(
  SEALED_SLACK_DELIVERY_PROTOCOL_GUARDS.map(({ name, schemaSql }) => [
    name,
    schemaSql,
  ]),
);

function output(overrides = {}) {
  return JSON.stringify([
    {
      success: true,
      results: [
        {
          slack_delivery_protocol_active: 1,
          slack_delivery_protocol_revision: SEALED_PROTOCOL_REVISION,
          slack_delivery_protocol_activated_at: SEALED_PROTOCOL_ACTIVATED_AT,
          slack_delivery_protocol_activation_id:
            SEALED_PROTOCOL_ACTIVATION_ID,
          slack_delivery_protocol_schema_revision:
            SEALED_PROTOCOL_SCHEMA_REVISION,
          slack_delivery_protocol_confirmation_open: 0,
          duplicate_delivery_execution_id_groups: 0,
          duplicate_slack_trace_execution_id_groups: 0,
          relay_state_guard_trigger_count: 3,
          sealed_delete_guard_sql:
            sealedGuardSql.enforce_sealed_slack_delivery_protocol_delete,
          sealed_insert_guard_sql:
            sealedGuardSql.enforce_sealed_slack_delivery_protocol_insert,
          sealed_update_guard_sql:
            sealedGuardSql.enforce_sealed_slack_delivery_protocol_update,
          transient_guard_trigger_count: 0,
          sealed_migration_count: 1,
          ...overrides,
        },
      ],
    },
  ]);
}

test("accepts only the exact reviewed historical seal", () => {
  assert.deepEqual(validateSlackDeliveryProtocolContract(output()), {
    state: "sealed_exact_contract",
  });

  for (const mutation of [
    { slack_delivery_protocol_active: 0 },
    { slack_delivery_protocol_revision: "a".repeat(40) },
    { slack_delivery_protocol_activated_at: SEALED_PROTOCOL_ACTIVATED_AT + 1 },
    { slack_delivery_protocol_activation_id: "b".repeat(64) },
    { slack_delivery_protocol_schema_revision: "wrong" },
    { slack_delivery_protocol_confirmation_open: 1 },
    { duplicate_delivery_execution_id_groups: 1 },
    { duplicate_slack_trace_execution_id_groups: 1 },
    { relay_state_guard_trigger_count: 2 },
    { sealed_update_guard_sql: "CREATE TRIGGER inert" },
    { transient_guard_trigger_count: 1 },
    { sealed_migration_count: 0 },
  ]) {
    assert.throws(
      () => validateSlackDeliveryProtocolContract(output(mutation)),
      /sealed contract/u,
    );
  }
});

test("fails closed on malformed, partial, or shape-drifted D1 output", () => {
  for (const candidate of [
    "",
    "{}",
    "[]",
    JSON.stringify([{ success: false, results: [] }]),
    JSON.stringify([{ success: true, results: [] }]),
    output({ relay_state_guard_trigger_count: null }),
    output({ transient_guard_trigger_count: -1 }),
    output({ unexpected: 1 }),
  ]) {
    assert.throws(
      () => validateSlackDeliveryProtocolContract(candidate),
      /sealed contract/u,
    );
  }
});

test("the canonical sealed contract query executes against every local migration", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    const names = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    assert.ok(names.includes(SEALED_PROTOCOL_MIGRATION));
    for (const [index, migration] of names.entries()) {
      if (migration === SEALED_PROTOCOL_MIGRATION) {
        database
          .prepare(
            `UPDATE relay_state
             SET slack_delivery_protocol_active = 1,
                 slack_delivery_protocol_revision = ?,
                 slack_delivery_protocol_activated_at = ?,
                 slack_delivery_protocol_activation_id = ?,
                 slack_delivery_protocol_schema_revision = ?
             WHERE singleton_id = 1`,
          )
          .run(
            SEALED_PROTOCOL_REVISION,
            SEALED_PROTOCOL_ACTIVATED_AT,
            SEALED_PROTOCOL_ACTIVATION_ID,
            SEALED_PROTOCOL_SCHEMA_REVISION,
          );
      }
      database.exec(readFileSync(`${migrationsDirectory}/${migration}`, "utf8"));
      database
        .prepare("INSERT INTO d1_migrations (id, name) VALUES (?, ?)")
        .run(index + 1, migration);
    }

    const results = database.prepare(SLACK_DELIVERY_PROTOCOL_CONTRACT_SQL).all();
    assert.deepEqual(
      validateSlackDeliveryProtocolContract(
        JSON.stringify([{ success: true, results }]),
      ),
      { state: "sealed_exact_contract" },
    );

    database.exec(`
      CREATE TRIGGER unexpected_relay_state_blocker
      BEFORE UPDATE ON relay_state
      WHEN 0
      BEGIN
        SELECT 1;
      END;
    `);
    const extraTriggerResults = database
      .prepare(SLACK_DELIVERY_PROTOCOL_CONTRACT_SQL)
      .all();
    assert.throws(
      () =>
        validateSlackDeliveryProtocolContract(
          JSON.stringify([{ success: true, results: extraTriggerResults }]),
        ),
      /sealed contract/u,
    );
    database.exec("DROP TRIGGER unexpected_relay_state_blocker");

    database.exec(`
      DROP TRIGGER enforce_sealed_slack_delivery_protocol_update;
      CREATE TRIGGER enforce_sealed_slack_delivery_protocol_update
      BEFORE UPDATE ON relay_state
      WHEN 0
      BEGIN
        SELECT 1;
      END;
    `);
    const tamperedResults = database
      .prepare(SLACK_DELIVERY_PROTOCOL_CONTRACT_SQL)
      .all();
    assert.throws(
      () =>
        validateSlackDeliveryProtocolContract(
          JSON.stringify([{ success: true, results: tamperedResults }]),
        ),
      /sealed contract/u,
    );
  } finally {
    database.close();
  }
});

test("the deployment seals D1 before Worker and Slack without the retired activation ceremony", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/github-slack-integration.yml", import.meta.url),
    "utf8",
  );
  const migrations = workflow.indexOf("- name: Apply durable inbox migrations");
  const postflight = workflow.indexOf(
    "- name: Verify the sealed Slack delivery protocol contract",
  );
  const worker = workflow.indexOf("- name: Deploy verified relay");
  const slack = workflow.indexOf("- name: Deploy without exposing webhook triggers");

  assert.ok(migrations >= 0, "migration step must exist");
  assert.ok(postflight > migrations, "sealed postflight must follow migrations");
  assert.ok(worker > postflight, "Worker deploy must follow sealed postflight");
  assert.ok(slack > worker, "Slack deploy must follow Worker deploy");
  assert.doesNotMatch(workflow, /Refuse to replace an already activated relay revision/u);
  assert.doesNotMatch(workflow, /activate_delivery_protocol\.ts/u);
  assert.match(
    workflow,
    /CONTRACT_SQL="\$\(node scripts\/slack-delivery-protocol-contract\.mjs --print-sql\)"/u,
  );
  assert.match(workflow, /--command "\$CONTRACT_SQL"/u);
});

test("the contract CLI prints the exact canonical query for the workflow", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/slack-delivery-protocol-contract.mjs", "--print-sql"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${SLACK_DELIVERY_PROTOCOL_CONTRACT_SQL}\n`);
});
