import type { RelayDestination, SlackWorkflowPayload } from "./domain";

export type DeliveryStatus =
  | "pending"
  | "enqueueing"
  | "queued"
  | "sending"
  | "dead_letter"
  | "manual_review"
  | "accepted_by_slack";

export interface QueueJob {
  deliveryId: string;
}

export interface RecoveryClaim extends QueueJob {
  destination: RelayDestination;
}

export interface DeliveryInput {
  deliveryId: string;
  eventType: string;
  action: string;
  repository: string;
  destination: RelayDestination;
  payload: SlackWorkflowPayload;
  now: number;
}

export interface StoredDelivery {
  deliveryId: string;
  eventType: string;
  action: string;
  repository: string;
  destination: RelayDestination;
  payload: SlackWorkflowPayload;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  acceptedAt: number | null;
}

export interface DeliveryStore {
  insert(input: DeliveryInput): Promise<boolean>;
  get(deliveryId: string): Promise<StoredDelivery | null>;
  markQueued(deliveryId: string, now: number): Promise<void>;
  markEnqueueFailed(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void>;
  reserveSlackSlot(
    now: number,
    intervalMilliseconds: number,
    destination: RelayDestination,
  ): Promise<number>;
  extendSlackCooldown(until: number): Promise<void>;
  claimForSlack(
    deliveryId: string,
    now: number,
  ): Promise<StoredDelivery | null>;
  recordFailure(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void>;
  markAcceptedBySlack(deliveryId: string, now: number): Promise<void>;
  markDeadLetter(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void>;
  markManualReview(
    deliveryId: string,
    now: number,
    reason: string,
  ): Promise<void>;
  claimRecoverable(
    now: number,
    staleBefore: number,
    maximumAttempts: number,
    limit: number,
  ): Promise<RecoveryClaim[]>;
  purgeAcceptedBefore(cutoff: number): Promise<number>;
  healthcheck(): Promise<boolean>;
}

interface DeliveryRow {
  delivery_id: string;
  event_type: string;
  action: string;
  repository: string;
  destination: RelayDestination;
  payload_json: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  accepted_at: number | null;
}

interface RecoveryRow {
  delivery_id: string;
  destination: RelayDestination;
  status: DeliveryStatus;
  attempt_count: number;
  updated_at: number;
}

function changed(result: D1Result<unknown>): boolean {
  return (result.meta.changes ?? 0) > 0;
}

function safeFailureReason(reason: string): string {
  const compact = reason.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  return compact.slice(0, 200) || "unspecified_failure";
}

function fromRow(row: DeliveryRow): StoredDelivery {
  return {
    deliveryId: row.delivery_id,
    eventType: row.event_type,
    action: row.action,
    repository: row.repository,
    destination: row.destination,
    payload: JSON.parse(row.payload_json) as SlackWorkflowPayload,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
  };
}

export class D1DeliveryStore implements DeliveryStore {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async insert(input: DeliveryInput): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `INSERT INTO deliveries (
          delivery_id,
          event_type,
          action,
          repository,
          destination,
          payload_json,
          status,
          attempt_count,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(
        input.deliveryId,
        input.eventType,
        input.action,
        input.repository,
        input.destination,
        JSON.stringify(input.payload),
        input.now,
        input.now,
        input.now,
      )
      .run();

    return changed(result);
  }

  async get(deliveryId: string): Promise<StoredDelivery | null> {
    const row = await this.#database
      .prepare("SELECT * FROM deliveries WHERE delivery_id = ?")
      .bind(deliveryId)
      .first<DeliveryRow>();

    return row === null ? null : fromRow(row);
  }

  async markQueued(deliveryId: string, now: number): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'queued', updated_at = ?, last_error = NULL
         WHERE delivery_id = ? AND status IN ('pending', 'enqueueing')`,
      )
      .bind(now, deliveryId)
      .run();
  }

  async markEnqueueFailed(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'pending', updated_at = ?, next_attempt_at = ?, last_error = ?
         WHERE delivery_id = ? AND status NOT IN ('accepted_by_slack', 'manual_review')`,
      )
      .bind(now, nextAttemptAt, safeFailureReason(reason), deliveryId)
      .run();
  }

  async reserveSlackSlot(
    now: number,
    intervalMilliseconds: number,
    destination: RelayDestination,
  ): Promise<number> {
    const nextSlackAt = now + intervalMilliseconds;
    const reservation = await this.#database
      .prepare(
        `UPDATE relay_state
         SET next_slack_at = ?
         WHERE singleton_id = 1
           AND next_slack_at <= ?
           AND (
             ? = 'alerts'
             OR NOT EXISTS (
               SELECT 1
               FROM deliveries
               WHERE destination = 'alerts'
                 AND (
                   status IN ('enqueueing', 'queued', 'sending')
                   OR (status IN ('pending', 'dead_letter') AND next_attempt_at <= ?)
                 )
             )
           )`,
      )
      .bind(nextSlackAt, now, destination, now)
      .run();

    if (changed(reservation)) {
      return 0;
    }

    const current = await this.#database
      .prepare("SELECT next_slack_at FROM relay_state WHERE singleton_id = 1")
      .first<{ next_slack_at: number }>();

    if (current === null) {
      throw new Error("relay_state_missing");
    }

    if (destination === "activity" && current.next_slack_at <= now) {
      return 1_000;
    }

    return Math.max(1, current.next_slack_at - now);
  }

  async extendSlackCooldown(until: number): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE relay_state
         SET next_slack_at = MAX(next_slack_at, ?)
         WHERE singleton_id = 1`,
      )
      .bind(until)
      .run();
  }

