import { vi } from "vitest";

import type { SlackWorkflowPayload } from "../src/domain";
import type {
  DeliveryInput,
  DeliveryStatus,
  DeliveryStore,
  QueueJob,
  RecoveryClaim,
  SlackDeliveryProtocolActivation,
  SlackDeliveryProtocolActivationResult,
  SlackProgressInput,
  SlackProgressResult,
  SlackTraceReconciliation,
  StoredDelivery,
} from "../src/store";

export const TEST_WEBHOOK_SECRET = "unit-test-github-webhook-secret-32";
export const TEST_SLACK_URL =
  "https://hooks.slack.com/triggers/T00000000/B00000000/TESTTOKEN";
export const TEST_RELAY_SIGNING_SECRET = "vitest-only-relay-signing-secret";

function cloneDelivery(delivery: StoredDelivery): StoredDelivery {
  return structuredClone(delivery);
}

export class MemoryDeliveryStore implements DeliveryStore {
  readonly deliveries = new Map<string, StoredDelivery>();
  readonly appliedSlackTraces = new Set<string>();
  nextSlackAt = 0;
  slackActivityCheckpoint = 0;
  slackDeliveryProtocolActive = true;
  slackDeliveryProtocolRevision: string | null = null;
  slackDeliveryProtocolActivatedAt: number | null = null;
  slackDeliveryProtocolActivationId: string | null = null;
  slackDeliveryProtocolSchemaRevision: string | null = null;
  slackDeliveryProtocolConfirmationOpen = true;
  healthy = true;

  async isSlackDeliveryProtocolActive(): Promise<boolean> {
    return this.slackDeliveryProtocolActive;
  }

  async activateSlackDeliveryProtocol(
    activation: SlackDeliveryProtocolActivation,
  ): Promise<SlackDeliveryProtocolActivationResult> {
    const valid =
      /^[0-9a-f]{64}$/u.test(activation.activationId) &&
      /^[0-9a-f]{40}$/u.test(activation.revision) &&
      activation.schemaRevision === "0004_confirm_slack_delivery" &&
      Number.isSafeInteger(activation.now) &&
      activation.now > 0;
    if (!valid) {
      throw new Error("slack_delivery_protocol_activation_conflict");
    }
    if (!this.slackDeliveryProtocolActive) {
      if (
        this.slackDeliveryProtocolRevision !== null ||
        this.slackDeliveryProtocolActivatedAt !== null ||
        this.slackDeliveryProtocolActivationId !== null ||
        this.slackDeliveryProtocolSchemaRevision !== null ||
        !this.slackDeliveryProtocolConfirmationOpen
      ) {
        throw new Error("slack_delivery_protocol_activation_conflict");
      }
      this.slackDeliveryProtocolActive = true;
      this.slackDeliveryProtocolRevision = activation.revision;
      this.slackDeliveryProtocolActivatedAt = activation.now;
      this.slackDeliveryProtocolActivationId = activation.activationId;
      this.slackDeliveryProtocolSchemaRevision = activation.schemaRevision;
      return "applied";
    }

    if (
      this.slackDeliveryProtocolConfirmationOpen &&
      this.slackDeliveryProtocolRevision === activation.revision &&
      this.slackDeliveryProtocolActivationId === activation.activationId &&
      this.slackDeliveryProtocolSchemaRevision === activation.schemaRevision
    ) {
      return "already_applied";
    }
    throw new Error("slack_delivery_protocol_activation_conflict");
  }

  async insert(input: DeliveryInput): Promise<boolean> {
    if (this.deliveries.has(input.deliveryId)) {
      return false;
    }

    this.deliveries.set(input.deliveryId, {
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      action: input.action,
      repository: input.repository,
      destination: input.destination,
      payload: structuredClone(input.payload),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: input.now,
      lastError: null,
      createdAt: input.now,
      updatedAt: input.now,
      triggerAcceptedAt: null,
      sendStartedAt: null,
      deliveredAt: null,
      slackMessageTs: null,
      slackTraceId: null,
      legacyUnverified: false,
    });
    return true;
  }

  async get(deliveryId: string): Promise<StoredDelivery | null> {
    const delivery = this.deliveries.get(deliveryId);
    return delivery === undefined ? null : cloneDelivery(delivery);
  }

  async markQueued(deliveryId: string, now: number): Promise<void> {
    const delivery = this.require(deliveryId);
    if (delivery.status === "pending" || delivery.status === "enqueueing") {
      delivery.status = "queued";
      delivery.updatedAt = now;
      delivery.lastError = null;
    }
  }

