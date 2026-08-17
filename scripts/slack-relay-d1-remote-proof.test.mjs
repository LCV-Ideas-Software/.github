import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertFinalSchema,
  DATABASE_NAME_PREFIX,
  DISPOSABLE_DATABASE_NAME_PATTERN,
  EXPECTED_FINAL_SCHEMA,
  parseDisposableTimestamp,
  REMOTE_PROOF_MINIMUM_MARGIN_MS,
  verifyRemoteProofDeadline,
} from "./verify-slack-relay-d1-remote.mjs";

test("the deadline gate fails closed on a missing or malformed value", () => {
  for (const environment of [{}, { REMOTE_PROOF_DEADLINE_MS: "" }, {
    REMOTE_PROOF_DEADLINE_MS: "not-a-number",
  }, { REMOTE_PROOF_DEADLINE_MS: "-5" }]) {
    assert.throws(
      () => verifyRemoteProofDeadline(environment, 1_000),
      /fail-closed deadline/u,
    );
  }
});

test("the deadline gate refuses to start without the minimum margin", () => {
  const now = 1_000_000;
  assert.throws(
    () =>
      verifyRemoteProofDeadline(
        {
          REMOTE_PROOF_DEADLINE_MS: String(
            now + REMOTE_PROOF_MINIMUM_MARGIN_MS - 1,
          ),
        },
        now,
      ),
    /margin/u,
  );
  assert.equal(
    verifyRemoteProofDeadline(
      {
        REMOTE_PROOF_DEADLINE_MS: String(
          now + REMOTE_PROOF_MINIMUM_MARGIN_MS,
        ),
      },
      now,
    ),
    now + REMOTE_PROOF_MINIMUM_MARGIN_MS,
  );
});

test("disposable database names carry the prefix, a timestamp, and entropy", () => {
  const name = `${DATABASE_NAME_PREFIX}1755000000000-0a1b2c3d`;
  assert.match(name, DISPOSABLE_DATABASE_NAME_PATTERN);
  assert.equal(parseDisposableTimestamp(name), 1_755_000_000_000);
  assert.equal(parseDisposableTimestamp("github-slack-alerts-db"), null);
  assert.equal(parseDisposableTimestamp(`${DATABASE_NAME_PREFIX}short-ff`), null);
});

test("the final-schema assertion accepts exactly the v2 surface", () => {
  assert.doesNotThrow(() => assertFinalSchema([...EXPECTED_FINAL_SCHEMA]));
});

test("the final-schema assertion ignores sqlite and Cloudflare internals", () => {
  assert.doesNotThrow(() =>
    assertFinalSchema([
      ...EXPECTED_FINAL_SCHEMA,
      { type: "index", name: "sqlite_autoindex_alert_delivery_1" },
      { type: "table", name: "_cf_KV" },
    ]),
  );
});

test("the final-schema assertion rejects a legacy leftover", () => {
  assert.throws(
    () =>
      assertFinalSchema([
        ...EXPECTED_FINAL_SCHEMA,
        { type: "table", name: "deliveries" },
      ]),
    /not the exact v2 surface/u,
  );
});

test("the final-schema assertion rejects a missing v2 object", () => {
  assert.throws(
    () =>
      assertFinalSchema(
        EXPECTED_FINAL_SCHEMA.filter(
          (entry) => entry.name !== "idx_alert_delivery_due",
        ),
      ),
    /not the exact v2 surface/u,
  );
});
