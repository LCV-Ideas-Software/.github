// ADR-001 §6.1/§6.4 — D1 outbox store. Every mutating method commits its
// state change AND its dispatch_audit row in ONE database.batch(): the audit
// INSERT copies from_state from the live row under the SAME expected-state
// predicate as the CAS UPDATE, so both apply or neither (atomic rollback on
// any constraint violation). CAS semantics: 0 rows changed => false/null,
// never a throw.
import {
  DISPATCH_LEASE_MS,
  STALE_QUEUED_REQUEUE_AFTER_MS,
  VERIFY_FIRST_SCAN_DELAY_MS,
  type DispatchAuditEntry,
  type DispatchDestination,
  type DispatchOutboxRow,
  type DispatchState,
  type DispatchStatusCounters,
  type DispatchStore,
} from "./contract";

interface RawOutboxRow {
  delivery_id: string;
  destination: DispatchDestination;
  shadow: number;
  payload_json: string;
  state: DispatchState;
  attempt_count: number;
  resolver_attempts: number;
  last_send_start_ms: number | null;
  lease_until_ms: number | null;
  next_attempt_ms: number | null;
  verify_after_ms: number | null;
  verify_scans_remaining: number;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  last_error: string | null;
  created_ms: number;
  updated_ms: number;
}

interface RawAuditRow {
  seq: number;
  delivery_id: string;
  from_state: string;
  to_state: string;
  evidence_json: string;
  actor: DispatchAuditEntry["actor"];
  at_ms: number;
}

function toOutboxRow(row: RawOutboxRow): DispatchOutboxRow {
  return {
    deliveryId: row.delivery_id,
    destination: row.destination,
    shadow: row.shadow === 1,
    payloadJson: row.payload_json,
    state: row.state,
    attemptCount: row.attempt_count,
    resolverAttempts: row.resolver_attempts,
    lastSendStartMs: row.last_send_start_ms,
    leaseUntilMs: row.lease_until_ms,
    nextAttemptMs: row.next_attempt_ms,
    verifyAfterMs: row.verify_after_ms,
    verifyScansRemaining: row.verify_scans_remaining,
    slackChannelId: row.slack_channel_id,
    slackMessageTs: row.slack_message_ts,
    lastError: row.last_error,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
  };
}

function toAuditEntry(row: RawAuditRow): DispatchAuditEntry {
  return {
    seq: row.seq,
    deliveryId: row.delivery_id,
    fromState: row.from_state,
    toState: row.to_state,
    evidenceJson: row.evidence_json,
    actor: row.actor,
    atMs: row.at_ms,
  };
}

