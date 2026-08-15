import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  canonicalSlackCheckpointRequest,
  RELAY_SIGNER_PROOF_MAX_RESPONSE_BYTES,
  RELAY_SIGNER_PROOF_REQUEST_TIMEOUT_MS,
  RELAY_SIGNER_PROOF_WORST_CASE_NETWORK_MS,
  verifySlackRelaySigner,
} from "./verify-slack-relay-signer.mjs";

const CHECKPOINT_URL =
  "https://github-slack-alerts.lcv.workers.dev/slack/reconciliation/checkpoint";
const NOW = 1_786_579_200_000;
const TIMESTAMP = "1786579200";
const SLACK_SECRET = "signer-proof-test-only-secret-0001";
const CLOUDFLARE_SECRET = SLACK_SECRET;
const DIFFERENT_SECRET = "signer-proof-test-only-secret-0002";
const GOLDEN_SIGNATURE =
  "791aa74e083b5f5503a4227ed84d873e03f93044bdb91a93190f3090bc9f46ea";

function signature(secret, canonical) {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function checkpointPayload(
  checkpointUs = 1_786_579_000_000_000,
  resumeFromUs = null,
  pendingTraceIds = [],
  pendingTraceTotal = pendingTraceIds.length,
  pendingTraceOldestUs = pendingTraceTotal === 0 ? null : checkpointUs,
) {
  return {
    checkpoint_us: checkpointUs,
    reconciliation_version: 5,
    resume_from_us: resumeFromUs,
    pending_trace_ids: pendingTraceIds,
    pending_trace_total: pendingTraceTotal,
    pending_trace_oldest_us: pendingTraceOldestUs,
  };
}

function checkpointResponse(...args) {
  return jsonResponse(checkpointPayload(...args));
}

function workerLikeFetch(activeSecret, calls = []) {
  return async (input, init) => {
    calls.push({ input, init });
    const body = JSON.parse(String(init.body));
    const expected = signature(
      activeSecret,
      canonicalSlackCheckpointRequest({
        request_timestamp: body.request_timestamp,
      }),
    );
    return body.request_signature === expected
      ? checkpointResponse()
      : jsonResponse({ error: "invalid_signature" }, { status: 401 });
  };
}

function environment(secret = SLACK_SECRET) {
  return { SLACK_RELAY_SIGNING_SECRET: secret };
}

test("uses the cross-runtime checkpoint HMAC golden vector", async () => {
  assert.equal(
    canonicalSlackCheckpointRequest({ request_timestamp: TIMESTAMP }),
    '["slack_activity_checkpoint_request_v1","1786579200"]',
  );
  const calls = [];
  await verifySlackRelaySigner({
    environment: environment(),
    fetchImpl: workerLikeFetch(CLOUDFLARE_SECRET, calls),
    now: () => NOW,
  });

  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body, {
    request_timestamp: TIMESTAMP,
    request_signature: GOLDEN_SIGNATURE,
  });
  assert.equal(calls[0].input, CHECKPOINT_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "application/json; charset=utf-8",
  });
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("proves A equals A and rejects A different from B", async () => {
  await assert.doesNotReject(
    verifySlackRelaySigner({
      environment: environment(SLACK_SECRET),
      fetchImpl: workerLikeFetch(CLOUDFLARE_SECRET),
      now: () => NOW,
    }),
  );

  let mismatchedCalls = 0;
  await assert.rejects(
    verifySlackRelaySigner({
      environment: environment(DIFFERENT_SECRET),
      fetchImpl: async (...args) => {
        mismatchedCalls += 1;
        return workerLikeFetch(CLOUDFLARE_SECRET)(...args);
      },
      now: () => NOW,
    }),
    /signer proof was rejected/u,
  );
  assert.equal(mismatchedCalls, 1, "an authentication rejection is permanent");
});

test("preserves the exact secret bytes without trimming", async () => {
  const exact = `  ${SLACK_SECRET}\n`;
  await assert.doesNotReject(
    verifySlackRelaySigner({
      environment: environment(exact),
      fetchImpl: workerLikeFetch(exact),
      now: () => NOW,
    }),
  );
  await assert.rejects(
    verifySlackRelaySigner({
      environment: environment(exact),
      fetchImpl: workerLikeFetch(exact.trim()),
      now: () => NOW,
    }),
    /signer proof was rejected/u,
  );
});

test("rejects absent and short secrets before reaching the network", async () => {
  for (const candidate of [undefined, "", "short"]) {
    let calls = 0;
    await assert.rejects(
      verifySlackRelaySigner({
        environment: { SLACK_RELAY_SIGNING_SECRET: candidate },
        fetchImpl: async () => {
          calls += 1;
          return checkpointResponse();
        },
        now: () => NOW,
      }),
      /SLACK_RELAY_SIGNING_SECRET is malformed/u,
    );
    assert.equal(calls, 0);
  }
});

test("bounds timeout, retry delay, response bytes, and repeats the exact request", async () => {
  const bodies = [];
  const timeoutCalls = [];
  const sleeps = [];
  let cancelled = false;
  const transientBody = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });

  const result = await verifySlackRelaySigner({
    environment: environment(),
    fetchImpl: async (_input, init) => {
      bodies.push(String(init.body));
      if (bodies.length === 1) {
        return new Response(transientBody, {
          status: 429,
          headers: { "retry-after": "99" },
        });
      }
      return checkpointResponse(123);
    },
    now: () => NOW,
    signalFactory: (milliseconds) => {
      timeoutCalls.push(milliseconds);
      return new AbortController().signal;
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  assert.deepEqual(result, {
    checkpointUs: 123,
    reconciliationVersion: 5,
    resumeFromUs: null,
    pendingTraceIds: [],
    pendingTraceTotal: 0,
    pendingTraceOldestUs: null,
  });
  assert.equal(cancelled, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(timeoutCalls, [10_000, 10_000]);
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(RELAY_SIGNER_PROOF_REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(RELAY_SIGNER_PROOF_MAX_RESPONSE_BYTES, 4_096);
  assert.equal(RELAY_SIGNER_PROOF_WORST_CASE_NETWORK_MS, 25_000);
});

test("retries one network failure and stops after the second attempt", async () => {
  let recoveringCalls = 0;
  await assert.doesNotReject(
    verifySlackRelaySigner({
      environment: environment(),
      fetchImpl: async (...args) => {
        recoveringCalls += 1;
        if (recoveringCalls === 1) throw new Error("simulated network loss");
        return workerLikeFetch(CLOUDFLARE_SECRET)(...args);
      },
      now: () => NOW,
      signalFactory: () => new AbortController().signal,
    }),
  );
  assert.equal(recoveringCalls, 2);

  let exhaustedCalls = 0;
  await assert.rejects(
    verifySlackRelaySigner({
      environment: environment(),
      fetchImpl: async () => {
        exhaustedCalls += 1;
        throw new Error("response included secret material");
      },
      now: () => NOW,
      signalFactory: () => new AbortController().signal,
    }),
    /signer proof is unavailable/u,
  );
  assert.equal(exhaustedCalls, 2);
});

test("accepts the full bounded v5 pending trace page", async () => {
  const traceIds = Array.from(
    { length: 25 },
    (_, index) => `Tr${String(index).padStart(2, "0")}${"A".repeat(123)}`,
  );
  const result = await verifySlackRelaySigner({
    environment: environment(),
    fetchImpl: async () => checkpointResponse(123, null, traceIds, 30, 1),
    now: () => NOW,
    signalFactory: () => new AbortController().signal,
  });

  assert.deepEqual(result, {
    checkpointUs: 123,
    reconciliationVersion: 5,
    resumeFromUs: null,
    pendingTraceIds: traceIds,
    pendingTraceTotal: 30,
    pendingTraceOldestUs: 1,
  });
});

test("accepts only the strict bounded v5 checkpoint response", async (t) => {
  const oversized = "x".repeat(RELAY_SIGNER_PROOF_MAX_RESPONSE_BYTES + 1);
  const cases = [
    ["wrong content type", () => new Response("plain text", { status: 200 })],
    [
      "declared oversized",
      () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-length": String(RELAY_SIGNER_PROOF_MAX_RESPONSE_BYTES + 1),
            "content-type": "application/json",
          },
        }),
    ],
    [
      "streamed oversized",
      () =>
        new Response(oversized, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "invalid utf8",
      () =>
        new Response(new Uint8Array([0xff]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "invalid json",
      () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    ["wrong top-level shape", () => jsonResponse("not-an-object")],
    ["missing key", () => jsonResponse({ checkpoint_us: 0 })],
    ["extra key", () => jsonResponse({ ...checkpointPayload(0), extra: true })],
    [
      "unsafe checkpoint",
      () => jsonResponse(checkpointPayload(Number.MAX_SAFE_INTEGER + 1)),
    ],
    ["negative checkpoint", () => jsonResponse(checkpointPayload(-1))],
    [
      "wrong version",
      () =>
        jsonResponse({ ...checkpointPayload(0), reconciliation_version: 4 }),
    ],
    [
      "negative resume checkpoint",
      () => jsonResponse(checkpointPayload(1, -1)),
    ],
    [
      "resume checkpoint beyond the durable checkpoint",
      () => jsonResponse(checkpointPayload(1, 2)),
    ],
    [
      "duplicate pending trace id",
      () =>
        jsonResponse(
          checkpointPayload(
            1,
            null,
            ["TrPendingDuplicate1", "TrPendingDuplicate1"],
            2,
            1,
          ),
        ),
    ],
    [
      "pending total below returned ids",
      () =>
        jsonResponse(checkpointPayload(1, null, ["TrPendingCount1"], 0, null)),
    ],
    [
      "missing pending oldest timestamp",
      () =>
        jsonResponse(checkpointPayload(1, null, ["TrPendingOldest1"], 1, null)),
    ],
    [
      "pending total without a fair-page id",
      () => jsonResponse(checkpointPayload(1, null, [], 1, 1)),
    ],
  ];

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      await assert.rejects(
        verifySlackRelaySigner({
          environment: environment(),
          fetchImpl: async () => {
            calls += 1;
            return response();
          },
          now: () => NOW,
          signalFactory: () => new AbortController().signal,
        }),
        /signer proof is unavailable/u,
      );
      assert.equal(calls, 2);
    });
  }
});

test("never includes the secret, signature, or remote body in an error", async () => {
  const leakMarker = "REMOTE_BODY_MUST_NOT_BE_LOGGED";
  let observedSignature = "";
  const error = await verifySlackRelaySigner({
    environment: environment(),
    fetchImpl: async (_input, init) => {
      observedSignature = JSON.parse(String(init.body)).request_signature;
      return jsonResponse({ error: leakMarker }, { status: 401 });
    },
    now: () => NOW,
  }).catch((caught) => caught);

  assert.ok(error instanceof Error);
  for (const forbidden of [SLACK_SECRET, observedSignature, leakMarker]) {
    assert.ok(forbidden.length > 0);
    assert.doesNotMatch(error.message, new RegExp(forbidden, "u"));
    assert.doesNotMatch(String(error.cause ?? ""), new RegExp(forbidden, "u"));
  }
});