  async markEnqueueFailed(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (
      delivery.status !== "accepted_by_trigger" &&
      delivery.status !== "accepted_by_slack" &&
      delivery.status !== "send_started" &&
      delivery.status !== "delivered" &&
      delivery.status !== "manual_review"
    ) {
      delivery.status = "pending";
      delivery.updatedAt = now;
      delivery.nextAttemptAt = nextAttemptAt;
      delivery.lastError = reason;
    }
  }

  async reserveSlackSlot(
    now: number,
    intervalMilliseconds: number,
    destination: "alerts" | "activity",
  ): Promise<number> {
    const alertHasPriority =
      destination === "activity" &&
      [...this.deliveries.values()].some(
        (delivery) =>
          delivery.destination === "alerts" &&
          (["enqueueing", "queued", "sending"].includes(delivery.status) ||
            (["pending", "dead_letter"].includes(delivery.status) &&
              delivery.nextAttemptAt <= now)),
      );
    if (alertHasPriority) {
      return 1_000;
    }

    if (this.nextSlackAt <= now) {
      this.nextSlackAt = now + intervalMilliseconds;
      return 0;
    }

    return this.nextSlackAt - now;
  }

  async extendSlackCooldown(until: number): Promise<void> {
    this.nextSlackAt = Math.max(this.nextSlackAt, until);
  }

  async claimForSlack(
    deliveryId: string,
    now: number,
  ): Promise<StoredDelivery | null> {
    const delivery = this.deliveries.get(deliveryId);
    if (
      delivery === undefined ||
      delivery.nextAttemptAt > now ||
      !(
        ["pending", "enqueueing", "queued", "dead_letter"] as DeliveryStatus[]
      ).includes(delivery.status)
    ) {
      return null;
    }

    delivery.status = "sending";
    delivery.attemptCount += 1;
    delivery.updatedAt = now;
    delivery.slackTraceId = null;
    return cloneDelivery(delivery);
  }

  async recordFailure(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (delivery.status === "sending") {
      delivery.status = "pending";
      delivery.updatedAt = now;
      delivery.nextAttemptAt = nextAttemptAt;
      delivery.lastError = reason;
    }
  }

  async markAcceptedByTrigger(
    deliveryId: string,
    now: number,
    reconcileAt: number,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (delivery.status === "send_started" || delivery.status === "delivered") {
      delivery.triggerAcceptedAt ??= now;
      if (delivery.status === "send_started") {
        delivery.nextAttemptAt = Math.max(delivery.nextAttemptAt, reconcileAt);
      }
      return;
    }
    if (delivery.status !== "sending") {
      throw new Error("delivery_state_changed_before_trigger_acceptance");
    }
    delivery.status = "accepted_by_trigger";
    delivery.updatedAt = now;
    delivery.triggerAcceptedAt = now;
    delivery.nextAttemptAt = reconcileAt;
    delivery.lastError = null;
  }

  async recordSlackProgress(
    input: SlackProgressInput,
  ): Promise<SlackProgressResult> {
    const delivery = this.require(input.deliveryId);
    if (delivery.destination !== input.destination) {
      throw new Error("delivery_destination_mismatch");
    }
    if (input.phase === "send_started") {
      if (
        delivery.status === "send_started" ||
        delivery.status === "delivered"
      ) {
        return "duplicate";
      }
      if (
        delivery.status !== "sending" &&
        delivery.status !== "accepted_by_slack" &&
        delivery.status !== "accepted_by_trigger" &&
        !(
          delivery.status === "manual_review" &&
          delivery.lastError !== null &&
          ([
            "slack_trigger_request_outcome_ambiguous",
            "slack_trigger_success_confirmation_ambiguous",
            "slack_trigger_http_408_ambiguous",
            "replayed_slack_trigger_attempt_ambiguous",
            "stale_slack_trigger_attempt_ambiguous",
            "dead_letter_slack_trigger_attempt_ambiguous",
          ].includes(delivery.lastError) ||
            /^slack_trigger_http_5\d\d_ambiguous$/u.test(delivery.lastError))
        )
      ) {
        throw new Error("delivery_not_awaiting_slack_progress");
      }
      delivery.status = "send_started";
      delivery.sendStartedAt = input.now;
      delivery.updatedAt = input.now;
      delivery.nextAttemptAt = input.reconcileAt;
      delivery.lastError = null;
      delivery.legacyUnverified = false;
      return "recorded";
    }
    if (input.messageTs === null) {
      throw new Error("slack_message_timestamp_missing");
    }
    if (
      delivery.status === "manual_review" &&
      delivery.lastError === "known_slack_workflow_timeout_message_absent"
    ) {
      throw new Error("known_loss_recovery_authorization_required");
    }
    if (delivery.status === "delivered") {
      if (delivery.slackMessageTs === input.messageTs) return "duplicate";
      throw new Error("slack_message_timestamp_conflict");
    }
    for (const other of this.deliveries.values()) {
      if (
        other.deliveryId !== input.deliveryId &&
        other.destination === input.destination &&
        other.slackMessageTs === input.messageTs
      ) {
        throw new Error("slack_message_timestamp_conflict");
      }
    }
    if (
      ![
        "accepted_by_slack",
        "sending",
        "accepted_by_trigger",
        "send_started",
        "manual_review",
      ].includes(delivery.status)
    ) {
      throw new Error("delivery_not_awaiting_slack_progress");
    }
    delivery.status = "delivered";
    delivery.deliveredAt = input.now;
    delivery.slackMessageTs = input.messageTs;
    delivery.updatedAt = input.now;
    delivery.nextAttemptAt = input.now;
    delivery.lastError = null;
    delivery.legacyUnverified = false;
    return "recorded";
  }

