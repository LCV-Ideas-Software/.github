// ADR-001 §6.1/§6.2 — queue consumer. Claim CAS, one plain top-level
// chat.postMessage with delivery metadata and a 30 s abort, outcome applied
// through the total classifier. The queue NEVER retries a classified
// outcome: ambiguous rows belong to the resolver (I1 — no automatic resend).
import { classifyPostMessageOutcome } from "./classifier";
import {
  DISPATCH_CLIENT_TIMEOUT_MS,
  DISPATCH_METADATA_EVENT_TYPE,
  type DispatchDestination,
  type DispatchMode,
  type DispatchStore,
} from "./contract";
import { parseDispatchMode } from "./mode";

const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
// §6.8 regime B: mode off defers the message so re-enabling re-enters the
// normal pipeline; the delay keeps the queue from spinning.
const MODE_OFF_RETRY_DELAY_SECONDS = 60;

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "delivered",
  "dead_letter",
  "closed_manual",
]);

// The index.ts queue adapter injects parseDispatchMode(env.DISPATCH_MODE)
// into the body at consume time, so an in-flight message is processed under
// the mode active WHEN CONSUMED (§6.8/R20).
export interface DispatchQueueMessage {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface DispatchConsumerDeps {
  store: DispatchStore;
  fetch: typeof fetch;
  now: () => number;
  botToken: string;
  channelFor: (destination: DispatchDestination) => string;
}

interface ParsedQueueBody {
  deliveryId: string;
  mode: DispatchMode;
}

function parseQueueBody(body: unknown): ParsedQueueBody | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  const deliveryId = candidate["deliveryId"];
  if (typeof deliveryId !== "string" || deliveryId.length === 0) return null;
  return { deliveryId, mode: parseDispatchMode(candidate["mode"]) };
}

function messageText(payloadJson: string): string {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const text = (parsed as Record<string, unknown>)["text"];
      if (typeof text === "string" && text.length > 0) return text;
    }
    return JSON.stringify(parsed);
  } catch {
    // payload_json is CHECK json_valid at rest; defensive only.
    return payloadJson;
  }
}

function fetchFailureReason(error: unknown): string {
  return error instanceof Error
    ? `fetch_failed_${error.name}`.slice(0, 128)
    : "fetch_failed";
}

export async function processDispatchMessage(
  message: DispatchQueueMessage,
  deps: DispatchConsumerDeps,
): Promise<void> {
  const parsed = parseQueueBody(message.body);
  if (parsed === null) {
    message.ack();
    return;
  }
  if (parsed.mode === "off") {
    // §6.8 regime B / R20: egress pauses, the row is untouched, the message
    // is deferred — nothing is stranded.
    message.retry({ delaySeconds: MODE_OFF_RETRY_DELAY_SECONDS });
    return;
  }
  const row = await deps.store.get(parsed.deliveryId);
  if (row === null || TERMINAL_STATES.has(row.state)) {
    message.ack();
    return;
  }
  const now = deps.now();
  const claimed = await deps.store.claim(parsed.deliveryId, now);
  if (claimed === null) {
    // §6.1: the claim CAS matched 0 rows — a duplicate queue delivery or a
    // row already owned by resolver/menu; ack (§6.5 case 11).
    message.ack();
    return;
  }
  if (claimed.shadow) {
    // §9.A1 (R7): shadow never calls the Slack API — the row is terminally
    // recorded delivered without ts (markDelivered nulls the identifiers
    // for shadow rows).
    await deps.store.markDelivered(
      parsed.deliveryId,
      now,
      "",
      "",
      "consumer",
      ["sending"],
      JSON.stringify({ shadow: true, egress: "none" }),
    );
    message.ack();
    return;
  }
  let response: Response;
  let bodyText: string;
  try {
    response = await deps.fetch(POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      // R15: plain top-level message only — never thread_ts/reply_broadcast.
      // §6.6: metadata carries only the delivery GUID + attempt.
      body: JSON.stringify({
        channel: deps.channelFor(claimed.destination),
        text: messageText(claimed.payloadJson),
        metadata: {
          event_type: DISPATCH_METADATA_EVENT_TYPE,
          event_payload: {
            delivery_id: parsed.deliveryId,
            attempt: claimed.attemptCount,
          },
        },
      }),
      // §6.1: hard client timeout 30 s (abort) — the precondition of the
      // resolver's cooling-off floor (R12).
      signal: AbortSignal.timeout(DISPATCH_CLIENT_TIMEOUT_MS),
    });
    bodyText = await response.text();
  } catch (error) {
    // §6.5 rows 7-8: exception timing proves nothing — fail-safe ambiguous;
    // the resolver owns the row now.
    await deps.store.markAmbiguous(
      parsed.deliveryId,
      now,
      fetchFailureReason(error),
      null,
      "consumer",
      ["sending"],
    );
    message.ack();
    return;
  }
  const outcome = classifyPostMessageOutcome({
    httpStatus: response.status,
    headers: response.headers,
    bodyText,
  });
  if (outcome.kind === "delivered") {
    const recorded = await deps.store.markDelivered(
      parsed.deliveryId,
      now,
      outcome.ts,
      outcome.channel,
      "consumer",
      ["sending"],
      JSON.stringify({ source: "chat.postMessage", ts: outcome.ts }),
    );
    if (!recorded) {
      // §6.3 late-proof rule (R2): the row left `sending` while the send
      // was in flight — canonical proof still lands durably.
      await deps.store.recordLateProof(
        parsed.deliveryId,
        now,
        outcome.ts,
        outcome.channel,
      );
    }
    message.ack();
    return;
  }
  if (outcome.kind === "manual") {
    await deps.store.markManual(
      parsed.deliveryId,
      now,
      outcome.errorCode,
      "consumer",
      ["sending"],
    );
    message.ack();
    return;
  }
  await deps.store.markAmbiguous(
    parsed.deliveryId,
    now,
    outcome.reason,
    outcome.retryAfterMs,
    "consumer",
    ["sending"],
  );
  message.ack();
}
