import type { RelayDestination } from "./domain";
import type {
  DeliveryStatus,
  SlackReconciliationTraceInput,
  SlackTraceOutcome,
} from "./store";

export interface SlackReconciliationDeliverySnapshot {
  deliveryId: string;
  destination: RelayDestination;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: number;
  lastError: string | null;
  updatedAt: number;
  deliveredAt: number | null;
  slackMessageTs: string | null;
  slackTraceId: string | null;
  slackSendExecutionId: string | null;
  legacyUnverified: boolean;
}

export interface SlackReconciliationTraceSnapshot {
  traceId: string;
  deliveryId: string;
  outcome: SlackTraceOutcome;
  attemptCount: number;
  sendExecutionId: string | null;
  destination: RelayDestination | null;
  slackChannelId: string | null;
  messageTs: string | null;
  sendBoundaryReached: boolean;
  preSendFailureProven: boolean;
  startedAtUs: number;
  completedAtUs: number | null;
  updatedAt: number;
  appliedAt: number | null;
}

export type SlackReconciliationPlanConflictCode =
  | "delivery_not_found"
  | "invalid_slack_trace_attempt"
  | "slack_message_timestamp_conflict"
  | "slack_send_execution_not_unique"
  | "slack_trace_attempt_conflict"
  | "slack_trace_delivery_conflict"
  | "slack_trace_destination_conflict"
  | "slack_trace_identity_missing"
  | "slack_trace_message_evidence_conflict"
  | "slack_trace_message_owner_conflict"
  | "slack_trace_outcome_conflict"
  | "slack_trace_owner_conflict"
  | "slack_trace_send_execution_conflict"
  | "slack_trace_send_execution_not_found"
  | "slack_trace_send_execution_owner_conflict"
  | "terminal_slack_trace_missing_completion";

export class SlackReconciliationPlanConflictError extends Error {
  readonly code: SlackReconciliationPlanConflictCode;

  constructor(code: SlackReconciliationPlanConflictCode) {
    super(code);
    this.name = "SlackReconciliationPlanConflictError";
    this.code = code;
  }
}

export interface SlackReconciliationPlanInput {
  traces: readonly SlackReconciliationTraceInput[];
  deliveries: ReadonlyMap<string, SlackReconciliationDeliverySnapshot>;
  existingTraces: ReadonlyMap<string, SlackReconciliationTraceSnapshot>;
  now: number;
}

export interface SlackReconciliationPlanResult {
  deliveries: Map<string, SlackReconciliationDeliverySnapshot>;
  traces: Map<string, SlackReconciliationTraceSnapshot>;
  errorTraceIds: string[];
}

interface SlackReconciliationTraceTransition {
  traceId: string;
  previous: SlackReconciliationTraceSnapshot | undefined;
  gainedEvidence: boolean;
}

interface SlackReconciliationTraceClassification {
  transition: SlackReconciliationTraceTransition;
  hasCompetingTrace: boolean;
}

const FUNCTION_EXECUTION_ID_PATTERN = /^Fx[A-Za-z0-9]{1,126}$/u;
const MESSAGE_TIMESTAMP_PATTERN = /^\d{10,13}\.\d{6}$/u;
const PRE_SEND_RETRY_DELAY_MS = 20 * 60 * 1_000;

function conflict(code: SlackReconciliationPlanConflictCode): never {
  throw new SlackReconciliationPlanConflictError(code);
}

function channelForDestination(destination: RelayDestination): string {
  return destination === "alerts" ? "C0BMUK793NV" : "C0BMQMW3L4E";
}

