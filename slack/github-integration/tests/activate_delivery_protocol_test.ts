import {
  activateDeliveryProtocol,
  canonicalActivationId,
  canonicalProtocolActivation,
  DELIVERY_PROTOCOL_SCHEMA_REVISION,
  deriveActivationId,
  readActivationConfiguration,
  signProtocolActivation,
} from "../scripts/activate_delivery_protocol.ts";

const REVISION = "a".repeat(40);
const SECRET = "deno-test-only-relay-signing-secret";
const SEED = "1234567890";
const ACTIVATION_ID =
  "6e0647eb628a4ee26a329bfb1fd956f98d6cef7eebb281bb525147eacb14660f";

const ENVIRONMENT = Object.freeze({
  ACTIVATION_SEED: SEED,
  EXPECTED_REVISION: REVISION,
  SLACK_RELAY_SIGNING_SECRET: SECRET,
});

function assertThrows(action: () => unknown, expected: string): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expected)) return;
    throw new Error(
      `Expected error containing "${expected}", received "${message}"`,
    );
  }
  throw new Error(`Expected action to throw "${expected}"`);
}

function successResponse(
  activationStatus: "applied" | "already_applied",
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({
    ok: true,
    activation_status: activationStatus,
    activation_id: ACTIVATION_ID,
    activated_revision: REVISION,
    schema_revision: DELIVERY_PROTOCOL_SCHEMA_REVISION,
    ...overrides,
  });
}

Deno.test("uses cross-runtime domain separation for activation ID and request", async () => {
  if (
    canonicalActivationId(SEED, REVISION) !==
      JSON.stringify([
        "slack_delivery_protocol_activation_id_v1",
        SEED,
        REVISION,
        DELIVERY_PROTOCOL_SCHEMA_REVISION,
      ])
  ) {
    throw new Error("Activation ID canonical form drifted.");
  }
  if (await deriveActivationId(SEED, REVISION, SECRET) !== ACTIVATION_ID) {
    throw new Error("Activation ID HMAC drifted.");
  }
  const canonical = canonicalProtocolActivation(
    ACTIVATION_ID,
    REVISION,
    DELIVERY_PROTOCOL_SCHEMA_REVISION,
  );
  if (
    canonical !==
      JSON.stringify([
        "slack_delivery_protocol_activation_v1",
        ACTIVATION_ID,
        REVISION,
        DELIVERY_PROTOCOL_SCHEMA_REVISION,
      ])
  ) {
    throw new Error("Activation request canonical form drifted.");
  }
  const signature = await signProtocolActivation(
    ACTIVATION_ID,
    REVISION,
    DELIVERY_PROTOCOL_SCHEMA_REVISION,
    SECRET,
  );
  if (
    signature !==
      "b09df6018de4de3cb6b7ffbbf6e6689a2d2c0dc50eda70ee1a2f7a105b633120"
  ) {
    throw new Error(`Activation HMAC drifted: ${signature}`);
  }
});

Deno.test("rejects missing, malformed, and non-exact activation inputs", () => {
  for (
    const environment of [
      { EXPECTED_REVISION: REVISION, SLACK_RELAY_SIGNING_SECRET: SECRET },
      { ACTIVATION_SEED: SEED, SLACK_RELAY_SIGNING_SECRET: SECRET },
      { ACTIVATION_SEED: SEED, EXPECTED_REVISION: REVISION },
      { ...ENVIRONMENT, ACTIVATION_SEED: "0" },
      { ...ENVIRONMENT, EXPECTED_REVISION: "A".repeat(40) },
      { ...ENVIRONMENT, SLACK_RELAY_SIGNING_SECRET: "short" },
    ]
  ) {
    assertThrows(
      () => readActivationConfiguration(environment),
      "missing or malformed",
    );
  }
});

