import {
  canonicalRelayProgress,
  RelayProgressInputs,
  reportRelayProgress,
} from "../functions/report_relay_progress.ts";
import { signProgressAuthorization } from "../functions/validate_relay_message.ts";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const SECRET = "deno-test-only-relay-signing-secret";
const WORKER_GOLDEN_SECRET = "vitest-only-relay-signing-secret";
const FUNCTION_EXECUTION_ID = "FxDenoRelayProgress1";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function inputs(phase: "send_started" | "delivered"): RelayProgressInputs {
  return {
    delivery_id: "00000000-0000-4000-8000-000000000001",
    destination: "alerts",
    phase,
    message_ts: phase === "delivered" ? "1785758400.000001" : "",
    message: phase === "send_started" ? "validated Slack message" : "",
    relay_attempt: "1",
    relay_timestamp: String(Math.floor(NOW / 1_000)),
    progress_token: "",
  };
}

async function authorizedInputs(
  phase: "send_started" | "delivered",
  secret = SECRET,
): Promise<RelayProgressInputs> {
  const value = inputs(phase);
  value.progress_token = await signProgressAuthorization(secret, value);
  return value;
}

async function expectedSignature(
  value: ReturnType<typeof JSON.parse>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(canonicalRelayProgress(value)),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

Deno.test(
  "authenticates the pre-send boundary and preserves the validated message",
  async () => {
    let calls = 0;
    const result = await reportRelayProgress(
      await authorizedInputs("send_started"),
      SECRET,
      FUNCTION_EXECUTION_ID,
      {
        now: () => NOW,
        fetchImpl: async (url, init) => {
          calls += 1;
          assert(
            url ===
              "https://github-slack-alerts.lcv.workers.dev/slack/progress",
            "unexpected receipt endpoint",
          );
          assert(init?.method === "POST", "receipt was not sent with POST");
          assert(init.redirect === "error", "redirects were not rejected");
          const body = JSON.parse(String(init.body));
          assert(body.phase === "send_started", "wrong progress phase");
          assert(
            body.message_ts === "",
            "pre-send receipt carried a message ts",
          );
          assert(
            body.receipt_signature === (await expectedSignature(body)),
            "progress signature was not canonical",
          );
          assert(
            !String(init.body).includes("validated Slack message"),
            "human-facing message leaked to the relay control endpoint",
          );
          return Response.json({ ok: true, duplicate: false });
        },
      },
    );
    assert(result.ok, "valid send boundary was rejected");
    assert(
      result.message === "validated Slack message",
      "message was not preserved",
    );
    assert(calls === 1, "valid receipt was sent more than once");
  },
);

Deno.test("matches the Worker progress HMAC golden vector", async () => {
  const progress = {
    delivery_id: "receipt-delivery-1",
    destination: "alerts",
    phase: "delivered",
    message_ts: "1785758400.000001",
    relay_attempt: "1",
    function_execution_id: "FxDeliveryProof1",
    receipt_timestamp: "1785758400",
  };
  const signature = await createProgressSignatureForTest(
    progress,
    WORKER_GOLDEN_SECRET,
  );
  assert(
    signature ===
      "9cf3766466fa858cd43666850015dec2a7150c3bbf376c51e040d58580164d96",
    "Worker and Slack progress canonicalization diverged",
  );
});

Deno.test(
  "retries an idempotent delivered receipt once without posting another message",
  async () => {
    const bodies: string[] = [];
    const result = await reportRelayProgress(
      await authorizedInputs("delivered"),
      SECRET,
      FUNCTION_EXECUTION_ID,
      {
        now: () => NOW,
        fetchImpl: (_url, init) => {
          bodies.push(String(init?.body));
          return Promise.resolve(
            bodies.length === 1
              ? new Response(null, { status: 503 })
              : Response.json({ ok: true, duplicate: true }),
          );
        },
      },
    );
    assert(result.ok, "idempotent receipt retry failed");
    assert(bodies.length === 2, "receipt retry count was not bounded");
    assert(bodies[0] === bodies[1], "receipt retry changed its identity");
  },
);

Deno.test(
  "retries an idempotent progress write after an invalid successful response",
  async () => {
    const scenarios = [
      {
        phase: "send_started" as const,
        firstResponse: () => new Response('{"ok":', { status: 200 }),
      },
      {
        phase: "delivered" as const,
        firstResponse: () => Response.json({ ok: "true" }),
      },
    ];

    for (const scenario of scenarios) {
      const bodies: string[] = [];
      const result = await reportRelayProgress(
        await authorizedInputs(scenario.phase),
        SECRET,
        FUNCTION_EXECUTION_ID,
        {
          now: () => NOW,
          fetchImpl: (_url, init) => {
            bodies.push(String(init?.body));
            return Promise.resolve(
              bodies.length === 1
                ? scenario.firstResponse()
                : Response.json({ ok: true, duplicate: true }),
            );
          },
        },
      );

      assert(
        result.ok,
        `${scenario.phase} did not confirm its committed idempotent retry`,
      );
      assert(
        bodies.length === 2,
        `${scenario.phase} did not use exactly one confirmation retry`,
      );
      assert(
        bodies[0] === bodies[1],
        `${scenario.phase} changed identity during its confirmation retry`,
      );
    }
  },
);

Deno.test(
  "releases a message only to the Slack execution that owns the send lease",
  async () => {
    const value = await authorizedInputs("send_started");
    const accepted = await reportRelayProgress(
      value,
      SECRET,
      FUNCTION_EXECUTION_ID,
      {
        now: () => NOW,
        fetchImpl: () =>
          Promise.resolve(Response.json({ ok: true, duplicate: true })),
      },
    );
    assert(accepted.ok, "the owning execution could not confirm a lost reply");
    assert(
      accepted.message === "validated Slack message",
      "the owning execution lost its message",
    );

    const rejected = await reportRelayProgress(
      value,
      SECRET,
      "FxDenoRelayProgressOther2",
      {
        now: () => NOW,
        fetchImpl: () =>
          Promise.resolve(
            Response.json(
              { error: "delivery_state_conflict" },
              { status: 409 },
            ),
          ),
      },
    );
    assert(!rejected.ok, "a second Slack execution received the message");
  },
);

Deno.test(
  "fails closed before network on malformed progress or a short secret",
  async () => {
    let calls = 0;
    const fetchImpl = () => {
      calls += 1;
      return Promise.resolve(Response.json({ ok: true }));
    };
    const malformed = await authorizedInputs("delivered");
    malformed.message_ts = "not-a-message-timestamp";
    assert(
      !(
        await reportRelayProgress(malformed, SECRET, FUNCTION_EXECUTION_ID, {
          now: () => NOW,
          fetchImpl,
        })
      ).ok,
      "malformed receipt was accepted",
    );
    assert(
      !(
        await reportRelayProgress(
          await authorizedInputs("send_started"),
          "short",
          FUNCTION_EXECUTION_ID,
          {
            now: () => NOW,
            fetchImpl,
          },
        )
      ).ok,
      "short secret was accepted",
    );
    assert(calls === 0, "invalid progress reached the network");
  },
);

Deno.test(
  "rejects an independently invoked progress function and requires NEXT during rotation",
  async () => {
    let calls = 0;
    const forged = inputs("send_started");
    forged.progress_token = "a".repeat(64);
    assert(
      !(
        await reportRelayProgress(forged, SECRET, FUNCTION_EXECUTION_ID, {
          now: () => NOW,
          fetchImpl: () => {
            calls += 1;
            return Promise.resolve(Response.json({ ok: true }));
          },
        })
      ).ok,
      "progress without a validator-issued token was accepted",
    );

    const nextSecret = "deno-test-next-relay-signing-secret";
    const currentAuthorized = await authorizedInputs("delivered", SECRET);
    assert(
      !(
        await reportRelayProgress(
          currentAuthorized,
          nextSecret,
          FUNCTION_EXECUTION_ID,
          {
            now: () => NOW,
            fetchImpl: () => {
              calls += 1;
              return Promise.resolve(Response.json({ ok: true }));
            },
          },
        )
      ).ok,
      "current-authorized progress was accepted after NEXT became mandatory",
    );

    const rotated = await authorizedInputs("delivered", nextSecret);
    const result = await reportRelayProgress(
      rotated,
      nextSecret,
      FUNCTION_EXECUTION_ID,
      {
        now: () => NOW,
        fetchImpl: async (_url, init) => {
          calls += 1;
          const body = JSON.parse(String(init?.body));
          const expected = createProgressSignatureForTest(body, nextSecret);
          assert(
            body.receipt_signature === (await expected),
            "receipt did not use the key that authorized the original relay",
          );
          return Response.json({ ok: true });
        },
      },
    );
    assert(result.ok, "NEXT-authorized progress was rejected");
    assert(calls === 1, "forged or current progress reached the network");
  },
);

async function createProgressSignatureForTest(
  value: ReturnType<typeof JSON.parse>,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(canonicalRelayProgress(value)),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
