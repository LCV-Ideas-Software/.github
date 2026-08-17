import { vi } from "vitest";

import type { SlackWorkflowPayload } from "../src/domain";
import {
  planSlackReconciliation,
  SlackReconciliationPlanConflictError,
  type SlackReconciliationDeliverySnapshot,
  type SlackReconciliationTraceSnapshot,
} from "../src/slack-reconciliation-plan";
import {
  SlackProgressConflictError,
  SlackReconciliationConflictError,
  SLACK_ACTIVITY_CHECKPOINT_OVERLAP_US,
  SLACK_DELIVERY_PROTOCOL_SCHEMA_REVISION,
  SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATED_AT,
  SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATION_ID,
  SLACK_DELIVERY_PROTOCOL_SEALED_REVISION,
  type DeliveryInput,
  type DeliveryStatus,
  type DeliveryStore,
  type QueueJob,
  type RecoveryClaim,
  type SlackProgressInput,
  type SlackProgressResult,
  type SlackReconciliationInput,
  type SlackReconciliationReportResult,
  type SlackTraceReconciliation,
  type SlackTraceRecordResult,
  type StoredDelivery,
} from "../src/store";

export const TEST_WEBHOOK_SECRET = "unit-test-github-webhook-secret-32";
export const TEST_SLACK_URL =
  "https://hooks.slack.com/triggers/T00000000/B00000000/TESTTOKEN";
export const TEST_RELAY_SIGNING_SECRET = "vitest-only-relay-signing-secret";
export const TEST_RELAY_SIGNING_SECRET_NEXT =
  "vitest-only-next-relay-signing-secret";

function cloneDelivery(delivery: StoredDelivery): StoredDelivery {
  return structuredClone(delivery);
}

type MemorySlackTrace = {
  deliveryId: string;
  outcome: SlackTraceReconciliation["outcome"];
  attemptCount: number;
  sendExecutionId: string | null;
  destination: "alerts" | "activity" | null;
  slackChannelId: string | null;
  messageTs: string | null;
  sendBoundaryReached: boolean;
  preSendFailureProven: boolean;
  startedAtUs: number;
  completedAtUs: number | null;
  updatedAt: number;
  applied: boolean;
};

type MemorySlackTraceHydration = {
  firstObservedUs: number;
  lastObservedUs: number;
  lastHydratedAt: number;
  status: "pending" | "debt";
  debtReason: "retention_expired" | "pagination_bound" | null;
  updatedAt: number;
};

export class MemoryDeliveryStore implements DeliveryStore {
  readonly deliveries = new Map<string, StoredDelivery>();
  readonly slackTraces = new Map<string, MemorySlackTrace>();
  readonly slackTraceHydrations = new Map<string, MemorySlackTraceHydration>();
  readonly slackReconciliationReports = new Map<
    string,
    SlackReconciliationReportResult
  >();
  readonly reportedSlackErrorTraces = new Map<string, string | null>();
  nextSlackAt = 0;
  slackActivityCheckpoint = 0;
  slackActivityResumeFrom: number | null = null;
  slackDeliveryProtocolActive = true;
  slackDeliveryProtocolRevision: string | null =
    SLACK_DELIVERY_PROTOCOL_SEALED_REVISION;
  slackDeliveryProtocolActivatedAt: number | null =
    SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATED_AT;
  slackDeliveryProtocolActivationId: string | null =
    SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATION_ID;
  slackDeliveryProtocolSchemaRevision: string | null =
    SLACK_DELIVERY_PROTOCOL_SCHEMA_REVISION;
  slackDeliveryProtocolConfirmationOpen = false;
  slackDeliveryProtocolSealGuardsPresent = true;
  healthy = true;