  async claimForSlack(
    deliveryId: string,
    now: number,
  ): Promise<StoredDelivery | null> {
    const row = await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ?
         WHERE delivery_id = ?
           AND status IN ('pending', 'enqueueing', 'queued', 'dead_letter')
           AND next_attempt_at <= ?
         RETURNING *`,
      )
      .bind(now, deliveryId, now)
      .first<DeliveryRow>();

    return row === null ? null : fromRow(row);
  }

  async recordFailure(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'pending', updated_at = ?, next_attempt_at = ?, last_error = ?
         WHERE delivery_id = ? AND status = 'sending'`,
      )
      .bind(now, nextAttemptAt, safeFailureReason(reason), deliveryId)
      .run();
  }

  async markAcceptedBySlack(deliveryId: string, now: number): Promise<void> {
    const result = await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'accepted_by_slack', updated_at = ?, accepted_at = ?,
             next_attempt_at = ?, last_error = NULL
         WHERE delivery_id = ? AND status = 'sending'`,
      )
      .bind(now, now, now, deliveryId)
      .run();

    if (!changed(result)) {
      throw new Error("delivery_state_changed_before_completion");
    }
  }

  async markDeadLetter(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'dead_letter', updated_at = ?, next_attempt_at = ?, last_error = ?
         WHERE delivery_id = ? AND status NOT IN ('accepted_by_slack', 'manual_review')`,
      )
      .bind(now, nextAttemptAt, safeFailureReason(reason), deliveryId)
      .run();
  }

  async markManualReview(
    deliveryId: string,
    now: number,
    reason: string,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'manual_review', updated_at = ?, last_error = ?
         WHERE delivery_id = ? AND status != 'accepted_by_slack'`,
      )
      .bind(now, safeFailureReason(reason), deliveryId)
      .run();
  }

  async claimRecoverable(
    now: number,
    staleBefore: number,
    maximumAttempts: number,
    limit: number,
  ): Promise<RecoveryClaim[]> {
    const result = await this.#database
      .prepare(
        `SELECT delivery_id, destination, status, attempt_count, updated_at
         FROM deliveries
         WHERE (
           (status IN ('pending', 'dead_letter') AND next_attempt_at <= ?)
           OR (status IN ('enqueueing', 'queued', 'sending') AND updated_at <= ?)
         )
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT ?`,
      )
      .bind(now, staleBefore, limit)
      .all<RecoveryRow>();

    const claimed: RecoveryClaim[] = [];

    for (const row of result.results) {
      if (row.attempt_count >= maximumAttempts) {
        await this.markManualReview(
          row.delivery_id,
          now,
          "maximum_delivery_attempts_reached",
        );
        continue;
      }

      const update = await this.#database
        .prepare(
          `UPDATE deliveries
           SET status = 'enqueueing', updated_at = ?, next_attempt_at = ?
           WHERE delivery_id = ? AND status = ? AND updated_at = ?`,
        )
        .bind(now, now, row.delivery_id, row.status, row.updated_at)
        .run();

      if (changed(update)) {
        claimed.push({
          deliveryId: row.delivery_id,
          destination: row.destination,
        });
      }
    }

    return claimed;
  }

  async purgeAcceptedBefore(cutoff: number): Promise<number> {
    const result = await this.#database
      .prepare(
        `DELETE FROM deliveries
         WHERE status = 'accepted_by_slack' AND accepted_at IS NOT NULL AND accepted_at < ?`,
      )
      .bind(cutoff)
      .run();

    return result.meta.changes ?? 0;
  }

  async healthcheck(): Promise<boolean> {
    await this.#database
      .prepare(
        `SELECT
           delivery_id,
           event_type,
           action,
           repository,
           destination,
           payload_json,
           status,
           attempt_count,
           next_attempt_at,
           last_error,
           created_at,
           updated_at,
           accepted_at
         FROM deliveries
         WHERE 0 = 1`,
      )
      .all();

    const state = await this.#database
      .prepare(
        `SELECT next_slack_at
         FROM relay_state
         WHERE singleton_id = 1 AND typeof(next_slack_at) = 'integer'`,
      )
      .first<{ next_slack_at: number }>();

    const manualReview = await this.#database
      .prepare(
        "SELECT 1 AS present FROM deliveries WHERE status = 'manual_review' LIMIT 1",
      )
      .first<{ present: number }>();

    return (
      state !== null &&
      Number.isSafeInteger(state.next_slack_at) &&
      manualReview === null
    );
  }
}