function changed(result: D1Result<unknown> | undefined): boolean {
  return (result?.meta.changes ?? 0) > 0;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

// dispatch_audit.evidence_json is CHECK json_valid: bare error codes are
// wrapped, JSON evidence passes through untouched.
function asEvidenceJson(value: string): string {
  try {
    JSON.parse(value);
    return value;
  } catch {
    return JSON.stringify({ error: value });
  }
}

export class D1DispatchStore implements DispatchStore {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  // Audit row for a CAS transition, guarded by the SAME expected-state
  // predicate as the UPDATE it accompanies in the batch (ADR §6.1).
  #transitionAudit(
    deliveryId: string,
    expectedStates: readonly DispatchState[],
    toState: string,
    evidenceJson: string,
    actor: DispatchAuditEntry["actor"],
    atMs: number,
  ): D1PreparedStatement {
    return this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, ?, ?, ?, ?
         FROM dispatch_outbox
         WHERE delivery_id = ?
           AND state IN (${placeholders(expectedStates.length)})`,
      )
      .bind(toState, evidenceJson, actor, atMs, deliveryId, ...expectedStates);
  }

  // Audit row for a mutation that does not change state (guarded only by the
  // row's presence, plus an optional extra predicate).
  #inPlaceAudit(
    deliveryId: string,
    evidenceJson: string,
    actor: DispatchAuditEntry["actor"],
    atMs: number,
    extraPredicate = "",
  ): D1PreparedStatement {
    return this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, state, ?, ?, ?
         FROM dispatch_outbox
         WHERE delivery_id = ?${extraPredicate}`,
      )
      .bind(evidenceJson, actor, atMs, deliveryId);
  }

  async legacyRowExists(deliveryId: string): Promise<boolean> {
    // ADR §6.8 (R11): read-only PK lookup on the frozen legacy table; runs
    // forever, in every DISPATCH_MODE.
    const row = await this.#database
      .prepare("SELECT 1 AS present FROM deliveries WHERE delivery_id = ?")
      .bind(deliveryId)
      .first<number>("present");
    return row !== null;
  }

  async get(deliveryId: string): Promise<DispatchOutboxRow | null> {
    const row = await this.#database
      .prepare("SELECT * FROM dispatch_outbox WHERE delivery_id = ?")
      .bind(deliveryId)
      .first<RawOutboxRow>();
    return row === null ? null : toOutboxRow(row);
  }

  async insert(row: {
    deliveryId: string;
    destination: DispatchDestination;
    shadow: boolean;
    payloadJson: string;
    now: number;
  }): Promise<boolean> {
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT ?, 'none', 'queued', ?, 'ingress', ?
         WHERE NOT EXISTS (
           SELECT 1 FROM dispatch_outbox WHERE delivery_id = ?
         )`,
      )
      .bind(
        row.deliveryId,
        JSON.stringify({ destination: row.destination, shadow: row.shadow }),
        row.now,
        row.deliveryId,
      );
    const insert = this.#database
      .prepare(
        `INSERT INTO dispatch_outbox (
           delivery_id, destination, shadow, payload_json, state,
           created_ms, updated_ms
         ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(
        row.deliveryId,
        row.destination,
        row.shadow ? 1 : 0,
        row.payloadJson,
        row.now,
        row.now,
      );
    const results = await this.#database.batch([audit, insert]);
    return changed(results[1]);
  }

  async claim(
    deliveryId: string,
    now: number,
  ): Promise<DispatchOutboxRow | null> {
    const leaseUntilMs = now + DISPATCH_LEASE_MS;
    const audit = this.#transitionAudit(
      deliveryId,
      ["queued"],
      "sending",
      JSON.stringify({ lease_until_ms: leaseUntilMs }),
      "consumer",
      now,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'sending',
             last_send_start_ms = ?,
             lease_until_ms = ?,
             attempt_count = attempt_count + 1,
             updated_ms = ?
         WHERE delivery_id = ? AND state = 'queued'`,
      )
      .bind(now, leaseUntilMs, now, deliveryId);
    const results = await this.#database.batch([audit, update]);
    if (!changed(results[1])) return null;
    return this.get(deliveryId);
  }

  async markDelivered(
    deliveryId: string,
    now: number,
    ts: string,
    channel: string,
    actor: "consumer" | "resolver" | "operator",
    expectedStates: readonly DispatchState[],
    evidenceJson: string,
  ): Promise<boolean> {
    const audit = this.#transitionAudit(
      deliveryId,
      expectedStates,
      "delivered",
      asEvidenceJson(evidenceJson),
      actor,
      now,
    );
    // §9.A1: shadow rows are recorded delivered WITHOUT Slack identifiers
    // (no egress ever happened). §6.3.3: a row whose resend armed
    // verification gets its first scan stamped at delivery time.
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'delivered',
             slack_message_ts = CASE WHEN shadow = 1 THEN NULL ELSE ? END,
             slack_channel_id = CASE WHEN shadow = 1 THEN NULL ELSE ? END,
             verify_after_ms = CASE
               WHEN verify_scans_remaining > 0 THEN ?
               ELSE verify_after_ms
             END,
             next_attempt_ms = NULL,
             last_error = NULL,
             updated_ms = ?
         WHERE delivery_id = ?
           AND state IN (${placeholders(expectedStates.length)})`,
      )
      .bind(
        ts,
        channel,
        now + VERIFY_FIRST_SCAN_DELAY_MS,
        now,
        deliveryId,
        ...expectedStates,
      );
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async markManual(
    deliveryId: string,
    now: number,
    errorCodeOrEvidence: string,
    actor: "consumer" | "resolver",
    expectedStates: readonly DispatchState[],
  ): Promise<boolean> {
    const audit = this.#transitionAudit(
      deliveryId,
      expectedStates,
      "manual",
      asEvidenceJson(errorCodeOrEvidence),
      actor,
      now,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'manual',
             last_error = ?,
             next_attempt_ms = NULL,
             updated_ms = ?
         WHERE delivery_id = ?
           AND state IN (${placeholders(expectedStates.length)})`,
      )
      .bind(errorCodeOrEvidence, now, deliveryId, ...expectedStates);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async markAmbiguous(
    deliveryId: string,
    now: number,
    reason: string,
    retryAfterMs: number | null,
    actor: "consumer" | "resolver",
    expectedStates: readonly DispatchState[],
  ): Promise<boolean> {
    const audit = this.#transitionAudit(
      deliveryId,
      expectedStates,
      "ambiguous",
      JSON.stringify({ reason, retry_after_ms: retryAfterMs }),
      actor,
      now,
    );
    // §6.2/R4: a recorded Retry-After defers the row for the resolver via
    // next_attempt_ms (absolute).
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'ambiguous',
             last_error = ?,
             next_attempt_ms = ?,
             updated_ms = ?
         WHERE delivery_id = ?
           AND state IN (${placeholders(expectedStates.length)})`,
      )
      .bind(
        reason,
        retryAfterMs === null ? null : now + retryAfterMs,
        now,
        deliveryId,
        ...expectedStates,
      );
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async markDeadLetter(
    deliveryId: string,
    now: number,
    reason: string,
  ): Promise<boolean> {
    const expectedStates: readonly DispatchState[] = ["queued", "sending"];
    const audit = this.#transitionAudit(
      deliveryId,
      expectedStates,
      "dead_letter",
      JSON.stringify({ reason }),
      "consumer",
      now,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'dead_letter',
             last_error = ?,
             updated_ms = ?
         WHERE delivery_id = ?
           AND state IN (${placeholders(expectedStates.length)})`,
      )
      .bind(reason, now, deliveryId, ...expectedStates);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async recordLateProof(
    deliveryId: string,
    now: number,
    ts: string,
    channel: string,
  ): Promise<"ambiguous_cas" | "manual_cas" | "audit_only"> {
    // §6.3 (R2): FIRST the unconditional audit append — canonical proof
    // lands durably no matter which state the resolver reached.
    const row = await this.get(deliveryId);
    const evidenceJson = JSON.stringify({ late_proof: true, ts, channel });
    await this.appendAudit({
      deliveryId,
      fromState: row?.state ?? "unknown",
      toState: row?.state ?? "unknown",
      evidenceJson,
      actor: "consumer",
      atMs: now,
    });
    // Then CAS ambiguous -> delivered(ts) first, manual -> delivered(ts) as
    // fallback — proof beats inference.
    if (
      await this.markDelivered(
        deliveryId,
        now,
        ts,
        channel,
        "consumer",
        ["ambiguous"],
        evidenceJson,
      )
    ) {
      return "ambiguous_cas";
    }
    if (
      await this.markDelivered(
        deliveryId,
        now,
        ts,
        channel,
        "consumer",
        ["manual"],
        evidenceJson,
      )
    ) {
      return "manual_cas";
    }
    return "audit_only";
  }

  async normalizeExpiredLeases(now: number): Promise<number> {
    // ADR §6.3.1: normalization first — audited lease_expired; the rows
    // become resolver input.
    const predicate =
      "state = 'sending' AND lease_until_ms IS NOT NULL AND lease_until_ms < ?";
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, 'sending', 'ambiguous', ?, 'resolver', ?
         FROM dispatch_outbox
         WHERE ${predicate}`,
      )
      .bind(JSON.stringify({ reason: "lease_expired" }), now, now);
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'ambiguous',
             last_error = 'lease_expired',
             next_attempt_ms = NULL,
             updated_ms = ?
         WHERE ${predicate}`,
      )
      .bind(now, now);
    const results = await this.#database.batch([audit, update]);
    return results[1]?.meta.changes ?? 0;
  }

  async ambiguousRowsDue(
    now: number,
    limit: number,
  ): Promise<DispatchOutboxRow[]> {
    const result = await this.#database
      .prepare(
        `SELECT * FROM dispatch_outbox
         WHERE state = 'ambiguous'
           AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
         ORDER BY updated_ms ASC
         LIMIT ?`,
      )
      .bind(now, limit)
      .all<RawOutboxRow>();
    return result.results.map(toOutboxRow);
  }

  async verificationRowsDue(
    now: number,
    limit: number,
  ): Promise<DispatchOutboxRow[]> {
    // §6.3.3: delivered rows re-enter the resolver while scans remain.
    const result = await this.#database
      .prepare(
        `SELECT * FROM dispatch_outbox
         WHERE state = 'delivered'
           AND verify_scans_remaining > 0
           AND verify_after_ms IS NOT NULL
           AND verify_after_ms <= ?
         ORDER BY verify_after_ms ASC
         LIMIT ?`,
      )
      .bind(now, limit)
      .all<RawOutboxRow>();
    return result.results.map(toOutboxRow);
  }

  async incrementResolverAttempts(
    deliveryId: string,
    now: number,
  ): Promise<number> {
    const audit = this.#inPlaceAudit(
      deliveryId,
      JSON.stringify({ reason: "resolver_attempt_inconclusive" }),
      "resolver",
      now,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET resolver_attempts = resolver_attempts + 1,
             updated_ms = ?
         WHERE delivery_id = ?`,
      )
      .bind(now, deliveryId);
    await this.#database.batch([audit, update]);
    const attempts = await this.#database
      .prepare(
        "SELECT resolver_attempts FROM dispatch_outbox WHERE delivery_id = ?",
      )
      .bind(deliveryId)
      .first<number>("resolver_attempts");
    return attempts ?? 0;
  }

  async armVerification(deliveryId: string, now: number): Promise<boolean> {
    const audit = this.#inPlaceAudit(
      deliveryId,
      JSON.stringify({ verification_armed: true, scans: 2 }),
      "operator",
      now,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET verify_scans_remaining = 2,
             updated_ms = ?
         WHERE delivery_id = ?`,
      )
      .bind(now, deliveryId);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async completeVerificationScan(
    deliveryId: string,
    now: number,
    nextVerifyAfterMs: number | null,
  ): Promise<boolean> {
    const predicate = " AND verify_scans_remaining > 0";
    const audit = this.#inPlaceAudit(
      deliveryId,
      JSON.stringify({
        verification_scan_complete: true,
        next_verify_after_ms: nextVerifyAfterMs,
      }),
      "resolver",
      now,
      predicate,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET verify_scans_remaining = verify_scans_remaining - 1,
             verify_after_ms = ?,
             updated_ms = ?
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(nextVerifyAfterMs, now, deliveryId);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async updateCanonicalTs(
    deliveryId: string,
    now: number,
    ts: string,
    evidenceJson: string,
  ): Promise<boolean> {
    // §6.3.2/§6.3.3: repair FROM delivered — the earliest ts becomes the
    // recorded canonical ts; the row never leaves delivered.
    const predicate = " AND state = 'delivered' AND shadow = 0";
    const audit = this.#inPlaceAudit(
      deliveryId,
      asEvidenceJson(evidenceJson),
      "resolver",
      now,
      predicate,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET slack_message_ts = ?,
             updated_ms = ?
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(ts, now, deliveryId);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async operatorResend(
    deliveryId: string,
    now: number,
    evidenceJson: string,
  ): Promise<boolean> {
    const audit = this.#transitionAudit(
      deliveryId,
      ["manual"],
      "queued",
      asEvidenceJson(evidenceJson),
      "operator",
      now,
    );
    // I1: the ONLY resend path. The resend arms the §6.3.3 verification
    // scans (verify_scans_remaining = 2); verify_after_ms is stamped by
    // markDelivered when the resend later delivers.
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'queued',
             verify_scans_remaining = 2,
             verify_after_ms = NULL,
             next_attempt_ms = NULL,
             lease_until_ms = NULL,
             resolver_attempts = 0,
             last_error = NULL,
             updated_ms = ?
         WHERE delivery_id = ? AND state = 'manual'`,
      )
      .bind(now, deliveryId);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async operatorCloseManual(
    deliveryId: string,
    now: number,
    evidenceJson: string,
  ): Promise<boolean> {
    const audit = this.#transitionAudit(
      deliveryId,
      ["manual"],
      "closed_manual",
      asEvidenceJson(evidenceJson),
      "operator",
      now,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'closed_manual',
             updated_ms = ?
         WHERE delivery_id = ? AND state = 'manual'`,
      )
      .bind(now, deliveryId);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async staleQueuedRows(
    now: number,
    limit: number,
  ): Promise<DispatchOutboxRow[]> {
    // R13: crash between INSERT and queue publish leaves a stale queued row;
    // cron re-enqueues it, and double-publish is claim-CAS-safe.
    const result = await this.#database
      .prepare(
        `SELECT * FROM dispatch_outbox
         WHERE state = 'queued' AND updated_ms < ?
         ORDER BY updated_ms ASC
         LIMIT ?`,
      )
      .bind(now - STALE_QUEUED_REQUEUE_AFTER_MS, limit)
      .all<RawOutboxRow>();
    return result.results.map(toOutboxRow);
  }

  async statusCounters(now: number): Promise<DispatchStatusCounters> {
    const zero = (): Record<DispatchState, number> => ({
      queued: 0,
      sending: 0,
      ambiguous: 0,
      manual: 0,
      delivered: 0,
      dead_letter: 0,
      closed_manual: 0,
    });
    const byStateAndDestination: Record<
      DispatchDestination,
      Record<DispatchState, number>
    > = { alerts: zero(), activity: zero() };
    const grouped = await this.#database
      .prepare(
        `SELECT destination, state, COUNT(*) AS n
         FROM dispatch_outbox
         GROUP BY destination, state`,
      )
      .all<{ destination: DispatchDestination; state: DispatchState; n: number }>();
    for (const entry of grouped.results) {
      byStateAndDestination[entry.destination][entry.state] = entry.n;
    }
    // §6.8: manual is parked-with-alarm, NOT terminal — the drain view stays
    // open while queued/sending/ambiguous/manual rows exist.
    const oldest = await this.#database
      .prepare(
        `SELECT MIN(created_ms) AS oldest_ms
         FROM dispatch_outbox
         WHERE state IN ('queued', 'sending', 'ambiguous', 'manual')`,
      )
      .first<number | null>("oldest_ms");
    return {
      byStateAndDestination,
      oldestNonTerminalAgeMs: oldest === null ? null : now - oldest,
      repairedDuplicates: await this.repairedDuplicatesTotal(),
    };
  }

  async appendAudit(entry: Omit<DispatchAuditEntry, "seq">): Promise<void> {
    await this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.deliveryId,
        entry.fromState,
        entry.toState,
        entry.evidenceJson,
        entry.actor,
        entry.atMs,
      )
      .run();
  }

  async auditEntries(deliveryId: string): Promise<DispatchAuditEntry[]> {
    const result = await this.#database
      .prepare(
        "SELECT * FROM dispatch_audit WHERE delivery_id = ? ORDER BY seq",
      )
      .bind(deliveryId)
      .all<RawAuditRow>();
    return result.results.map(toAuditEntry);
  }

  async repairedDuplicatesTotal(): Promise<number> {
    // §6.3.2: one marker per repaired (deleted) duplicate copy, written by
    // the repair paths only.
    const count = await this.#database
      .prepare(
        `SELECT COUNT(*) AS n
         FROM dispatch_audit
         WHERE json_extract(evidence_json, '$.repaired_duplicate') = 1`,
      )
      .first<number>("n");
    return count ?? 0;
  }

  async repairedDuplicatesBefore(cutoffMs: number): Promise<number> {
    const count = await this.#database
      .prepare(
        `SELECT COUNT(*) AS n
         FROM dispatch_audit
         WHERE json_extract(evidence_json, '$.repaired_duplicate') = 1
           AND at_ms <= ?`,
      )
      .bind(cutoffMs)
      .first<number>("n");
    return count ?? 0;
  }
}