  async markDeadLetter(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (
      delivery.status !== "accepted_by_trigger" &&
      delivery.status !== "accepted_by_slack" &&
      delivery.status !== "send_started" &&
      delivery.status !== "delivered" &&
      delivery.status !== "manual_review"
    ) {
      delivery.status = "dead_letter";
      delivery.updatedAt = now;
      delivery.nextAttemptAt = nextAttemptAt;
      delivery.lastError = reason;
    }
  }

  async markManualReview(
    deliveryId: string,
    now: number,
    reason: string,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (delivery.status !== "delivered") {
      delivery.status = "manual_review";
      delivery.updatedAt = now;
      delivery.lastError = reason;
    }
  }

  async claimRecoverable(
    now: number,
    staleBefore: number,
    maximumAttempts: number,
    limit: number,
  ): Promise<RecoveryClaim[]> {
    const candidates = [...this.deliveries.values()]
      .filter((delivery) => {
        const due =
          (["pending", "dead_letter"] as DeliveryStatus[]).includes(
            delivery.status,
          ) && delivery.nextAttemptAt <= now;
        const stale =
          (["enqueueing", "queued", "sending"] as DeliveryStatus[]).includes(
            delivery.status,
          ) && delivery.updatedAt <= staleBefore;
        return due || stale;
      })
      .sort(
        (left, right) =>
          left.nextAttemptAt - right.nextAttemptAt ||
          left.createdAt - right.createdAt,
      )
      .slice(0, limit);

    const claimed: RecoveryClaim[] = [];
    for (const delivery of candidates) {
      if (delivery.status === "sending") {
        delivery.status = "manual_review";
        delivery.updatedAt = now;
        delivery.lastError = "stale_slack_trigger_attempt_ambiguous";
      } else if (delivery.attemptCount >= maximumAttempts) {
        delivery.status = "manual_review";
        delivery.updatedAt = now;
        delivery.lastError = "maximum_delivery_attempts_reached";
      } else {
        delivery.status = "enqueueing";
        delivery.updatedAt = now;
        delivery.nextAttemptAt = now;
        claimed.push({
          deliveryId: delivery.deliveryId,
          destination: delivery.destination,
        });
      }
    }
    return claimed;
  }

