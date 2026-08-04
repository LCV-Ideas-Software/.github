import {
  asRecord,
  nestedRecord,
  nestedString,
  normalizeGitHubEvent,
  type RelayDestination,
  SUPPORTED_RELAY_EVENTS,
  TARGET_ORGANIZATION,
} from "./domain";
import {
  readSecret,
  signSlackRelayPayload,
  verifyGitHubSignature,
} from "./security";
import {
  D1DeliveryStore,
  type DeliveryStore,
  type QueueJob,
  type StoredDelivery,
} from "./store";

const WEBHOOK_PATH = "/github/webhook";
const HEALTH_PATH = "/healthz";
const ALERT_QUEUE_NAME = "github-slack-alerts";
const ALERT_DEAD_LETTER_QUEUE = "github-slack-alerts-dlq";
const ACTIVITY_QUEUE_NAME = "github-slack-activity";
const ACTIVITY_DEAD_LETTER_QUEUE = "github-slack-activity-dlq";
const MAX_BODY_BYTES = 25_000_000;
const MINIMUM_SLACK_INTERVAL_MS = 6_100;
const MAXIMUM_DELIVERY_ATTEMPTS = 25;
const RECOVERY_LIMIT = 50;
const STALE_AFTER_MS = 15 * 60 * 1_000;
const DELIVERED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;
const EVENT_NAME_PATTERN = /^[a-z0-9_]{1,64}$/u;
const MINIMUM_SECRET_BYTES = 32;

