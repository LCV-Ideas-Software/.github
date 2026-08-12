import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { validateSlackDeliveryProtocolPreflight } from "./slack-delivery-protocol-preflight.mjs";

const REVISION = "a".repeat(40);
const SECRET = "preflight-test-only-relay-signing-secret";
const SCHEMA_REVISION = "0004_confirm_slack_delivery";
function activationIdFor(revision, secret = SECRET) {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "slack_delivery_protocol_activation_id_v1",
        revision,
        SCHEMA_REVISION,
      ]),
    )
    .digest("hex");
}

const ACTIVATION_ID = activationIdFor(REVISION);

function output({
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
        schemaRevision: SCHEMA_REVISION,
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
        schemaRevision: SCHEMA_REVISION,
      }),
      REVISION,
      paddedSecret,
    ),
    { state: "active_exact_tuple" },
  );
});

test("blocks a later SHA before it can replace the activated Worker", () => {
  assert.throws(
    () =>
      validateSlackDeliveryProtocolPreflight(
        output({
          active: 1,
          revision: "b".repeat(40),
          activatedAt: 1_785_830_400_000,
          activationId: activationIdFor("b".repeat(40)),
          schemaRevision: SCHEMA_REVISION,
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
    output({ active: 0, schemaRevision: SCHEMA_REVISION }),
    output({ active: 2 }),
    output({
      active: 1,
      revision: REVISION,
      activatedAt: 1_785_830_400_000,
      activationId: "b".repeat(64),
      schemaRevision: SCHEMA_REVISION,
    }),
    output({
      active: 1,
      revision: REVISION,
      activatedAt: 1_785_830_400_000,
      activationId: ACTIVATION_ID,
      schemaRevision: "wrong_schema",
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