  async recordSlackTrace(
    trace: SlackTraceReconciliation,
    now: number,
  ): Promise<void> {
    const delivery = this.require(trace.deliveryId);
    if (trace.outcome === "pending") return;
    if (this.appliedSlackTraces.has(trace.traceId)) return;
    this.appliedSlackTraces.add(trace.traceId);
    if (delivery.status === "delivered") {
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      return;
    }
    if (trace.outcome === "success") {
      delivery.status = "manual_review";
      delivery.lastError =
        "slack_workflow_succeeded_without_authenticated_receipt";
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      return;
    }
    if (
      trace.sendBoundaryReached ||
      delivery.status === "send_started" ||
      (delivery.legacyUnverified && !trace.preSendFailureProven)
    ) {
      delivery.status = "manual_review";
      delivery.lastError = "slack_workflow_failed_after_send_boundary";
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      return;
    }
    if (!trace.preSendFailureProven) {
      delivery.status = "manual_review";
      delivery.lastError = "slack_workflow_failed_without_pre_send_proof";
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      return;
    }
    const retryableManualAmbiguity =
      delivery.status === "manual_review" &&
      delivery.lastError !== null &&
      ([
        "slack_trigger_request_outcome_ambiguous",
        "slack_trigger_success_confirmation_ambiguous",
        "slack_trigger_http_408_ambiguous",
        "replayed_slack_trigger_attempt_ambiguous",
        "stale_slack_trigger_attempt_ambiguous",
        "dead_letter_slack_trigger_attempt_ambiguous",
      ].includes(delivery.lastError) ||
        /^slack_trigger_http_5\d\d_ambiguous$/u.test(delivery.lastError));
    if (
      delivery.status === "accepted_by_trigger" ||
      delivery.status === "accepted_by_slack" ||
      retryableManualAmbiguity
    ) {
      delivery.status = "pending";
      delivery.nextAttemptAt = now;
      delivery.lastError = "slack_workflow_failed_before_send_boundary";
      delivery.slackTraceId = trace.traceId;
      delivery.legacyUnverified = false;
      delivery.updatedAt = now;
      return;
    }
    delivery.status = "manual_review";
    delivery.lastError = "slack_reconciliation_state_conflict";
    delivery.updatedAt = now;
  }

  async getSlackActivityCheckpoint(): Promise<number> {
    return this.slackActivityCheckpoint;
  }

  async advanceSlackActivityCheckpoint(checkpointUs: number): Promise<number> {
    const unresolved = [...this.deliveries.values()]
      .filter(
        (delivery) =>
          !delivery.legacyUnverified &&
          (["pending", "enqueueing", "queued", "sending"].includes(
            delivery.status,
          ) ||
            delivery.slackTraceId === null),
      )
      .reduce(
        (minimum, delivery) => Math.min(minimum, delivery.updatedAt * 1_000),
        checkpointUs,
      );
    this.slackActivityCheckpoint = Math.max(
      this.slackActivityCheckpoint,
      Math.min(checkpointUs, unresolved),
    );
    return this.slackActivityCheckpoint;
  }

  async purgeDeliveredBefore(cutoff: number): Promise<number> {
    let purged = 0;
    for (const [deliveryId, delivery] of this.deliveries) {
      if (
        delivery.status === "delivered" &&
        delivery.deliveredAt !== null &&
        delivery.deliveredAt < cutoff
      ) {
        this.deliveries.delete(deliveryId);
        purged += 1;
      }
    }
    return purged;
  }

  async healthcheck(now: number): Promise<boolean> {
    return (
      this.healthy &&
      this.slackDeliveryProtocolActive &&
      ![...this.deliveries.values()].some(
        (delivery) =>
          delivery.status === "manual_review" ||
          delivery.status === "dead_letter" ||
          (!delivery.legacyUnverified &&
            [
              "accepted_by_slack",
              "accepted_by_trigger",
              "send_started",
            ].includes(delivery.status) &&
            delivery.nextAttemptAt <= now),
      )
    );
  }

  async hasLegacyUnverifiedDebt(): Promise<boolean> {
    return [...this.deliveries.values()].some(
      (delivery) => delivery.legacyUnverified,
    );
  }

  seed(
    deliveryId: string,
    status: DeliveryStatus,
    now: number,
    overrides: Partial<StoredDelivery> = {},
  ): StoredDelivery {
    const payload = sampleSlackPayload(deliveryId);
    const delivery: StoredDelivery = {
      deliveryId,
      eventType: "workflow_run",
      action: "completed",
      repository: "LCV-Ideas-Software/cross-review",
      destination: "alerts",
      payload,
      status,
      attemptCount: 0,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      triggerAcceptedAt:
        status === "accepted_by_trigger" || status === "accepted_by_slack"
          ? now
          : null,
      sendStartedAt: status === "send_started" ? now : null,
      deliveredAt: status === "delivered" ? now : null,
      slackMessageTs: status === "delivered" ? "1785758400.000001" : null,
      slackTraceId: null,
      legacyUnverified: false,
      ...overrides,
    };
    this.deliveries.set(deliveryId, delivery);
    return delivery;
  }

  private require(deliveryId: string): StoredDelivery {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined) {
      throw new Error(`missing test delivery ${deliveryId}`);
    }
    return delivery;
  }
}