export interface RuntimeOverrides {
  store?: DeliveryStore;
  now?: () => number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface SchedulerResult {
  purged: number;
  recovered: number;
  enqueueFailures: number;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safeFailureSummary(error: unknown): {
  error_name: string;
  error_message: string;
  error_code?: string;
} {
  const candidate = error instanceof Error ? error : undefined;
  const cause = candidate?.cause;
  const code =
    typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string" &&
      /^[A-Z0-9_]{1,64}$/u.test(cause.code)
      ? cause.code
      : undefined;
  const message = (candidate?.message ?? "non_error_failure")
    .replace(/https?:\/\/[^\s]+/giu, "[redacted-url]")
    .slice(0, 256);

  return {
    error_name: candidate?.name ?? typeof error,
    error_message: message,
    ...(code === undefined ? {} : { error_code: code }),
  };
}

function runtime(
  env: Env,
  overrides?: RuntimeOverrides,
): Required<RuntimeOverrides> {
  return {
    store: overrides?.store ?? new D1DeliveryStore(env.DB),
    now: overrides?.now ?? Date.now,
    fetch:
      overrides?.fetch ??
      ((input, init) => globalThis.fetch(input, init)),
    sleep: overrides?.sleep ?? ((milliseconds) => scheduler.wait(milliseconds)),
  };
}

function validDeliveryId(value: unknown): value is string {
  return typeof value === "string" && DELIVERY_ID_PATTERN.test(value);
}

function destinationQueue(env: Env, destination: RelayDestination): Queue {
  return destination === "alerts" ? env.ALERT_QUEUE : env.ACTIVITY_QUEUE;
}

function queueJob(value: unknown): QueueJob | null {
  const record = asRecord(value);
  const deliveryId = record?.deliveryId;
  return validDeliveryId(deliveryId) ? { deliveryId } : null;
}

function repositoryFromPayload(payload: Record<string, unknown>): {
  fullName: string;
  archived: boolean;
  owner: string;
  defaultBranch: string;
} | null {
  const repository = nestedRecord(payload, "repository");
  if (repository === undefined) {
    return null;
  }

  const fullName = nestedString(repository, "full_name");
  const owner = nestedString(repository, "owner", "login");
  return {
    fullName,
    owner,
    defaultBranch: nestedString(repository, "default_branch"),
    archived: repository.archived === true,
  };
}

function sameOrganization(login: string): boolean {
  return login.toLowerCase() === TARGET_ORGANIZATION.toLowerCase();
}

function contentLengthTooLarge(request: Request): boolean {
  const header = request.headers.get("content-length");
  if (header === null) {
    return false;
  }

  const length = Number.parseInt(header, 10);
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

function hasSafeSecretLength(value: string): boolean {
  return new TextEncoder().encode(value).byteLength >= MINIMUM_SECRET_BYTES;
}

async function readBodyWithLimit(
  request: Request,
): Promise<{ kind: "ok"; body: ArrayBuffer } | { kind: "too_large" }> {
  if (request.body === null) {
    return { kind: "ok", body: new ArrayBuffer(0) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      total += result.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("payload_too_large");
        return { kind: "too_large" };
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { kind: "ok", body: combined.buffer };
}

export async function handleFetch(
  request: Request,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<Response> {
  const url = new URL(request.url);
  const dependencies = runtime(env, overrides);

  if (url.pathname === HEALTH_PATH && request.method === "GET") {
    try {
      const [
        healthy,
        githubSecret,
        alertsUrl,
        activityUrl,
        relaySigningSecret,
      ] = await Promise.all([
        dependencies.store.healthcheck(),
        readSecret(env.GITHUB_WEBHOOK_SECRET),
        readSecret(env.SLACK_ALERTS_WORKFLOW_WEBHOOK_URL),
        readSecret(env.SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL),
        readSecret(env.SLACK_RELAY_SIGNING_SECRET),
      ]);
      const ready =
        healthy &&
        hasSafeSecretLength(githubSecret) &&
        hasSafeSecretLength(relaySigningSecret) &&
        slackWorkflowUrl(alertsUrl) !== null &&
        slackWorkflowUrl(activityUrl) !== null;
      return jsonResponse(
        { status: ready ? "ready" : "unavailable" },
        ready ? 200 : 503,
      );
    } catch {
      return jsonResponse({ status: "unavailable" }, 503);
    }
  }

  if (url.pathname !== WEBHOOK_PATH) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (contentLengthTooLarge(request)) {
    return jsonResponse({ error: "payload_too_large" }, 413);
  }

  const event = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  const signature = request.headers.get("x-hub-signature-256") ?? "";

  if (
    !EVENT_NAME_PATTERN.test(event) ||
    !validDeliveryId(deliveryId) ||
    signature === ""
  ) {
    return jsonResponse({ error: "invalid_github_headers" }, 400);
  }

  let bodyResult: Awaited<ReturnType<typeof readBodyWithLimit>>;
  try {
    bodyResult = await readBodyWithLimit(request);
  } catch {
    return jsonResponse({ error: "invalid_request_body" }, 400);
  }

  if (bodyResult.kind === "too_large") {
    return jsonResponse({ error: "payload_too_large" }, 413);
  }
  const body = bodyResult.body;

  let webhookSecret: string;
  try {
    webhookSecret = await readSecret(env.GITHUB_WEBHOOK_SECRET);
  } catch {
    return jsonResponse({ error: "webhook_verification_unavailable" }, 503);
  }
  if (!hasSafeSecretLength(webhookSecret)) {
    return jsonResponse({ error: "webhook_verification_unavailable" }, 503);
  }

  let signatureIsValid: boolean;
  try {
    signatureIsValid = await verifyGitHubSignature(
      body,
      signature,
      webhookSecret,
    );
  } catch {
    return jsonResponse({ error: "webhook_verification_unavailable" }, 503);
  }

  if (!signatureIsValid) {
    return jsonResponse({ error: "invalid_signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body);
    const parsed = JSON.parse(decoded) as unknown;
    const record = asRecord(parsed);
    if (record === undefined) {
      return jsonResponse({ error: "invalid_json_payload" }, 400);
    }
    payload = record;
  } catch {
    return jsonResponse({ error: "invalid_json_payload" }, 400);
  }

  const organization = nestedString(payload, "organization", "login");
  if (!sameOrganization(organization)) {
    return jsonResponse({ error: "organization_not_allowed" }, 403);
  }

  if (event === "ping") {
    return jsonResponse({ accepted: true, event: "ping" }, 200);
  }

  if (!SUPPORTED_RELAY_EVENTS.has(event)) {
    return jsonResponse(
      { accepted: false, ignored: true, reason: "event_not_supported" },
      202,
    );
  }

  const repository = repositoryFromPayload(payload);
  if (
    repository === null ||
    repository.fullName === "" ||
    !sameOrganization(repository.owner)
  ) {
    return jsonResponse({ error: "repository_not_allowed" }, 403);
  }

  if (repository.archived) {
    return jsonResponse(
      { accepted: false, ignored: true, reason: "repository_archived" },
      202,
    );
  }

  const normalized = normalizeGitHubEvent(
    event,
    payload,
    deliveryId,
    repository.fullName,
    repository.defaultBranch,
  );
  if (normalized.kind === "ignored") {
    return jsonResponse(
      { accepted: false, ignored: true, reason: normalized.reason },
      202,
    );
  }

  const now = dependencies.now();
  let inserted: boolean;
  try {
    inserted = await dependencies.store.insert({
      deliveryId,
      eventType: event,
      action: normalized.payload.action,
      repository: normalized.payload.repository,
      destination: normalized.destination,
      payload: normalized.payload,
      now,
    });
  } catch {
    return jsonResponse({ error: "persistence_unavailable" }, 503);
  }

  if (!inserted) {
    return jsonResponse({ accepted: true, duplicate: true }, 202);
  }

  try {
    await destinationQueue(env, normalized.destination).send({ deliveryId });
  } catch {
    await dependencies.store.markEnqueueFailed(
      deliveryId,
      now,
      now + 5_000,
      "queue_enqueue_failed",
    );
    return jsonResponse(
      { error: "queue_unavailable", recovery_scheduled: true },
      503,
    );
  }

  try {
    await dependencies.store.markQueued(deliveryId, now);
  } catch {
    // The persisted pending row and queued delivery are intentionally retained.
    // Either the queue consumer or the scheduled recovery loop can finish it.
  }

  return jsonResponse({ accepted: true, queued: true }, 202);
}

function slackWorkflowUrl(value: string): string | null {
  if (
    !/^https:\/\/hooks\.slack\.com\/triggers\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(
      value,
    )
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "hooks.slack.com" ||
      !parsed.pathname.startsWith("/triggers/") ||
      parsed.port !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function defaultRetrySeconds(attemptCount: number): number {
  return Math.max(
    2,
    Math.min(3_600, 2 ** Math.min(Math.max(attemptCount, 1), 12)),
  );
}

function retryAfterSeconds(header: string | null, now: number): number | null {
  if (header === null || header.trim() === "") {
    return null;
  }

  const numeric = Number(header);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.max(2, Math.min(43_200, Math.ceil(numeric)));
  }

  const date = Date.parse(header);
  if (!Number.isFinite(date)) {
    return null;
  }

  return Math.max(2, Math.min(43_200, Math.ceil((date - now) / 1_000)));
}

function retryMessage(message: Message<QueueJob>, delaySeconds: number): void {
  message.retry({ delaySeconds: Math.max(2, Math.ceil(delaySeconds)) });
}

async function cancelUnreadResponseBody(response: Response): Promise<void> {
  if (response.body === null || response.bodyUsed) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // Cleanup failure must not bypass the durable status and retry handling.
  }
}

async function recordSlackFailure(
  store: DeliveryStore,
  delivery: StoredDelivery,
  message: Message<QueueJob>,
  now: number,
  reason: string,
  delaySeconds: number,
): Promise<void> {
  const boundedDelay = Math.max(2, Math.min(43_200, Math.ceil(delaySeconds)));
  await store.recordFailure(
    delivery.deliveryId,
    now,
    now + boundedDelay * 1_000,
    reason,
  );
  retryMessage(message, boundedDelay);
}

export async function processPrimaryMessage(
  message: Message<QueueJob>,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  const dependencies = runtime(env, overrides);
  const job = queueJob(message.body);
  if (job === null) {
    message.ack();
    return;
  }

  const existing = await dependencies.store.get(job.deliveryId);
  if (
    existing === null ||
    existing.status === "accepted_by_slack" ||
    existing.status === "manual_review"
  ) {
    message.ack();
    return;
  }

  if (existing.attemptCount >= MAXIMUM_DELIVERY_ATTEMPTS) {
    await dependencies.store.markManualReview(
      existing.deliveryId,
      dependencies.now(),
      "maximum_delivery_attempts_reached",
    );
    message.ack();
    return;
  }

  let now = dependencies.now();
  if (existing.nextAttemptAt > now) {
    const waitMilliseconds = existing.nextAttemptAt - now;
    if (waitMilliseconds <= MINIMUM_SLACK_INTERVAL_MS) {
      await dependencies.sleep(waitMilliseconds);
      now = dependencies.now();
    }

    if (existing.nextAttemptAt > now) {
      retryMessage(message, Math.ceil((existing.nextAttemptAt - now) / 1_000));
      return;
    }
  }

  while (true) {
    const waitMilliseconds = await dependencies.store.reserveSlackSlot(
      now,
      MINIMUM_SLACK_INTERVAL_MS,
      existing.destination,
    );
    if (waitMilliseconds === 0) {
      break;
    }

    if (waitMilliseconds > MINIMUM_SLACK_INTERVAL_MS) {
      retryMessage(message, Math.ceil(waitMilliseconds / 1_000));
      return;
    }

    await dependencies.sleep(waitMilliseconds);
    now = dependencies.now();
  }

  const delivery = await dependencies.store.claimForSlack(job.deliveryId, now);
  if (delivery === null) {
    retryMessage(message, 2);
    return;
  }

  let webhookUrl: string | null;
  let relaySigningSecret: string | null;
  try {
    const destinationBinding =
      delivery.destination === "alerts"
        ? env.SLACK_ALERTS_WORKFLOW_WEBHOOK_URL
        : env.SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL;
    webhookUrl = slackWorkflowUrl(await readSecret(destinationBinding));
    relaySigningSecret = await readSecret(env.SLACK_RELAY_SIGNING_SECRET);
    if (!hasSafeSecretLength(relaySigningSecret)) {
      relaySigningSecret = null;
    }
  } catch {
    webhookUrl = null;
    relaySigningSecret = null;
  }

  if (webhookUrl === null || relaySigningSecret === null) {
    await recordSlackFailure(
      dependencies.store,
      delivery,
      message,
      now,
      "slack_webhook_configuration_invalid",
      defaultRetrySeconds(delivery.attemptCount),
    );
    return;
  }

  const outboundPayload = {
    ...delivery.payload,
    destination: delivery.destination,
    relay_timestamp: String(Math.floor(now / 1_000)),
    relay_signature: "",
  };
  try {
    outboundPayload.relay_signature = await signSlackRelayPayload(
      outboundPayload,
      relaySigningSecret,
    );
  } catch {
    await recordSlackFailure(
      dependencies.store,
      delivery,
      message,
      now,
      "relay_signature_generation_failed",
      defaultRetrySeconds(delivery.attemptCount),
    );
    return;
  }

  let response: Response;
  try {
    response = await dependencies.fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(outboundPayload),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "slack_request_failed",
        ...safeFailureSummary(error),
      }),
    );
    await recordSlackFailure(
      dependencies.store,
      delivery,
      message,
      now,
      "slack_request_failed",
      defaultRetrySeconds(delivery.attemptCount),
    );
    return;
  }

  if (response.ok) {
    let confirmation: Record<string, unknown> | undefined;
    try {
      confirmation = asRecord(await response.json());
    } catch {
      confirmation = undefined;
    }

    if (confirmation?.ok !== true) {
      await recordSlackFailure(
        dependencies.store,
        delivery,
        message,
        now,
        "slack_success_confirmation_invalid",
        defaultRetrySeconds(delivery.attemptCount),
      );
      return;
    }

    await dependencies.store.markAcceptedBySlack(delivery.deliveryId, now);
    message.ack();
    return;
  }

  await cancelUnreadResponseBody(response);

  const retryDelay =
    retryAfterSeconds(response.headers.get("retry-after"), now) ??
    defaultRetrySeconds(delivery.attemptCount);
  if (response.status === 429) {
    await dependencies.store.extendSlackCooldown(now + retryDelay * 1_000);
  }

  await recordSlackFailure(
    dependencies.store,
    delivery,
    message,
    now,
    `slack_http_${response.status}`,
    retryDelay,
  );
}

function deadLetterDelayMilliseconds(attemptCount: number): number {
  const seconds = Math.max(
    300,
    Math.min(21_600, 2 ** Math.min(attemptCount + 4, 14)),
  );
  return seconds * 1_000;
}

export async function processDeadLetterMessage(
  message: Message<QueueJob>,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  const dependencies = runtime(env, overrides);
  const job = queueJob(message.body);
  if (job === null) {
    message.ack();
    return;
  }

  const delivery = await dependencies.store.get(job.deliveryId);
  if (
    delivery === null ||
    delivery.status === "accepted_by_slack" ||
    delivery.status === "manual_review"
  ) {
    message.ack();
    return;
  }

  const now = dependencies.now();
  if (delivery.attemptCount >= MAXIMUM_DELIVERY_ATTEMPTS) {
    await dependencies.store.markManualReview(
      delivery.deliveryId,
      now,
      "maximum_delivery_attempts_reached_in_dlq",
    );
    message.ack();
    return;
  }

  await dependencies.store.markDeadLetter(
    delivery.deliveryId,
    now,
    now + deadLetterDelayMilliseconds(delivery.attemptCount),
    "cloudflare_queue_dead_letter",
  );
  message.ack();
}

export async function handleQueue(
  batch: MessageBatch<QueueJob>,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  for (const message of batch.messages) {
    if (
      batch.queue === ALERT_DEAD_LETTER_QUEUE ||
      batch.queue === ACTIVITY_DEAD_LETTER_QUEUE
    ) {
      await processDeadLetterMessage(message, env, overrides);
    } else if (
      batch.queue === ALERT_QUEUE_NAME ||
      batch.queue === ACTIVITY_QUEUE_NAME
    ) {
      await processPrimaryMessage(message, env, overrides);
    } else {
      throw new Error("unexpected_queue");
    }
  }
}

export async function runScheduledRecovery(
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<SchedulerResult> {
  const dependencies = runtime(env, overrides);
  const now = dependencies.now();
  const purged = await dependencies.store.purgeAcceptedBefore(
    now - DELIVERED_RETENTION_MS,
  );
  const recoverable = await dependencies.store.claimRecoverable(
    now,
    now - STALE_AFTER_MS,
    MAXIMUM_DELIVERY_ATTEMPTS,
    RECOVERY_LIMIT,
  );

  let recovered = 0;
  let enqueueFailures = 0;

  for (const recovery of recoverable) {
    try {
      await destinationQueue(env, recovery.destination).send({
        deliveryId: recovery.deliveryId,
      });
      await dependencies.store.markQueued(recovery.deliveryId, now);
      recovered += 1;
    } catch {
      enqueueFailures += 1;
      await dependencies.store.markEnqueueFailed(
        recovery.deliveryId,
        now,
        now + 5 * 60 * 1_000,
        "scheduled_queue_enqueue_failed",
      );
    }
  }

  console.info(
    JSON.stringify({
      enqueue_failures: enqueueFailures,
      event: "scheduled_recovery",
      purged,
      recovered,
    }),
  );

  return { purged, recovered, enqueueFailures };
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch {
      console.error(
        JSON.stringify({ event: "webhook_handler_unexpected_failure" }),
      );
      return jsonResponse({ error: "internal_error" }, 500);
    }
  },

  async queue(batch, env): Promise<void> {
    await handleQueue(batch, env);
  },

  async scheduled(_controller, env): Promise<void> {
    await runScheduledRecovery(env);
  },
} satisfies ExportedHandler<Env, QueueJob>;
