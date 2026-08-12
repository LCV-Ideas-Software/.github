import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SLACK_DELIVERY_PROTOCOL_PREFLIGHT_SQL,
  validateSlackDeliveryProtocolPreflight,
} from "./slack-delivery-protocol-preflight.mjs";

const REVISION = "a".repeat(40);
const SECRET = "preflight-test-only-relay-signing-secret";
const TARGET_SCHEMA_REVISION = "0005_reconcile_live_slack_receipts";
const SOURCE_SCHEMA_REVISION = "0004_confirm_slack_delivery";
function activationIdFor(
  revision,
  secret = SECRET,
  schemaRevision = TARGET_SCHEMA_REVISION,
) {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "slack_delivery_protocol_activation_id_v1",
        revision,
        schemaRevision,
      ]),
    )
    .digest("hex");
}

const ACTIVATION_ID = activationIdFor(REVISION);

function output({
  duplicateDeliveryExecutionIdGroups = 0,
  duplicateTraceExecutionIdGroups = 0,
  active = 0,
  revision = null,
  activatedAt = null,
  activationId = null,
  schemaRevision = null,
  confirmationOpen = 1,
} = {}) {
  return JSON.stringify([
    {
      success: true,
      results: [
        {
          duplicate_delivery_execution_id_groups:
            duplicateDeliveryExecutionIdGroups,
          duplicate_slack_trace_execution_id_groups:
            duplicateTraceExecutionIdGroups,
          slack_delivery_protocol_active: active,
          slack_delivery_protocol_revision: revision,
          slack_delivery_protocol_activated_at: activatedAt,
          slack_delivery_protocol_activation_id: activationId,
          slack_delivery_protocol_schema_revision: schemaRevision,
          slack_delivery_protocol_confirmation_open: confirmationOpen,
        },
      ],
    },
  ]);
}

test("allows only the complete initial tuple or an exact activation confirmation", () => {
  assert.deepEqual(
    validateSlackDeliveryProtocolPreflight(output(), REVISION, SECRET),
    { state: "inactive_initial" },
  );
  assert.deepEqual(
    validateSlackDeliveryProtocolPreflight(
      output({
        active: 1,
        revision: REVISION,
        activatedAt: 1_785_830_400_000,
        activationId: ACTIVATION_ID,
        schemaRevision: TARGET_SCHEMA_REVISION,
      }),
      REVISION,
      SECRET,
    ),
    { state: "active_exact_tuple" },
  );
  const paddedSecret = ` ${SECRET} `;
  assert.deepEqual(
    validateSlackDeliveryProtocolPreflight(
      output({
        active: 1,
        revision: REVISION,
        activatedAt: 1_785_830_400_000,
        activationId: activationIdFor(REVISION, paddedSecret),
        schemaRevision: TARGET_SCHEMA_REVISION,
      }),
      REVISION,
      paddedSecret,
    ),
    { state: "active_exact_tuple" },
  );
});

test("allows a signed revision upgrade only while confirmation remains open", () => {
  const activeRevision = "afe5250504d37543845b07f44af7bfc30a548feb";
  assert.deepEqual(
    validateSlackDeliveryProtocolPreflight(
      output({
        active: 1,
        revision: activeRevision,
        activatedAt: 1_785_830_400_000,
        activationId: activationIdFor(
          activeRevision,
          SECRET,
          SOURCE_SCHEMA_REVISION,
        ),
        schemaRevision: SOURCE_SCHEMA_REVISION,
      }),
      REVISION,
      SECRET,
    ),
    { state: "active_bridge_source", activeRevision },
  );
  assert.throws(
    () =>
      validateSlackDeliveryProtocolPreflight(
        output({
          active: 1,
          revision: "b".repeat(40),
          activatedAt: 1_785_830_400_000,
          activationId: activationIdFor("b".repeat(40)),
          schemaRevision: TARGET_SCHEMA_REVISION,
        }),
        REVISION,
        SECRET,
      ),
    /activated for another revision/,
  );
  assert.throws(
    () =>
      validateSlackDeliveryProtocolPreflight(
        output({
          active: 1,
          revision: REVISION,
          confirmationOpen: 0,
        }),
        REVISION,
        SECRET,
      ),
    /confirmation is closed/,
  );
});

test("fails closed on malformed, partial, or inconsistent D1 output", () => {
  for (const candidate of [
    "",
    "{}",
    "[]",
    JSON.stringify([{ success: false, results: [] }]),
    JSON.stringify([{ success: true, results: [] }]),
    output({ active: 0, revision: REVISION }),
    output({ active: 0, activationId: ACTIVATION_ID }),
    output({ active: 0, activatedAt: 1 }),
    output({ active: 0, schemaRevision: TARGET_SCHEMA_REVISION }),
    output({ active: 2 }),
    output({ duplicateDeliveryExecutionIdGroups: 1 }),
    output({ duplicateDeliveryExecutionIdGroups: null }),
    output({ duplicateTraceExecutionIdGroups: 1 }),
    output({ duplicateTraceExecutionIdGroups: null }),
    output({
      active: 1,
      revision: REVISION,
      activatedAt: 1_785_830_400_000,
      activationId: "b".repeat(64),
      schemaRevision: TARGET_SCHEMA_REVISION,
    }),
    output({
      active: 1,
      revision: REVISION,
      activatedAt: 1_785_830_400_000,
      activationId: ACTIVATION_ID,
      schemaRevision: "wrong_schema",
    }),
    output({
      active: 1,
      revision: REVISION,
      activatedAt: 1_785_830_400_000,
      activationId: activationIdFor(REVISION, SECRET, SOURCE_SCHEMA_REVISION),
      schemaRevision: SOURCE_SCHEMA_REVISION,
    }),
    output({
      active: 1,
      revision: "afe5250504d37543845b07f44af7bfc30a548feb",
      activatedAt: 1_785_830_400_000,
      activationId: activationIdFor(
        "afe5250504d37543845b07f44af7bfc30a548feb",
      ),
      schemaRevision: TARGET_SCHEMA_REVISION,
    }),
  ]) {
    assert.throws(
      () => validateSlackDeliveryProtocolPreflight(candidate, REVISION, SECRET),
      /preflight/,
    );
  }
  assert.throws(
    () => validateSlackDeliveryProtocolPreflight(output(), "main", SECRET),
    /revision/,
  );
  assert.throws(
    () => validateSlackDeliveryProtocolPreflight(output(), REVISION, "short"),
    /secret/,
  );
});

test("checks both execution-owner inventories before applying migrations", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/github-slack-integration.yml", import.meta.url),
    "utf8",
  );
  const preflight = workflow.indexOf(
    "- name: Refuse to replace an already activated relay revision",
  );
  const migration = workflow.indexOf("- name: Apply durable inbox migrations");
  assert.ok(preflight >= 0 && migration > preflight);
  assert.match(
    workflow,
    /FROM deliveries WHERE slack_send_execution_id IS NOT NULL GROUP BY slack_send_execution_id HAVING COUNT\(\*\) > 1\)\) AS duplicate_delivery_execution_id_groups/,
  );
  assert.match(
    workflow,
    /FROM slack_workflow_traces WHERE send_execution_id IS NOT NULL GROUP BY send_execution_id HAVING COUNT\(\*\) > 1\)\) AS duplicate_slack_trace_execution_id_groups/,
  );
  const command = workflow.match(
    /--command "(SELECT slack_delivery_protocol_active[^"\r\n]+)"/u,
  );
  assert.equal(command?.[1], SLACK_DELIVERY_PROTOCOL_PREFLIGHT_SQL);
});
