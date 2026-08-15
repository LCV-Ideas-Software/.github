// ADR-001 §6.1/§6.2 — queue consumer. Claim CAS, one plain top-level
// chat.postMessage with delivery metadata and a 30 s abort, outcome applied
// through the total classifier. The queue NEVER retries a classified
// outcome: ambiguous rows belong to the resolver (I1 — no automatic resend).
import { classifyPostMessageOutcome } from "./classifier";
import {
  DISPATCH_CLIENT_TIMEOUT_MS,
  DISPATCH_METADATA_EVENT_TYPE,
  DISPATCH_MINIMUM_SEND_INTERVAL_MS,
  type DispatchDestination,
  type DispatchMode,
  type DispatchStore,
} from "./contract";
import { parseDispatchMode } from "./mode";

const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

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

// Copilot finding F1: mirrors the legacy Slack workflow's timestamp render
// (formatBrasiliaDateTime in
// slack/github-integration/functions/validate_relay_message.ts).
const BRASILIA_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("pt-BR", {
  calendar: "gregory",
  numberingSystem: "latn",
  timeZone: "Etc/GMT+3",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function formatOccurredAt(value: string): string {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    return "Data e hora do evento: não informadas";
  }
  const parts = new Map(
    BRASILIA_DATE_TIME_FORMATTER.formatToParts(new Date(milliseconds)).map(
      ({ type, value: partValue }) => [type, partValue],
    ),
  );
  const day = parts.get("day");
  const month = parts.get("month");
  const year = parts.get("year");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  const second = parts.get("second");
  if (
    day === undefined ||
    month === undefined ||
    year === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return "Data e hora do evento: não informadas";
  }
  return `${day}/${month}/${year} às ${hour}:${minute}:${second}`;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

// Copilot finding F1: the stored payload_json for real traffic is the
// normalized SlackWorkflowPayload (src/domain.ts) — it carries NO `text`
// field, so the JSON.stringify fallback would post raw JSON to Slack.
// Render the same information the legacy Slack workflow displayed
// (formatRelayMessage in
// slack/github-integration/functions/validate_relay_message.ts) as plain
// message text — no blocks, no thread_ts (R15).
function renderWorkflowPayload(
  payload: Record<string, unknown>,
  destination: DispatchDestination,
): string | null {
  const title = stringField(payload, "title");
  const repository = stringField(payload, "repository");
  const url = stringField(payload, "url");
  if (
    title === null ||
    title === "" ||
    repository === null ||
    repository === "" ||
    url === null ||
    url === ""
  ) {
    return null;
  }
  const severity = stringField(payload, "severity") ?? "";
  const source = stringField(payload, "source") ?? "";
  const event = stringField(payload, "event") ?? "";
  const action = stringField(payload, "action") ?? "";
  const branch = stringField(payload, "branch") ?? "";
  const actor = stringField(payload, "actor") ?? "";
  const details = stringField(payload, "details") ?? "";
  const deliveryId = stringField(payload, "delivery_id") ?? "";
  const occurredAt = formatOccurredAt(
    stringField(payload, "occurred_at") ?? "",
  );
  const heading =
    destination === "alerts" ? `*[${severity}] ${title}*` : `*${title}*`;
  return [
    heading,
    `Repository: ${repository}`,
    `Source: ${source} / ${event}:${action}`,
    `Branch: ${branch}`,
    `Actor: ${actor}`,
    details,
    `<${url}|Open in GitHub>`,
    `Delivery: \`${deliveryId}\` · ${occurredAt}`,
  ].join("\n");
}

function messageText(
  payloadJson: string,
  destination: DispatchDestination,
): string {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const record = parsed as Record<string, unknown>;
      const text = record["text"];
      if (typeof text === "string" && text.length > 0) return text;
      const rendered = renderWorkflowPayload(record, destination);
      if (rendered !== null) return rendered;
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
    // §6.8 regime B / R20: egress pauses, the row is untouched, nothing is
    // stranded. The message is ACKED, not retried (cross-review round 4,
    // codex): retrying consumes the queue's finite retry budget, so a long
    // mode-off window pushes the message to the DLQ, and a DLQ delivery that
    // lands AFTER the operator re-enables would dead-letter a healthy queued
    // row — an operator menu step, which R20 forbids. Acking leaves the row
    // `queued` and untouched (alarmed via queued_backlog_stale); the cron's
    // stale-queued republish, itself gated on mode !== "off", re-enters it
    // into the normal pipeline automatically on re-enable.
    message.ack();
    return;
  }
  const row = await deps.store.get(parsed.deliveryId);
  if (row === null || TERMINAL_STATES.has(row.state)) {
    message.ack();
    return;
  }
  if (!row.shadow && row.state === "queued") {
    // Review finding F4 (ADR §10 H19): only a row OBSERVED `queued` may take
    // the slot. The guard used to be `!row.shadow` alone, so a redelivered
    // message for a `sending`, `ambiguous` or `manual` row — routine, the
    // queue being at-least-once — reserved the shared per-destination slot and
    // only then discovered the claim CAS was a no-op. Nothing was sent, yet
    // the next REAL queued alert waited a full interval behind that phantom
    // reservation. Observing `queued` here is not a claim: the claim CAS below
    // is still what decides, so a row that leaves `queued` between this read
    // and the claim is handled exactly as before (claim returns null, ack).
    // Copilot suppressed comment (F7) / ADR §4 item 4 (~1 msg/sec/channel):
    // pace every REAL send through the durable per-destination reservation
    // before the claim — exactly the order the legacy path uses
    // (reserveSlackSlot then claimForSlack, src/index.ts). Reserving after
    // the claim would leave the row in `sending` under a live lease that the
    // retried message cannot re-claim. Shadow rows perform no egress
    // (§9.A1/R7) and are never paced; that also keeps the cron's inline
    // shadow processing, whose retry() is a no-op, free of any wait.
    const waitMs = await deps.store.reserveSendSlot(
      row.destination,
      deps.now(),
      DISPATCH_MINIMUM_SEND_INTERVAL_MS,
    );
    if (waitMs > 0) {
      // Not acked (the row would be stranded), not sent (that is the 429 the
      // design never auto-resends): the message returns with the remaining
      // wait, and the row stays `queued` and claimable.
      message.retry({ delaySeconds: Math.max(1, Math.ceil(waitMs / 1_000)) });
      return;
    }
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
        text: messageText(claimed.payloadJson, claimed.destination),
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
  // Review finding B (class E7): `now` above was sampled BEFORE the request
  // began, and Retry-After means "wait this long from the RESPONSE". A
  // chat.postMessage that takes appreciable time before answering 429 would
  // otherwise persist `next_attempt_ms = request_start + Retry-After`, so near
  // a cron boundary the resolver could call Slack before the interval Slack
  // asked for had elapsed ([E-A12]/R4). The clock is re-sampled after the
  // response is classified, and only the OUTCOME write uses it: `now` stays
  // the claim/send-start instant, which is what the §6.3.1 cooling-off floor
  // is measured from (last_send_start_ms).
  const respondedAtMs = deps.now();
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
      // was in flight — canonical proof still lands durably. Copilot
      // suppressed comment (F6): this call site is the CONSUMER's.
      await deps.store.recordLateProof(
        parsed.deliveryId,
        now,
        outcome.ts,
        outcome.channel,
        "consumer",
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
    // Review finding B (E7): the deadline this call derives
    // (`next_attempt_ms = now + retryAfterMs`) must be anchored on the
    // response, not on the request start.
    respondedAtMs,
    outcome.reason,
    outcome.retryAfterMs,
    "consumer",
    ["sending"],
  );
  message.ack();
}