  async isSlackDeliveryProtocolActive(
    expectedRevision: string,
  ): Promise<boolean> {
    return (
      /^[0-9a-f]{40}$/u.test(expectedRevision) &&
      this.slackDeliveryProtocolActive &&
      this.slackDeliveryProtocolRevision ===
        SLACK_DELIVERY_PROTOCOL_SEALED_REVISION &&
      this.slackDeliveryProtocolActivatedAt ===
        SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATED_AT &&
      this.slackDeliveryProtocolActivationId ===
        SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATION_ID &&
      this.slackDeliveryProtocolSchemaRevision ===
        SLACK_DELIVERY_PROTOCOL_SCHEMA_REVISION &&
      !this.slackDeliveryProtocolConfirmationOpen &&
      this.slackDeliveryProtocolSealGuardsPresent
    );
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
      slackSendExecutionId: null,
      legacyUnverified: false,
    });
    return true;
  }

  async get(deliveryId: string): Promise<StoredDelivery | null> {
    const delivery = this.deliveries.get(deliveryId);
    return delivery === undefined ? null : cloneDelivery(delivery);
  }

  async resolveSlackTraceIdentityBySendExecutionId(
    sendExecutionId: string,
  ): Promise<{
    deliveryId: string;
    destination: "alerts" | "activity";
    attemptCount: number;
  } | null> {
    const matches = [...this.deliveries.values()].filter(
      (delivery) => delivery.slackSendExecutionId === sendExecutionId,
    );
    if (matches.length > 1) {
      throw new SlackReconciliationConflictError(
        "slack_send_execution_not_unique",
      );
    }
    const delivery = matches[0];
    return delivery === undefined
      ? null
      : {
          deliveryId: delivery.deliveryId,
          destination: delivery.destination,
          attemptCount: delivery.attemptCount,
        };
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
    if (delivery.slackTraceId !== null) {
      const trace = this.slackTraces.get(delivery.slackTraceId);
      if (
        trace === undefined ||
        !trace.applied ||
        trace.deliveryId !== delivery.deliveryId ||
        trace.outcome !== "error" ||
        trace.attemptCount !== delivery.attemptCount ||
        trace.sendExecutionId !== delivery.slackSendExecutionId ||
        trace.slackChannelId !== null ||
        trace.messageTs !== null ||
        trace.sendBoundaryReached ||
        !trace.preSendFailureProven
      ) {
        return null;
      }
    }
    const incompatibleTrace = [...this.slackTraces.values()].some(
      (trace) =>
        trace.deliveryId === delivery.deliveryId &&
        trace.attemptCount === delivery.attemptCount &&
        (trace.sendExecutionId === null ||
          delivery.slackSendExecutionId === null ||
          trace.sendExecutionId === delivery.slackSendExecutionId) &&
        (!trace.applied ||
          trace.outcome !== "error" ||
          trace.slackChannelId !== null ||
          trace.messageTs !== null ||
          trace.sendBoundaryReached ||
          !trace.preSendFailureProven),
    );
    if (incompatibleTrace) return null;

    delivery.status = "sending";
    delivery.attemptCount += 1;
    delivery.updatedAt = now;
    delivery.slackTraceId = null;
    delivery.slackSendExecutionId = null;
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
      throw new SlackProgressConflictError("delivery_destination_mismatch");
    }
    if (
      !Number.isSafeInteger(input.attemptCount) ||
      input.attemptCount <= 0 ||
      delivery.attemptCount !== input.attemptCount
    ) {
      throw new SlackProgressConflictError("slack_delivery_attempt_conflict");
    }
    if (!/^Fx[A-Za-z0-9]{1,126}$/u.test(input.functionExecutionId)) {
      throw new SlackProgressConflictError("invalid_slack_function_execution");
    }
    if (input.phase === "send_started") {
      if (
        delivery.status === "send_started" ||
        delivery.status === "delivered"
      ) {
        if (delivery.slackSendExecutionId === input.functionExecutionId) {
          return "duplicate";
        }
        throw new SlackProgressConflictError("slack_send_execution_conflict");
      }
      const releasedPreSendRetry =
        (["pending", "enqueueing", "queued", "dead_letter"] as const).includes(
          delivery.status as
            "pending" | "enqueueing" | "queued" | "dead_letter",
        ) &&
        delivery.slackTraceId !== null &&
        delivery.slackSendExecutionId === input.functionExecutionId;
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
        ) &&
        !releasedPreSendRetry
      ) {
        throw new SlackProgressConflictError(
          "delivery_not_awaiting_slack_progress",
        );
      }
      delivery.status = "send_started";
      delivery.sendStartedAt = input.now;
      delivery.updatedAt = input.now;
      delivery.nextAttemptAt = input.reconcileAt;
      delivery.lastError = null;
      delivery.legacyUnverified = false;
      delivery.slackTraceId = null;
      delivery.slackSendExecutionId = input.functionExecutionId;
      return "recorded";
    }
    if (input.messageTs === null) {
      throw new SlackProgressConflictError("slack_message_timestamp_missing");
    }
    if (
      delivery.status === "manual_review" &&
      delivery.lastError === "known_slack_workflow_timeout_message_absent"
    ) {
      throw new SlackProgressConflictError(
        "known_loss_recovery_authorization_required",
      );
    }
    const consumeOwnedHydrationDebt = () => {
      if (
        delivery.status !== "delivered" ||
        delivery.destination !== input.destination ||
        delivery.attemptCount !== input.attemptCount ||
        delivery.slackMessageTs !== input.messageTs ||
        delivery.slackSendExecutionId === null
      ) {
        return;
      }
      for (const [traceId, hydration] of this.slackTraceHydrations) {
        const trace = this.slackTraces.get(traceId);
        if (
          (hydration.status === "pending" || hydration.status === "debt") &&
          trace?.deliveryId === delivery.deliveryId &&
          trace.outcome === "pending" &&
          trace.attemptCount === delivery.attemptCount &&
          (trace.sendExecutionId === null ||
            trace.sendExecutionId === delivery.slackSendExecutionId)
        ) {
          trace.applied = true;
          trace.updatedAt = Math.max(trace.updatedAt, input.now);
          this.slackTraceHydrations.delete(traceId);
        }
      }
    };
    if (delivery.status === "delivered") {
      if (delivery.slackMessageTs === input.messageTs) {
        consumeOwnedHydrationDebt();
        return "duplicate";
      }
      throw new SlackProgressConflictError("slack_message_timestamp_conflict");
    }
    const releasedPreSendRetry =
      (["pending", "enqueueing", "queued", "dead_letter"] as const).includes(
        delivery.status as "pending" | "enqueueing" | "queued" | "dead_letter",
      ) && delivery.slackTraceId !== null;
    if (delivery.slackSendExecutionId === null) {
      throw new SlackProgressConflictError("slack_send_execution_missing");
    }
    for (const other of this.deliveries.values()) {
      if (
        other.deliveryId !== input.deliveryId &&
        other.destination === input.destination &&
        other.slackMessageTs === input.messageTs
      ) {
        throw new SlackProgressConflictError(
          "slack_message_timestamp_conflict",
        );
      }
    }
    if (
      ![
        "accepted_by_slack",
        "sending",
        "accepted_by_trigger",
        "send_started",
        "manual_review",
      ].includes(delivery.status) &&
      !releasedPreSendRetry
    ) {
      throw new SlackProgressConflictError(
        "delivery_not_awaiting_slack_progress",
      );
    }
    const linkedTrace =
      delivery.slackTraceId === null
        ? undefined
        : this.slackTraces.get(delivery.slackTraceId);
    const retainedTraceId =
      linkedTrace?.deliveryId === delivery.deliveryId &&
      linkedTrace.attemptCount === delivery.attemptCount &&
      linkedTrace.sendExecutionId === delivery.slackSendExecutionId &&
      linkedTrace.applied &&
      (linkedTrace.outcome === "success" ||
        (linkedTrace.outcome === "error" && linkedTrace.sendBoundaryReached))
        ? delivery.slackTraceId
        : null;
    delivery.status = "delivered";
    delivery.deliveredAt = input.now;
    delivery.slackMessageTs = input.messageTs;
    delivery.slackTraceId = retainedTraceId;
    delivery.updatedAt = input.now;
    delivery.nextAttemptAt = input.now;
    delivery.lastError = null;
    delivery.legacyUnverified = false;
    consumeOwnedHydrationDebt();
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
  ): Promise<SlackTraceRecordResult> {
    const destination = trace.destination;
    const slackChannelId = trace.slackChannelId;
    const messageTs = trace.messageTs;
    if (
      !Number.isSafeInteger(trace.attemptCount) ||
      trace.attemptCount <= 0 ||
      (trace.sendExecutionId !== null &&
        !/^Fx[A-Za-z0-9]{1,126}$/u.test(trace.sendExecutionId)) ||
      (trace.preSendFailureProven && trace.sendExecutionId === null) ||
      (slackChannelId === null) !== (messageTs === null) ||
      (messageTs !== null &&
        (trace.sendExecutionId === null ||
          !trace.sendBoundaryReached ||
          trace.preSendFailureProven ||
          destination === null ||
          (destination === "alerts" && slackChannelId !== "C0BMUK793NV") ||
          (destination === "activity" && slackChannelId !== "C0BMQMW3L4E") ||
          !/^\d{10,13}\.\d{6}$/u.test(messageTs)))
    ) {
      throw new SlackReconciliationConflictError("invalid_slack_trace_attempt");
    }
    if (trace.outcome !== "pending" && trace.completedAtUs === null) {
      throw new SlackReconciliationConflictError(
        "terminal_slack_trace_missing_completion",
      );
    }
    const delivery = this.deliveries.get(trace.deliveryId);
    if (delivery === undefined) {
      throw new SlackReconciliationConflictError("delivery_not_found");
    }
    if (trace.sendExecutionId !== null) {
      const owner = [...this.deliveries.values()].find(
        (candidate) => candidate.slackSendExecutionId === trace.sendExecutionId,
      );
      if (
        owner !== undefined &&
        (owner.deliveryId !== trace.deliveryId ||
          owner.attemptCount !== trace.attemptCount)
      ) {
        throw new SlackReconciliationConflictError(
          "slack_trace_owner_conflict",
        );
      }
      const traceOwner = [...this.slackTraces.entries()].find(
        ([traceId, candidate]) =>
          traceId !== trace.traceId &&
          candidate.sendExecutionId === trace.sendExecutionId,
      );
      if (traceOwner !== undefined) {
        throw new SlackReconciliationConflictError(
          "slack_trace_send_execution_owner_conflict",
        );
      }
    }
    const previous = this.slackTraces.get(trace.traceId);
    if (previous !== undefined && previous.deliveryId !== trace.deliveryId) {
      throw new SlackReconciliationConflictError(
        "slack_trace_delivery_conflict",
      );
    }
    if (
      previous !== undefined &&
      previous.outcome !== "pending" &&
      trace.outcome !== "pending" &&
      previous.outcome !== trace.outcome
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_outcome_conflict",
      );
    }
    if (
      previous !== undefined &&
      previous.attemptCount !== trace.attemptCount
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_attempt_conflict",
      );
    }
    if (
      previous?.sendExecutionId !== null &&
      previous?.sendExecutionId !== undefined &&
      trace.sendExecutionId !== null &&
      previous.sendExecutionId !== trace.sendExecutionId
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_send_execution_conflict",
      );
    }
    if (
      previous !== undefined &&
      ((previous.destination !== null &&
        destination !== null &&
        previous.destination !== destination) ||
        (previous.slackChannelId !== null &&
          slackChannelId !== null &&
          previous.slackChannelId !== slackChannelId) ||
        (previous.messageTs !== null &&
          messageTs !== null &&
          previous.messageTs !== messageTs))
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_message_evidence_conflict",
      );
    }
    const sendBoundaryReached =
      (previous?.sendBoundaryReached ?? false) || trace.sendBoundaryReached;
    const preSendFailureProven =
      !sendBoundaryReached &&
      ((previous?.preSendFailureProven ?? false) || trace.preSendFailureProven);
    const gainedEvidence =
      previous !== undefined &&
      ((previous.outcome === "pending" && trace.outcome !== "pending") ||
        (previous.sendExecutionId === null && trace.sendExecutionId !== null) ||
        (previous.messageTs === null && messageTs !== null) ||
        (!previous.sendBoundaryReached && sendBoundaryReached) ||
        (!previous.preSendFailureProven && preSendFailureProven));
    const effectiveTrace: MemorySlackTrace = {
      deliveryId: trace.deliveryId,
      outcome:
        previous === undefined || previous.outcome === "pending"
          ? trace.outcome
          : previous.outcome,
      attemptCount: trace.attemptCount,
      sendExecutionId: previous?.sendExecutionId ?? trace.sendExecutionId,
      destination: previous?.destination ?? destination,
      slackChannelId: previous?.slackChannelId ?? slackChannelId,
      messageTs: previous?.messageTs ?? messageTs,
      sendBoundaryReached,
      preSendFailureProven,
      startedAtUs: Math.min(
        previous?.startedAtUs ?? trace.startedAtUs,
        trace.startedAtUs,
      ),
      completedAtUs: previous?.completedAtUs ?? trace.completedAtUs ?? null,
      updatedAt: now,
      applied: previous?.applied ?? false,
    };
    if (
      effectiveTrace.slackChannelId !== null &&
      effectiveTrace.messageTs !== null &&
      [...this.slackTraces.entries()].some(
        ([traceId, candidate]) =>
          traceId !== trace.traceId &&
          candidate.slackChannelId === effectiveTrace.slackChannelId &&
          candidate.messageTs === effectiveTrace.messageTs,
      )
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_message_owner_conflict",
      );
    }
    if (effectiveTrace.messageTs !== null) {
      for (const other of this.deliveries.values()) {
        if (
          other.deliveryId !== delivery.deliveryId &&
          other.destination === delivery.destination &&
          other.slackMessageTs === effectiveTrace.messageTs
        ) {
          throw new SlackReconciliationConflictError(
            "slack_message_timestamp_conflict",
          );
        }
      }
    }
    const observationResult: SlackTraceRecordResult =
      trace.outcome === "pending" && effectiveTrace.outcome !== "pending"
        ? "duplicate"
        : previous === undefined ||
            (previous.outcome === "pending" && gainedEvidence)
          ? "changed"
          : "duplicate";
    this.slackTraces.set(trace.traceId, effectiveTrace);
    if (effectiveTrace.outcome === "pending") return observationResult;
    if (previous?.applied && !gainedEvidence) return observationResult;
    const markApplied = () => {
      effectiveTrace.applied = true;
    };
    if (effectiveTrace.messageTs !== null) {
      if (
        effectiveTrace.sendExecutionId === null ||
        delivery.slackSendExecutionId !== effectiveTrace.sendExecutionId ||
        effectiveTrace.destination !== delivery.destination
      ) {
        throw new SlackReconciliationConflictError(
          "slack_trace_owner_conflict",
        );
      }
      if (
        delivery.status === "delivered" &&
        delivery.slackMessageTs !== effectiveTrace.messageTs
      ) {
        throw new SlackReconciliationConflictError(
          "slack_message_timestamp_conflict",
        );
      }
      delivery.status = "delivered";
      delivery.deliveredAt ??= now;
      delivery.slackMessageTs = effectiveTrace.messageTs;
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      delivery.nextAttemptAt = now;
      delivery.lastError = null;
      delivery.legacyUnverified = false;
      markApplied();
      return observationResult;
    }
    if (delivery.status === "delivered") {
      if (
        delivery.attemptCount === effectiveTrace.attemptCount &&
        delivery.slackSendExecutionId !== null &&
        delivery.slackSendExecutionId === effectiveTrace.sendExecutionId &&
        (effectiveTrace.outcome === "success" || sendBoundaryReached)
      ) {
        delivery.slackTraceId = trace.traceId;
        delivery.updatedAt = now;
      }
      markApplied();
      return observationResult;
    }
    if (delivery.attemptCount !== effectiveTrace.attemptCount) {
      markApplied();
      return observationResult;
    }
    if (
      delivery.slackSendExecutionId !== null &&
      delivery.slackSendExecutionId !== effectiveTrace.sendExecutionId
    ) {
      markApplied();
      return observationResult;
    }
    if (
      effectiveTrace.outcome === "success" &&
      delivery.status === "accepted_by_slack" &&
      delivery.legacyUnverified
    ) {
      if (
        delivery.slackTraceId !== null &&
        delivery.slackTraceId !== trace.traceId
      ) {
        delivery.status = "manual_review";
        delivery.lastError = "slack_legacy_trace_conflict";
      } else {
        delivery.slackTraceId = trace.traceId;
      }
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
    }
    if (effectiveTrace.outcome === "success") {
      delivery.status = "manual_review";
      delivery.lastError =
        "slack_workflow_succeeded_without_authenticated_receipt";
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
    }
    if (
      effectiveTrace.sendBoundaryReached ||
      delivery.status === "send_started" ||
      (!effectiveTrace.preSendFailureProven && delivery.legacyUnverified)
    ) {
      delivery.status = "manual_review";
      delivery.lastError = "slack_workflow_failed_after_send_boundary";
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
    }
    if (!effectiveTrace.preSendFailureProven) {
      delivery.status = "manual_review";
      delivery.lastError = "slack_workflow_failed_without_pre_send_proof";
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
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
    const sameTraceMayReleaseMissingProof =
      delivery.status === "manual_review" &&
      delivery.lastError === "slack_workflow_failed_without_pre_send_proof" &&
      delivery.slackTraceId === trace.traceId &&
      effectiveTrace.preSendFailureProven;
    if (
      delivery.status === "accepted_by_trigger" ||
      delivery.status === "accepted_by_slack" ||
      ((["pending", "enqueueing", "queued", "dead_letter"] as const).includes(
        delivery.status as "pending" | "enqueueing" | "queued" | "dead_letter",
      ) &&
        delivery.slackTraceId === null) ||
      retryableManualAmbiguity ||
      sameTraceMayReleaseMissingProof
    ) {
      if (
        delivery.attemptCount !== effectiveTrace.attemptCount ||
        (delivery.slackSendExecutionId !== null &&
          delivery.slackSendExecutionId !== effectiveTrace.sendExecutionId)
      ) {
        markApplied();
        return observationResult;
      }
      const competingTrace = [...this.slackTraces.entries()].some(
        ([traceId, candidate]) =>
          traceId !== trace.traceId &&
          candidate.deliveryId === delivery.deliveryId &&
          candidate.attemptCount === delivery.attemptCount &&
          (!candidate.applied ||
            candidate.outcome !== "error" ||
            candidate.slackChannelId !== null ||
            candidate.messageTs !== null ||
            candidate.sendBoundaryReached ||
            !candidate.preSendFailureProven),
      );
      if (competingTrace) return observationResult;
      delivery.status = "pending";
      delivery.nextAttemptAt = Math.max(
        delivery.nextAttemptAt,
        now + 20 * 60 * 1_000,
      );
      delivery.lastError = "slack_workflow_failed_before_send_boundary";
      delivery.slackTraceId = trace.traceId;
      delivery.slackSendExecutionId ??= effectiveTrace.sendExecutionId;
      delivery.legacyUnverified = false;
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
    }
    if (delivery.status !== "sending") markApplied();
    return observationResult;
  }

  async getSlackActivityCheckpoint(): Promise<number> {
    return this.slackActivityCheckpoint;
  }

  async getSlackActivityScanState(): Promise<{
    checkpointUs: number;
    resumeFromUs: number | null;
    pendingTraceIds: string[];
    pendingTraceTotal: number;
    pendingTraceOldestUs: number | null;
  }> {
    const pending = [
      ...[...this.slackTraces]
        .filter(
          ([traceId, trace]) =>
            trace.outcome === "pending" &&
            !trace.applied &&
            !this.slackTraceHydrations.has(traceId),
        )
        .map(([traceId, trace]) => ({
          traceId,
          firstObservedUs: trace.startedAtUs,
          lastHydratedAt: 0,
        })),
      ...[...this.slackTraceHydrations]
        .filter(([, hydration]) => hydration.status === "pending")
        .map(([traceId, hydration]) => ({
          traceId,
          firstObservedUs: hydration.firstObservedUs,
          lastHydratedAt: hydration.lastHydratedAt,
        })),
    ].sort(
      (left, right) =>
        left.lastHydratedAt - right.lastHydratedAt ||
        left.firstObservedUs - right.firstObservedUs ||
        (left.traceId < right.traceId
          ? -1
          : left.traceId > right.traceId
            ? 1
            : 0),
    );
    return {
      checkpointUs: this.slackActivityCheckpoint,
      resumeFromUs: this.slackActivityResumeFrom,
      pendingTraceIds: pending.slice(0, 25).map(({ traceId }) => traceId),
      pendingTraceTotal: pending.length,
      pendingTraceOldestUs:
        pending.length === 0
          ? null
          : Math.min(...pending.map(({ firstObservedUs }) => firstObservedUs)),
    };
  }

  async getSlackReconciliationReport(
    reportId: string,
  ): Promise<SlackReconciliationReportResult | null> {
    if (!/^[0-9a-f]{64}$/u.test(reportId)) {
      throw new SlackReconciliationConflictError(
        "invalid_slack_reconciliation_report_id",
      );
    }
    const report = this.slackReconciliationReports.get(reportId);
    return report === undefined ? null : { ...report };
  }

  async reconcileSlackReport(
    input: SlackReconciliationInput,
  ): Promise<SlackReconciliationReportResult> {
    const scanState = input.scanState;
    const hydrations = input.hydrations ?? [];
    const traceIds = new Set(input.traces.map(({ traceId }) => traceId));
    const hydrationIds = new Set(hydrations.map(({ traceId }) => traceId));
    const reportItemCount = input.traces.length + hydrations.length;
    const deliveries = new Map(
      [...this.deliveries].map(([deliveryId, delivery]) => [
        deliveryId,
        cloneDelivery(delivery),
      ]),
    );
    const traces = new Map(
      [...this.slackTraces].map(([traceId, trace]) => [
        traceId,
        structuredClone(trace),
      ]),
    );
    const reports = new Map(
      [...this.slackReconciliationReports].map(([reportId, report]) => [
        reportId,
        { ...report },
      ]),
    );
    const reportedErrors = new Map(this.reportedSlackErrorTraces);
    const storedHydrations = new Map(
      [...this.slackTraceHydrations].map(([traceId, hydration]) => [
        traceId,
        structuredClone(hydration),
      ]),
    );
    const checkpoint = this.slackActivityCheckpoint;
    const resumeFrom = this.slackActivityResumeFrom;
    try {
      if (
        !/^[0-9a-f]{64}$/u.test(input.reportId) ||
        reportItemCount > 25 ||
        traceIds.size !== input.traces.length ||
        hydrationIds.size !== hydrations.length ||
        [...hydrationIds].some((traceId) => traceIds.has(traceId)) ||
        hydrations.some(
          ({
            traceId,
            firstObservedUs,
            lastObservedUs,
            attempted,
            status,
            debtReason,
          }) =>
            !/^Tr[A-Za-z0-9_-]{1,125}$/u.test(traceId) ||
            !Number.isSafeInteger(firstObservedUs) ||
            firstObservedUs < 0 ||
            !Number.isSafeInteger(lastObservedUs) ||
            lastObservedUs < firstObservedUs ||
            typeof attempted !== "boolean" ||
            !["pending", "debt", "legacy"].includes(status) ||
            (status === "debt"
              ? !["retention_expired", "pagination_bound"].includes(
                  debtReason ?? "",
                )
              : debtReason !== null),
        ) ||
        !Number.isSafeInteger(input.checkpointUs) ||
        input.checkpointUs < 0 ||
        !["preserve", "resume", "complete"].includes(scanState) ||
        !Number.isSafeInteger(input.now) ||
        input.now <= 0
      ) {
        throw new SlackReconciliationConflictError(
          "invalid_slack_reconciliation_report",
        );
      }

      const replay = await this.getSlackReconciliationReport(input.reportId);
      if (replay !== null) {
        if (
          replay.traceCount !== reportItemCount ||
          replay.requestedCheckpointUs !== input.checkpointUs
        ) {
          throw new SlackReconciliationConflictError(
            "slack_reconciliation_report_conflict",
          );
        }
        return replay;
      }

      const deliverySnapshots = new Map<
        string,
        SlackReconciliationDeliverySnapshot
      >(
        [...this.deliveries].map(([deliveryId, delivery]) => [
          deliveryId,
          {
            deliveryId,
            destination: delivery.destination,
            status: delivery.status,
            attemptCount: delivery.attemptCount,
            nextAttemptAt: delivery.nextAttemptAt,
            lastError: delivery.lastError,
            updatedAt: delivery.updatedAt,
            deliveredAt: delivery.deliveredAt,
            slackMessageTs: delivery.slackMessageTs,
            slackTraceId: delivery.slackTraceId,
            slackSendExecutionId: delivery.slackSendExecutionId,
            legacyUnverified: delivery.legacyUnverified,
          },
        ]),
      );
      const traceSnapshots = new Map<string, SlackReconciliationTraceSnapshot>(
        [...this.slackTraces].map(([traceId, trace]) => [
          traceId,
          {
            traceId,
            deliveryId: trace.deliveryId,
            outcome: trace.outcome,
            attemptCount: trace.attemptCount,
            sendExecutionId: trace.sendExecutionId,
            destination: trace.destination,
            slackChannelId: trace.slackChannelId,
            messageTs: trace.messageTs,
            sendBoundaryReached: trace.sendBoundaryReached,
            preSendFailureProven: trace.preSendFailureProven,
            startedAtUs: trace.startedAtUs,
            completedAtUs: trace.completedAtUs,
            updatedAt: trace.updatedAt,
            appliedAt: trace.applied ? input.now : null,
          },
        ]),
      );
      let plan: ReturnType<typeof planSlackReconciliation>;
      try {
        plan = planSlackReconciliation({
          traces: input.traces,
          deliveries: deliverySnapshots,
          existingTraces: traceSnapshots,
          now: input.now,
        });
      } catch (error) {
        if (error instanceof SlackReconciliationPlanConflictError) {
          throw new SlackReconciliationConflictError(error.code);
        }
        throw error;
      }

      for (const [deliveryId, snapshot] of plan.deliveries) {
        const delivery = this.deliveries.get(deliveryId);
        if (delivery === undefined) {
          throw new Error("slack_reconciliation_delivery_plan_missing");
        }
        delivery.status = snapshot.status;
        delivery.attemptCount = snapshot.attemptCount;
        delivery.nextAttemptAt = snapshot.nextAttemptAt;
        delivery.lastError = snapshot.lastError;
        delivery.updatedAt = snapshot.updatedAt;
        delivery.deliveredAt = snapshot.deliveredAt;
        delivery.slackMessageTs = snapshot.slackMessageTs;
        delivery.slackTraceId = snapshot.slackTraceId;
        delivery.slackSendExecutionId = snapshot.slackSendExecutionId;
        delivery.legacyUnverified = snapshot.legacyUnverified;
      }
      this.slackTraces.clear();
      for (const [traceId, trace] of plan.traces) {
        this.slackTraces.set(traceId, {
          deliveryId: trace.deliveryId,
          outcome: trace.outcome,
          attemptCount: trace.attemptCount,
          sendExecutionId: trace.sendExecutionId,
          destination: trace.destination,
          slackChannelId: trace.slackChannelId,
          messageTs: trace.messageTs,
          sendBoundaryReached: trace.sendBoundaryReached,
          preSendFailureProven: trace.preSendFailureProven,
          startedAtUs: trace.startedAtUs,
          completedAtUs: trace.completedAtUs,
          updatedAt: trace.updatedAt,
          applied: trace.appliedAt !== null,
        });
      }

      for (const trace of input.traces) {
        if (trace.outcome !== "pending") {
          this.slackTraceHydrations.delete(trace.traceId);
        }
      }
      const hydrationRetentionCutoffUs = Math.max(
        0,
        (input.now - 7 * 24 * 60 * 60 * 1_000) * 1_000,
      );
      const affectedDebtDeliveries = new Set<string>();
      const ownedDebtByDelivery = new Map<
        string,
        Array<{
          traceId: string;
          debtReason: "retention_expired" | "pagination_bound";
        }>
      >();
      for (const hydration of hydrations) {
        if (hydration.status === "legacy") {
          this.slackTraceHydrations.delete(hydration.traceId);
          continue;
        }
        const trace = this.slackTraces.get(hydration.traceId);
        if (
          trace !== undefined &&
          (trace.outcome !== "pending" || trace.applied)
        ) {
          this.slackTraceHydrations.delete(hydration.traceId);
          continue;
        }
        const previous = this.slackTraceHydrations.get(hydration.traceId);
        const firstObservedUs = Math.min(
          previous?.firstObservedUs ?? hydration.firstObservedUs,
          hydration.firstObservedUs,
          trace?.startedAtUs ?? hydration.firstObservedUs,
        );
        const lastObservedUs = Math.max(
          previous?.lastObservedUs ?? hydration.lastObservedUs,
          hydration.lastObservedUs,
        );
        const debtReason =
          previous?.status === "debt"
            ? previous.debtReason
            : hydration.status === "debt"
              ? hydration.debtReason
              : firstObservedUs <= hydrationRetentionCutoffUs
                ? "retention_expired"
                : null;
        const status = debtReason === null ? "pending" : "debt";
        this.slackTraceHydrations.set(hydration.traceId, {
          firstObservedUs,
          lastObservedUs,
          lastHydratedAt: hydration.attempted
            ? Math.max(previous?.lastHydratedAt ?? 0, input.now)
            : (previous?.lastHydratedAt ?? 0),
          status,
          debtReason,
          updatedAt: Math.max(previous?.updatedAt ?? 0, input.now),
        });
        if (status === "debt" && trace?.outcome === "pending") {
          affectedDebtDeliveries.add(trace.deliveryId);
        }
      }
      for (const [traceId, hydration] of this.slackTraceHydrations) {
        const trace = this.slackTraces.get(traceId);
        if (
          hydration.status !== "debt" ||
          hydration.debtReason === null ||
          trace?.outcome !== "pending" ||
          !affectedDebtDeliveries.has(trace.deliveryId)
        ) {
          continue;
        }
        const owned = ownedDebtByDelivery.get(trace.deliveryId) ?? [];
        owned.push({ traceId, debtReason: hydration.debtReason });
        ownedDebtByDelivery.set(trace.deliveryId, owned);
      }
      for (const [traceId, trace] of this.slackTraces) {
        if (
          trace.outcome !== "pending" ||
          !trace.applied ||
          !affectedDebtDeliveries.has(trace.deliveryId)
        ) {
          continue;
        }
        const owned = ownedDebtByDelivery.get(trace.deliveryId) ?? [];
        if (!owned.some((candidate) => candidate.traceId === traceId)) {
          owned.push({ traceId, debtReason: "retention_expired" });
          ownedDebtByDelivery.set(trace.deliveryId, owned);
        }
      }
      for (const [deliveryId, owned] of ownedDebtByDelivery) {
        const delivery = this.deliveries.get(deliveryId);
        if (delivery === undefined) {
          throw new Error("slack_trace_hydration_owner_missing");
        }
        if (delivery.status === "delivered") {
          for (const ownedDebt of owned) {
            const trace = this.slackTraces.get(ownedDebt.traceId);
            if (trace?.outcome !== "pending") continue;
            trace.applied = true;
            trace.updatedAt = input.now;
            this.slackTraceHydrations.delete(ownedDebt.traceId);
          }
          continue;
        }
        delivery.status = "manual_review";
        delivery.updatedAt = input.now;
        const hasDifferentTerminalOwner = [...this.slackTraces].some(
          ([traceId, trace]) =>
            trace.deliveryId === deliveryId &&
            trace.outcome !== "pending" &&
            trace.applied &&
            !owned.some((candidate) => candidate.traceId === traceId),
        );
        if (owned.length !== 1 || hasDifferentTerminalOwner) {
          delivery.lastError = "slack_trace_hydration_owner_ambiguous";
          delivery.slackTraceId = null;
          continue;
        }
        const [ownedDebt] = owned;
        if (ownedDebt === undefined) {
          throw new Error("slack_trace_hydration_owner_missing");
        }
        const trace = this.slackTraces.get(ownedDebt.traceId);
        if (trace === undefined) {
          throw new Error("slack_trace_hydration_owner_missing");
        }
        delivery.lastError = `slack_activity_trace_${ownedDebt.debtReason}`;
        delivery.slackTraceId = ownedDebt.traceId;
        trace.applied = true;
        trace.updatedAt = input.now;
        this.slackTraceHydrations.delete(ownedDebt.traceId);
      }

      const result = await this.finalizeSlackReconciliationReport(
        input.reportId,
        reportItemCount,
        plan.errorTraceIds,
        input.checkpointUs,
        input.now,
      );
      if (scanState === "resume") {
        this.slackActivityResumeFrom = result.checkpointUs;
      } else if (scanState === "complete") {
        this.slackActivityResumeFrom = null;
      }
      return result;
    } catch (error) {
      this.deliveries.clear();
      for (const [deliveryId, delivery] of deliveries) {
        this.deliveries.set(deliveryId, delivery);
      }
      this.slackTraces.clear();
      for (const [traceId, trace] of traces) {
        this.slackTraces.set(traceId, trace);
      }
      this.slackReconciliationReports.clear();
      for (const [reportId, report] of reports) {
        this.slackReconciliationReports.set(reportId, report);
      }
      this.reportedSlackErrorTraces.clear();
      for (const [traceId, reportId] of reportedErrors) {
        this.reportedSlackErrorTraces.set(traceId, reportId);
      }
      this.slackTraceHydrations.clear();
      for (const [traceId, hydration] of storedHydrations) {
        this.slackTraceHydrations.set(traceId, hydration);
      }
      this.slackActivityCheckpoint = checkpoint;
      this.slackActivityResumeFrom = resumeFrom;
      throw error;
    }
  }

  async finalizeSlackReconciliationReport(
    reportId: string,
    traceCount: number,
    errorTraceIds: readonly string[],
    checkpointUs: number,
    now: number,
  ): Promise<SlackReconciliationReportResult> {
    if (
      !/^[0-9a-f]{64}$/u.test(reportId) ||
      !Number.isSafeInteger(traceCount) ||
      traceCount < 0 ||
      traceCount > 25 ||
      errorTraceIds.length > traceCount ||
      new Set(errorTraceIds).size !== errorTraceIds.length ||
      errorTraceIds.some(
        (traceId) => !/^Tr[A-Za-z0-9_-]{1,125}$/u.test(traceId),
      ) ||
      !Number.isSafeInteger(checkpointUs) ||
      checkpointUs < 0 ||
      !Number.isSafeInteger(now) ||
      now <= 0
    ) {
      throw new SlackReconciliationConflictError(
        "invalid_slack_reconciliation_report",
      );
    }
    const replay = this.slackReconciliationReports.get(reportId);
    if (replay !== undefined) {
      if (
        replay.traceCount !== traceCount ||
        replay.requestedCheckpointUs !== checkpointUs
      ) {
        throw new SlackReconciliationConflictError(
          "slack_reconciliation_report_conflict",
        );
      }
      return { ...replay };
    }
    for (const traceId of errorTraceIds) {
      if (this.slackTraces.get(traceId)?.outcome !== "error") {
        throw new SlackReconciliationConflictError(
          "slack_reconciliation_error_trace_missing",
        );
      }
    }
    const novelErrorTraceIds = errorTraceIds.filter(
      (traceId) => !this.reportedSlackErrorTraces.has(traceId),
    );
    const unresolved = [...this.deliveries.values()]
      .filter(
        (delivery) =>
          !delivery.legacyUnverified &&
          ([
            "pending",
            "enqueueing",
            "queued",
            "sending",
            "accepted_by_slack",
            "accepted_by_trigger",
            "send_started",
          ].includes(delivery.status) ||
            delivery.slackTraceId === null),
      )
      .reduce(
        (minimum, delivery) => Math.min(minimum, delivery.updatedAt * 1_000),
        checkpointUs,
      );
    const committedCheckpoint = [...this.slackTraceHydrations.values()].some(
      ({ status }) => status === "pending",
    )
      ? this.slackActivityCheckpoint
      : Math.max(
          this.slackActivityCheckpoint,
          Math.min(checkpointUs, unresolved),
        );
    const result: SlackReconciliationReportResult = {
      traceCount,
      changedErrorTraces: novelErrorTraceIds.length,
      requestedCheckpointUs: checkpointUs,
      checkpointUs: Math.min(committedCheckpoint, checkpointUs),
    };
    for (const traceId of novelErrorTraceIds) {
      this.reportedSlackErrorTraces.set(traceId, reportId);
    }
    this.slackActivityCheckpoint = committedCheckpoint;
    this.slackReconciliationReports.set(reportId, result);
    return { ...result };
  }

  async advanceSlackActivityCheckpoint(checkpointUs: number): Promise<number> {
    if (!Number.isSafeInteger(checkpointUs) || checkpointUs < 0) {
      throw new SlackReconciliationConflictError(
        "invalid_slack_activity_checkpoint",
      );
    }
    const unresolved = [...this.deliveries.values()]
      .filter(
        (delivery) =>
          !delivery.legacyUnverified &&
          ([
            "pending",
            "enqueueing",
            "queued",
            "sending",
            "accepted_by_slack",
            "accepted_by_trigger",
            "send_started",
          ].includes(delivery.status) ||
            delivery.slackTraceId === null),
      )
      .reduce(
        (minimum, delivery) => Math.min(minimum, delivery.updatedAt * 1_000),
        checkpointUs,
      );
    if (
      ![...this.slackTraceHydrations.values()].some(
        ({ status }) => status === "pending",
      )
    ) {
      this.slackActivityCheckpoint = Math.max(
        this.slackActivityCheckpoint,
        Math.min(checkpointUs, unresolved),
      );
    }
    return this.slackActivityCheckpoint;
  }

  async purgeDeliveredBefore(cutoff: number): Promise<number> {
    let purged = 0;
    const retainedActivityBoundary = Math.max(
      0,
      this.slackActivityCheckpoint - SLACK_ACTIVITY_CHECKPOINT_OVERLAP_US,
    );
    for (const [deliveryId, delivery] of this.deliveries) {
      const trace =
        delivery.slackTraceId === null
          ? undefined
          : this.slackTraces.get(delivery.slackTraceId);
      if (
        delivery.status === "delivered" &&
        delivery.deliveredAt !== null &&
        delivery.slackTraceId !== null &&
        delivery.deliveredAt < cutoff &&
        trace?.deliveryId === deliveryId &&
        trace.attemptCount === delivery.attemptCount &&
        delivery.slackSendExecutionId !== null &&
        trace.sendExecutionId === delivery.slackSendExecutionId &&
        (trace.outcome === "success" ||
          (trace.outcome === "error" && trace.sendBoundaryReached)) &&
        trace.applied &&
        trace.completedAtUs !== null &&
        trace.startedAtUs < retainedActivityBoundary &&
        trace.completedAtUs < retainedActivityBoundary
      ) {
        this.deliveries.delete(deliveryId);
        this.slackTraces.delete(delivery.slackTraceId);
        purged += 1;
      }
    }
    return purged;
  }

  async healthcheck(now: number, expectedRevision: string): Promise<boolean> {
    return (
      this.healthy &&
      (await this.isSlackDeliveryProtocolActive(expectedRevision)) &&
      ![...this.slackTraceHydrations.values()].some(
        ({ status }) => status === "debt",
      ) &&
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
      slackSendExecutionId: null,
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
    statusSecret?: string;
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
    // O binding SLACK_BOT_TOKEN saiu do wrangler.jsonc até a rotação do
    // token (ADR-002 §12, item 8) — o campo volta aqui junto com o binding.
    // ADR-002 §5, decisão 9. Fixture, nunca o segredo real.
    ALERTS_STATUS_SECRET: (options.statusSecret ??
      "segredo-status-de-teste") as unknown as SecretsStoreSecret,
    SLACK_RELAY_SIGNING_SECRET: (options.relaySigningSecret ??
      TEST_RELAY_SIGNING_SECRET) as unknown as SecretsStoreSecret,
    SLACK_RELAY_SIGNING_SECRET_NEXT: (options.relaySigningSecretNext ??
      TEST_RELAY_SIGNING_SECRET_NEXT) as unknown as SecretsStoreSecret,
    SLACK_RELAY_SIGNING_ACTIVE_SLOT: "next",
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
    relay_attempt: "",
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
