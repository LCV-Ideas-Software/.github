import assert from "node:assert/strict";
import test from "node:test";

import { validateSlackDeliveryProtocolPreflight } from "./slack-delivery-protocol-preflight.mjs";

const REVISION = "a".repeat(40);

function output({ active = 0, revision = null, confirmationOpen = 1 } = {}) {
  return JSON.stringify([
    {
      success: true,
      results: [
        {
          slack_delivery_protocol_active: active,
          slack_delivery_protocol_revision: revision,
          slack_delivery_protocol_confirmation_open: confirmationOpen,
        },
      ],
    },
  ]);
}

test("allows only the initial inactive rollout or an exact-SHA confirmation", () => {
  assert.deepEqual(validateSlackDeliveryProtocolPreflight(output(), REVISION), {
    state: "inactive_initial",
  });
  assert.deepEqual(
    validateSlackDeliveryProtocolPreflight(
      output({ active: 1, revision: REVISION }),
      REVISION,
    ),
    { state: "active_exact_revision" },
  );
});

test("blocks a later SHA before it can replace the activated Worker", () => {
  assert.throws(
    () =>
      validateSlackDeliveryProtocolPreflight(
        output({ active: 1, revision: "b".repeat(40) }),
        REVISION,
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
    output({ active: 2 }),
  ]) {
    assert.throws(
      () => validateSlackDeliveryProtocolPreflight(candidate, REVISION),
      /preflight/,
    );
  }
  assert.throws(
    () => validateSlackDeliveryProtocolPreflight(output(), "main"),
    /revision/,
  );
});