function mergeTrace(
  rawTrace: SlackReconciliationTraceInput,
  deliveries: Map<string, SlackReconciliationDeliverySnapshot>,
  traces: Map<string, SlackReconciliationTraceSnapshot>,
  now: number,
): SlackReconciliationTraceTransition {
  let deliveryId = rawTrace.deliveryId;
  let attemptCount = rawTrace.attemptCount;
  let destination: RelayDestination | null = null;
  const requiresPersistedBoundaryOwner =
    deliveryId === null ||
    attemptCount === null ||
    rawTrace.messageTs !== null ||
    rawTrace.sendBoundaryReached;

  if (rawTrace.sendExecutionId !== null) {
    const owners = [...deliveries.values()].filter(
      (candidate) =>
        candidate.slackSendExecutionId === rawTrace.sendExecutionId,
    );
    if (owners.length > 1) conflict("slack_send_execution_not_unique");
    const owner = owners[0];
    if (owner === undefined) {
      if (requiresPersistedBoundaryOwner) {
        conflict("slack_trace_send_execution_not_found");
      }
    } else {
      if (
        (deliveryId !== null && deliveryId !== owner.deliveryId) ||
        (attemptCount !== null && attemptCount !== owner.attemptCount)
      ) {
        conflict("slack_trace_owner_conflict");
      }
      deliveryId = owner.deliveryId;
      attemptCount = owner.attemptCount;
      destination = owner.destination;
    }
  }

  if (deliveryId === null || attemptCount === null) {
    conflict("slack_trace_identity_missing");
  }
  if (
    rawTrace.slackChannelId !== null &&
    destination !== null &&
    rawTrace.slackChannelId !== channelForDestination(destination)
  ) {
    conflict("slack_trace_destination_conflict");
  }

  const trace = {
    ...rawTrace,
    deliveryId,
    attemptCount,
    destination,
  };
  const slackChannelId = trace.slackChannelId;
  const messageTs = trace.messageTs;
  if (
    !Number.isSafeInteger(trace.attemptCount) ||
    trace.attemptCount <= 0 ||
    (trace.sendExecutionId !== null &&
      !FUNCTION_EXECUTION_ID_PATTERN.test(trace.sendExecutionId)) ||
    (trace.preSendFailureProven && trace.sendExecutionId === null) ||
    (slackChannelId === null) !== (messageTs === null) ||
    (messageTs !== null &&
      (trace.sendExecutionId === null ||
        !trace.sendBoundaryReached ||
        trace.preSendFailureProven ||
        trace.destination === null ||
        slackChannelId !== channelForDestination(trace.destination) ||
        !MESSAGE_TIMESTAMP_PATTERN.test(messageTs)))
  ) {
    conflict("invalid_slack_trace_attempt");
  }
  if (trace.outcome !== "pending" && trace.completedAtUs === null) {
    conflict("terminal_slack_trace_missing_completion");
  }

  const delivery = deliveries.get(trace.deliveryId);
  if (delivery === undefined) conflict("delivery_not_found");

  if (trace.sendExecutionId !== null) {
    const deliveryOwner = [...deliveries.values()].find(
      (candidate) => candidate.slackSendExecutionId === trace.sendExecutionId,
    );
    if (
      deliveryOwner !== undefined &&
      (deliveryOwner.deliveryId !== trace.deliveryId ||
        deliveryOwner.attemptCount !== trace.attemptCount)
    ) {
      conflict("slack_trace_owner_conflict");
    }
    const traceOwner = [...traces.values()].find(
      (candidate) =>
        candidate.traceId !== trace.traceId &&
        candidate.sendExecutionId === trace.sendExecutionId,
    );
    if (traceOwner !== undefined) {
      conflict("slack_trace_send_execution_owner_conflict");
    }
  }

  const previous = traces.get(trace.traceId);
  if (previous !== undefined && previous.deliveryId !== trace.deliveryId) {
    conflict("slack_trace_delivery_conflict");
  }
  if (
    previous !== undefined &&
    previous.outcome !== "pending" &&
    trace.outcome !== "pending" &&
    previous.outcome !== trace.outcome
  ) {
    conflict("slack_trace_outcome_conflict");
  }
  if (previous !== undefined && previous.attemptCount !== trace.attemptCount) {
    conflict("slack_trace_attempt_conflict");
  }
  if (
    previous?.sendExecutionId !== null &&
    previous?.sendExecutionId !== undefined &&
    trace.sendExecutionId !== null &&
    previous.sendExecutionId !== trace.sendExecutionId
  ) {
    conflict("slack_trace_send_execution_conflict");
  }
  if (
    previous !== undefined &&
    ((previous.destination !== null &&
      trace.destination !== null &&
      previous.destination !== trace.destination) ||
      (previous.slackChannelId !== null &&
        slackChannelId !== null &&
        previous.slackChannelId !== slackChannelId) ||
      (previous.messageTs !== null &&
        messageTs !== null &&
        previous.messageTs !== messageTs))
  ) {
    conflict("slack_trace_message_evidence_conflict");
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
  const effectiveTrace: SlackReconciliationTraceSnapshot = {
    traceId: trace.traceId,
    deliveryId: trace.deliveryId,
    outcome:
      previous === undefined || previous.outcome === "pending"
        ? trace.outcome
        : previous.outcome,
    attemptCount: trace.attemptCount,
    sendExecutionId: previous?.sendExecutionId ?? trace.sendExecutionId,
    destination: previous?.destination ?? trace.destination,
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
    appliedAt: gainedEvidence ? null : (previous?.appliedAt ?? null),
  };

  if (
    effectiveTrace.slackChannelId !== null &&
    effectiveTrace.messageTs !== null &&
    [...traces.values()].some(
      (candidate) =>
        candidate.traceId !== trace.traceId &&
        candidate.slackChannelId === effectiveTrace.slackChannelId &&
        candidate.messageTs === effectiveTrace.messageTs,
    )
  ) {
    conflict("slack_trace_message_owner_conflict");
  }
  if (effectiveTrace.messageTs !== null) {
    for (const other of deliveries.values()) {
      if (
        other.deliveryId !== delivery.deliveryId &&
        other.destination === delivery.destination &&
        other.slackMessageTs === effectiveTrace.messageTs
      ) {
        conflict("slack_message_timestamp_conflict");
      }
    }
  }

  traces.set(trace.traceId, effectiveTrace);
  return { traceId: trace.traceId, previous, gainedEvidence };
}

function applyTrace(
  classification: SlackReconciliationTraceClassification,
  deliveries: Map<string, SlackReconciliationDeliverySnapshot>,
  traces: Map<string, SlackReconciliationTraceSnapshot>,
  now: number,
): void {
  const { transition, hasCompetingTrace } = classification;
  const { traceId, previous, gainedEvidence } = transition;
  const effectiveTrace = traces.get(traceId);
  if (effectiveTrace === undefined) {
    throw new Error("slack_reconciliation_trace_plan_missing");
  }
  const delivery = deliveries.get(effectiveTrace.deliveryId);
  if (delivery === undefined) conflict("delivery_not_found");
  if (effectiveTrace.outcome === "pending") return;
  if (
    previous !== undefined &&
    previous.appliedAt !== null &&
    !gainedEvidence
  ) {
    return;
  }

  const markApplied = (): void => {
    effectiveTrace.appliedAt ??= now;
  };
  if (
    delivery.status === "manual_review" &&
    delivery.lastError === "slack_trace_hydration_owner_ambiguous" &&
    delivery.slackTraceId === null
  ) {
    markApplied();
    return;
  }
  if (effectiveTrace.messageTs !== null) {
    if (
      effectiveTrace.sendExecutionId === null ||
      delivery.slackSendExecutionId !== effectiveTrace.sendExecutionId ||
      effectiveTrace.destination !== delivery.destination
    ) {
      conflict("slack_trace_owner_conflict");
    }
    if (
      delivery.status === "delivered" &&
      delivery.slackMessageTs !== effectiveTrace.messageTs
    ) {
      conflict("slack_message_timestamp_conflict");
    }
    delivery.status = "delivered";
    delivery.deliveredAt ??= now;
    delivery.slackMessageTs = effectiveTrace.messageTs;
    delivery.slackTraceId = traceId;
    delivery.updatedAt = now;
    delivery.nextAttemptAt = now;
    delivery.lastError = null;
    delivery.legacyUnverified = false;
    markApplied();
    return;
  }
  if (delivery.status === "delivered") {
    if (
      delivery.attemptCount === effectiveTrace.attemptCount &&
      delivery.slackSendExecutionId !== null &&
      delivery.slackSendExecutionId === effectiveTrace.sendExecutionId &&
      (effectiveTrace.outcome === "success" ||
        effectiveTrace.sendBoundaryReached)
    ) {
      delivery.slackTraceId = traceId;
      delivery.updatedAt = now;
    }
    markApplied();
    return;
  }
  if (delivery.attemptCount !== effectiveTrace.attemptCount) {
    markApplied();
    return;
  }
  if (
    delivery.slackSendExecutionId !== null &&
    delivery.slackSendExecutionId !== effectiveTrace.sendExecutionId
  ) {
    markApplied();
    return;
  }
  if (
    effectiveTrace.outcome === "success" &&
    delivery.status === "accepted_by_slack" &&
    delivery.legacyUnverified
  ) {
    if (delivery.slackTraceId !== null && delivery.slackTraceId !== traceId) {
      delivery.status = "manual_review";
      delivery.lastError = "slack_legacy_trace_conflict";
    } else {
      delivery.slackTraceId = traceId;
    }
    delivery.updatedAt = now;
    markApplied();
    return;
  }
  if (effectiveTrace.outcome === "success") {
    delivery.status = "manual_review";
    delivery.lastError =
      "slack_workflow_succeeded_without_authenticated_receipt";
    delivery.slackTraceId = traceId;
    delivery.updatedAt = now;
    markApplied();
    return;
  }
  if (
    effectiveTrace.sendBoundaryReached ||
    delivery.status === "send_started" ||
    (!effectiveTrace.preSendFailureProven && delivery.legacyUnverified)
  ) {
    delivery.status = "manual_review";
    delivery.lastError = "slack_workflow_failed_after_send_boundary";
    delivery.slackTraceId = traceId;
    delivery.updatedAt = now;
    markApplied();
    return;
  }
  if (!effectiveTrace.preSendFailureProven) {
    delivery.status = "manual_review";
    delivery.lastError = "slack_workflow_failed_without_pre_send_proof";
    delivery.slackTraceId = traceId;
    delivery.updatedAt = now;
    markApplied();
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
  const sameTraceMayReleaseMissingProof =
    delivery.status === "manual_review" &&
    delivery.lastError === "slack_workflow_failed_without_pre_send_proof" &&
    delivery.slackTraceId === traceId &&
    effectiveTrace.preSendFailureProven;
  const retryableStatus = (
    ["pending", "enqueueing", "queued", "dead_letter"] as DeliveryStatus[]
  ).includes(delivery.status);
  if (
    delivery.status === "accepted_by_trigger" ||
    delivery.status === "accepted_by_slack" ||
    (retryableStatus && delivery.slackTraceId === null) ||
    retryableManualAmbiguity ||
    sameTraceMayReleaseMissingProof
  ) {
    if (
      delivery.attemptCount !== effectiveTrace.attemptCount ||
      (delivery.slackSendExecutionId !== null &&
        delivery.slackSendExecutionId !== effectiveTrace.sendExecutionId)
    ) {
      markApplied();
      return;
    }
    if (hasCompetingTrace) return;
    delivery.status = "pending";
    delivery.nextAttemptAt = Math.max(
      delivery.nextAttemptAt,
      now + PRE_SEND_RETRY_DELAY_MS,
    );
    delivery.lastError = "slack_workflow_failed_before_send_boundary";
    delivery.slackTraceId = traceId;
    delivery.slackSendExecutionId ??= effectiveTrace.sendExecutionId;
    delivery.legacyUnverified = false;
    delivery.updatedAt = now;
    markApplied();
    return;
  }
  if (delivery.status !== "sending") markApplied();
}

function classifyTraceTransition(
  transition: SlackReconciliationTraceTransition,
  traces: ReadonlyMap<string, SlackReconciliationTraceSnapshot>,
): SlackReconciliationTraceClassification {
  const effectiveTrace = traces.get(transition.traceId);
  if (effectiveTrace === undefined) {
    throw new Error("slack_reconciliation_trace_plan_missing");
  }
  const hasCompetingTrace = [...traces.values()].some(
    (candidate) =>
      candidate.traceId !== effectiveTrace.traceId &&
      candidate.deliveryId === effectiveTrace.deliveryId &&
      candidate.attemptCount === effectiveTrace.attemptCount &&
      (candidate.appliedAt === null ||
        candidate.outcome !== "error" ||
        candidate.slackChannelId !== null ||
        candidate.messageTs !== null ||
        candidate.sendBoundaryReached ||
        !candidate.preSendFailureProven),
  );
  return { transition, hasCompetingTrace };
}

export function planSlackReconciliation(
  input: SlackReconciliationPlanInput,
): SlackReconciliationPlanResult {
  const deliveries = new Map(
    [...input.deliveries].map(([deliveryId, delivery]) => [
      deliveryId,
      { ...delivery },
    ]),
  );
  const traces = new Map(
    [...input.existingTraces].map(([traceId, trace]) => [
      traceId,
      { ...trace },
    ]),
  );
  const errorTraceIds: string[] = [];
  const transitions: SlackReconciliationTraceTransition[] = [];

  for (const trace of input.traces) {
    transitions.push(mergeTrace(trace, deliveries, traces, input.now));
    if (trace.outcome === "error") errorTraceIds.push(trace.traceId);
  }
  const classifications = transitions.map((transition) =>
    classifyTraceTransition(transition, traces),
  );
  for (const classification of classifications) {
    applyTrace(classification, deliveries, traces, input.now);
  }

  return { deliveries, traces, errorTraceIds };
}