export class FakeQueue {
  readonly sent: QueueJob[] = [];
  fail = false;

  async send(body: QueueJob): Promise<void> {
    if (this.fail) {
      throw new Error("test queue failure");
    }
    this.sent.push(structuredClone(body));
  }
}

export function makeEnv(
  queue: FakeQueue,
  options: {
    githubSecret?: string;
    slackUrl?: string;
    alertsSlackUrl?: string;
    activitySlackUrl?: string;
    activityQueue?: FakeQueue;
    relaySigningSecret?: string;
    relaySigningSecretNext?: string;
    workerRevision?: string;
  } = {},
): Env {
  return {
    ALERT_QUEUE: queue as unknown as Queue,
    ACTIVITY_QUEUE: (options.activityQueue ?? queue) as unknown as Queue,
    DB: {} as D1Database,
    GITHUB_WEBHOOK_SECRET: (options.githubSecret ??
      TEST_WEBHOOK_SECRET) as unknown as SecretsStoreSecret,
    SLACK_ALERTS_WORKFLOW_WEBHOOK_URL: (options.alertsSlackUrl ??
      options.slackUrl ??
      TEST_SLACK_URL) as unknown as SecretsStoreSecret,
    SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL: (options.activitySlackUrl ??
      options.slackUrl ??
      TEST_SLACK_URL) as unknown as SecretsStoreSecret,
    SLACK_RELAY_SIGNING_SECRET: (options.relaySigningSecret ??
      TEST_RELAY_SIGNING_SECRET) as unknown as SecretsStoreSecret,
    SLACK_RELAY_SIGNING_SECRET_NEXT:
      options.relaySigningSecretNext as unknown as SecretsStoreSecret,
    SLACK_RELAY_SIGNING_ACTIVE_SLOT: "current",
    WORKER_VERSION: {
      id: "test-worker-version",
      tag: options.workerRevision ?? "a".repeat(40),
      timestamp: "2026-08-03T12:00:00.000Z",
    },
  };
}

export function sampleSlackPayload(deliveryId: string): SlackWorkflowPayload {
  return {
    source: "GitHub Actions",
    severity: "high",
    repository: "LCV-Ideas-Software/cross-review",
    title: "CI: failure",
    details: "Workflow CI completed with conclusion failure.",
    actor: "dependabot[bot]",
    branch: "dependabot/npm_and_yarn/example-1.0.0",
    url: "https://github.com/LCV-Ideas-Software/cross-review/actions/runs/1",
    occurred_at: "2026-08-03T12:00:00.000Z",
    delivery_id: deliveryId,
    event: "workflow_run",
    action: "completed",
    destination: "alerts",
    relay_timestamp: "",
    relay_signature: "",
  };
}

export function fakeMessage(deliveryId: string): {
  message: Message<QueueJob>;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  const ack = vi.fn();
  const retry = vi.fn();
  const message = {
    ack,
    attempts: 1,
    body: { deliveryId },
    id: `message-${deliveryId}`,
    retry,
    timestamp: new Date("2026-08-03T12:00:00.000Z"),
  } as unknown as Message<QueueJob>;

  return { message, ack, retry };
}

export function workflowPayload(
  conclusion: string = "failure",
): Record<string, unknown> {
  return {
    action: "completed",
    organization: { login: "LCV-Ideas-Software" },
    repository: {
      archived: false,
      full_name: "LCV-Ideas-Software/cross-review",
      owner: { login: "LCV-Ideas-Software" },
    },
    sender: { login: "dependabot[bot]" },
    workflow_run: {
      actor: { login: "dependabot[bot]" },
      conclusion,
      created_at: "2026-08-03T11:58:00Z",
      head_branch: "dependabot/npm_and_yarn/example-1.0.0",
      html_url:
        "https://github.com/LCV-Ideas-Software/cross-review/actions/runs/1",
      name: "CI",
      updated_at: "2026-08-03T12:00:00Z",
    },
  };
}

export async function signedRequest(
  event: string,
  deliveryId: string,
  payload: unknown,
  options: { secret?: string; rawBody?: string } = {},
): Promise<Request> {
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  const body = new TextEncoder().encode(rawBody);
  const secret = options.secret ?? TEST_WEBHOOK_SECRET;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "HMAC" }, key, body),
  );
  const hexadecimal = [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return new Request("https://relay.example/github/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": deliveryId,
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": `sha256=${hexadecimal}`,
    },
    body,
  });
}