Deno.test("applies the exact tuple with a bounded request", async () => {
  let observed = false;
  const result = await activateDeliveryProtocol({
    environment: ENVIRONMENT,
    fetchImpl: async (input, init) => {
      observed = true;
      if (
        input !==
          "https://github-slack-alerts.lcv.workers.dev/slack/protocol/activate"
      ) {
        throw new Error("Unexpected activation URL.");
      }
      if (
        init?.method !== "POST" ||
        init.redirect !== "error" ||
        !(init.signal instanceof AbortSignal)
      ) {
        throw new Error("Activation request controls drifted.");
      }
      const body = JSON.parse(String(init.body));
      if (
        body.activation_id !== ACTIVATION_ID ||
        body.expected_revision !== REVISION ||
        body.schema_revision !== DELIVERY_PROTOCOL_SCHEMA_REVISION ||
        body.activation_signature !==
          await signProtocolActivation(
            ACTIVATION_ID,
            REVISION,
            DELIVERY_PROTOCOL_SCHEMA_REVISION,
            SECRET,
          )
      ) {
        throw new Error("Activation request authentication drifted.");
      }
      return successResponse("applied");
    },
  });

  if (
    !observed ||
    result.activation_status !== "applied" ||
    result.activation_id !== ACTIVATION_ID
  ) {
    throw new Error("Activation request did not complete exactly once.");
  }
});

Deno.test("a lost first response converges through identical confirmation", async () => {
  const bodies: string[] = [];
  let calls = 0;
  const result = await activateDeliveryProtocol({
    environment: ENVIRONMENT,
    fetchImpl: (_input, init) => {
      calls += 1;
      bodies.push(String(init?.body));
      if (calls === 1) {
        // Model a CAS that succeeded before its response was lost.
        return Promise.reject(new Error("private-lost-response-detail"));
      }
      return Promise.resolve(successResponse("already_applied"));
    },
  });

  if (
    calls !== 2 ||
    bodies[0] !== bodies[1] ||
    result.activation_status !== "already_applied"
  ) {
    throw new Error("Idempotent activation confirmation did not converge.");
  }
});

Deno.test("retries one transient server failure with the identical tuple", async () => {
  const bodies: string[] = [];
  const result = await activateDeliveryProtocol({
    environment: ENVIRONMENT,
    fetchImpl: (_input, init) => {
      bodies.push(String(init?.body));
      return Promise.resolve(
        bodies.length === 1
          ? new Response("private-upstream-diagnostic", { status: 503 })
          : successResponse("already_applied"),
      );
    },
  });
  if (
    bodies.length !== 2 ||
    bodies[0] !== bodies[1] ||
    result.activation_status !== "already_applied"
  ) {
    throw new Error("Transient confirmation retry drifted.");
  }
});

Deno.test("does not retry or expose a definitive conflict", async () => {
  let calls = 0;
  try {
    await activateDeliveryProtocol({
      environment: ENVIRONMENT,
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(
          new Response("private-conflict-detail", { status: 409 }),
        );
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      calls !== 1 ||
      !message.includes("rejected") ||
      message.includes("private-conflict-detail")
    ) {
      throw error;
    }
    return;
  }
  throw new Error("Conflicting activation unexpectedly succeeded.");
});

Deno.test("bounds unavailable confirmation at two identical attempts", async () => {
  const bodies: string[] = [];
  try {
    await activateDeliveryProtocol({
      environment: ENVIRONMENT,
      fetchImpl: (_input, init) => {
        bodies.push(String(init?.body));
        return Promise.reject(new Error("private-transport-detail"));
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      bodies.length !== 2 ||
      bodies[0] !== bodies[1] ||
      !message.includes("confirmation is unavailable") ||
      message.includes("private-transport-detail")
    ) {
      throw error;
    }
    return;
  }
  throw new Error("Unavailable confirmation unexpectedly succeeded.");
});

Deno.test("rejects mismatched or extended success responses", async () => {
  for (
    const overrides of [
      { activated_revision: "b".repeat(40) },
      { activation_id: "2".repeat(64) },
      { extra: true },
    ]
  ) {
    let calls = 0;
    try {
      await activateDeliveryProtocol({
        environment: ENVIRONMENT,
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve(
            successResponse("already_applied", overrides),
          );
        },
      });
    } catch (error) {
      if (
        calls === 2 &&
        error instanceof Error &&
        error.message.includes("confirmation is unavailable")
      ) {
        continue;
      }
      throw error;
    }
    throw new Error("Unexpected activation response was accepted.");
  }
});
