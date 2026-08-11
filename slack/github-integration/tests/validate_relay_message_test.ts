import {
  formatRelayMessage,
  RelayMessageInputs,
  signRelayMessage,
  verifyRelayMessage,
  verifyRelayMessageWithSecrets,
} from "../functions/validate_relay_message.ts";

const NOW = 1_785_758_400;

function testKey(fill: number): string {
  return Array.from(
    new Uint8Array(32).fill(fill),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

const TEST_KEY = testKey(0x01);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function inputs(): RelayMessageInputs {
  return {
    source: "github-actions",
    severity: "high",
    repository: "LCV-Ideas-Software/cross-review",
    title: "Publish failed",
    details: "Workflow Publish concluded with failure.",
    actor: "lcv-leo",
    branch: "main",
    url: "https://github.com/LCV-Ideas-Software/cross-review/actions/runs/1",
    occurred_at: "2026-08-03T12:00:00.000Z",
    delivery_id: "00000000-0000-4000-8000-000000000001",
    event: "workflow_run",
    action: "failure",
    destination: "alerts",
    relay_timestamp: String(NOW),
    relay_signature: "",
    expected_destination: "alerts",
  };
}

Deno.test("accepts only a fresh HMAC for the expected destination", async () => {
  const value = inputs();
  value.relay_signature = await signRelayMessage(TEST_KEY, value);
  assert(
    await verifyRelayMessage(TEST_KEY, value, NOW),
    "valid relay was rejected",
  );

  value.title = "forged";
  assert(
    !(await verifyRelayMessage(TEST_KEY, value, NOW)),
    "forged relay was accepted",
  );
});

Deno.test("rejects stale signed messages, cross-channel routing, and malformed signatures", async () => {
  const value = inputs();
  value.relay_signature = await signRelayMessage(TEST_KEY, value);

  assert(
    !(await verifyRelayMessage(TEST_KEY, value, NOW + 301)),
    "stale relay was accepted",
  );
  value.expected_destination = "activity";
  assert(
    !(await verifyRelayMessage(TEST_KEY, value, NOW)),
    "cross-channel relay was accepted",
  );
  value.expected_destination = "alerts";
  value.relay_signature = "not-a-signature";
  assert(
    !(await verifyRelayMessage(TEST_KEY, value, NOW)),
    "malformed signature was accepted",
  );
});

Deno.test("accepts the current or staged next secret during a zero-loss rotation", async () => {
  const current = inputs();
  current.relay_signature = await signRelayMessage(TEST_KEY, current);
  const nextTestKey = testKey(0x02);
  const next = inputs();
  next.relay_signature = await signRelayMessage(nextTestKey, next);

  assert(
    await verifyRelayMessageWithSecrets([TEST_KEY, nextTestKey], current, NOW),
    "current secret was rejected during rotation",
  );
  assert(
    await verifyRelayMessageWithSecrets([TEST_KEY, nextTestKey], next, NOW),
    "staged next secret was rejected during rotation",
  );
  assert(
    !(await verifyRelayMessageWithSecrets(
      [
        TEST_KEY,
        testKey(0x03),
      ],
      next,
      NOW,
    )),
    "unknown secret was accepted during rotation",
  );
});

Deno.test("formats a bounded GitHub-only message without authentication fields", () => {
  const value = inputs();
  value.relay_signature = "a".repeat(64);
  const message = formatRelayMessage(value);
  assert(message !== null, "valid GitHub message was rejected");
  assert(message.includes("Open in GitHub"), "GitHub link is missing");
  assert(
    !message.includes(value.relay_signature),
    "signature leaked into message",
  );
  assert(
    !message.includes(value.relay_timestamp),
    "relay timestamp leaked into message",
  );
  assert(
    message.includes("03/08/2026 às 09:00:00"),
    "event time was not rendered in pt-BR and Brasília UTC−03:00",
  );
  assert(
    !message.includes("Horário Oficial de Brasília") &&
      !message.includes("UTC−03:00"),
    "technical timezone suffix leaked into the user-facing message",
  );
  assert(
    !message.includes(value.occurred_at),
    "raw ISO-8601 event time leaked into message",
  );

  value.url = "https://example.com/forged";
  assert(formatRelayMessage(value) === null, "non-GitHub URL was accepted");
});

Deno.test("keeps the displayed event time fixed at Brasília UTC−03:00", () => {
  const value = inputs();
  value.occurred_at = "2026-01-01T01:30:00.000Z";
  const yearBoundary = formatRelayMessage(value);
  assert(yearBoundary !== null, "year-boundary message was rejected");
  assert(
    yearBoundary.includes("31/12/2025 às 22:30:00"),
    "UTC−03:00 did not roll the date back correctly",
  );

  value.occurred_at = "2018-11-04T03:30:00.000Z";
  const historical = formatRelayMessage(value);
  assert(historical !== null, "historical message was rejected");
  assert(
    historical.includes("04/11/2018 às 00:30:00"),
    "historical daylight-saving rules changed the required fixed UTC−03:00",
  );
});

Deno.test("does not leak an empty, ambiguous, or invalid event timestamp", () => {
  for (
    const occurredAt of [
      "",
      "not-a-timestamp",
      "0",
      "2026-08-03",
      "08/03/2026",
    ]
  ) {
    const value = inputs();
    value.occurred_at = occurredAt;
    const message = formatRelayMessage(value);
    assert(message !== null, "message without a valid event time was rejected");
    assert(
      message.includes("Data e hora do evento: não informadas"),
      "missing event-time fallback was not rendered in pt-BR",
    );
    assert(
      !message.includes("<!date"),
      "viewer-localized Slack date syntax leaked into the message",
    );
    const deliveryLine = message.split("\n").at(-1) ?? "";
    assert(
      deliveryLine.endsWith(
        " · Data e hora do evento: não informadas",
      ),
      "invalid timestamp leaked into the delivery line",
    );
  }
});
