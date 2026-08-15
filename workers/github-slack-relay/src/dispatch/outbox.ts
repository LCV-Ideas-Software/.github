// ADR-001 §6.1/§6.4 — D1 outbox store. Every mutating method commits its
// state change AND its dispatch_audit row in ONE database.batch(): the audit
// INSERT copies from_state from the live row under the SAME expected-state
// predicate as the CAS UPDATE, so both apply or neither (atomic rollback on
// any constraint violation). CAS semantics: 0 rows changed => false/null,
// never a throw.
//
// ONE deliberate exception (audit finding B3): markQueuedRepublished writes no
// audit row. It changes no state and carries no decision — it only stamps
// updated_ms so the cron stops republishing the same stale `queued` row on
// every pass. Auditing it would append a row per stale row per cron period
// forever, which is exactly the R20 mode-off shape ("rows accumulate in
// queued"), so the journal would grow without bound while recording nothing.
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

// Copilot suppressed comment (F4) / ADR §10 H12: the route's read-then-act
// replay check cannot make an operator command one-shot under concurrency —
// two identical requests both observe no digest and both mutate. The digest is
// therefore CONSUMED inside the mutation batch: the audit INSERT, which is the
// applied-command ledger row itself, refuses to write a digest already
// recorded for the delivery, and the UPDATE is bound to that decision by
// `changes() > 0`.
//
// Why not the same NOT EXISTS on the UPDATE: the batch is ONE transaction on
// one connection, so the UPDATE would see the audit row this very batch just
// inserted and would never fire (probed: audit changes 1, update changes 0).
// Reversing the order is not available either — the audit INSERT reads
// `from_state` from the live row and must run BEFORE the UPDATE. The scope
// (`actor = 'operator'` + the digest key) mirrors operatorCommandApplied
// exactly, so the fast 409 pre-check and this atomic guard read the same rows.
const APPLIED_ONCE_AUDIT_GUARD =
  " AND NOT EXISTS (SELECT 1 FROM dispatch_audit" +
  " WHERE delivery_id = ? AND actor = 'operator'" +
  " AND json_extract(evidence_json, '$.request_signature_sha256') = ?)";

function appliedOnceAuditGuard(requestSignatureSha256: string | null): string {
  return requestSignatureSha256 === null ? "" : APPLIED_ONCE_AUDIT_GUARD;
}

// Bound only when the guard clause is present, and appended LAST: the clause
// closes the WHERE, so its parameters are the statement's final ones.
function appliedOnceBindings(
  deliveryId: string,
  requestSignatureSha256: string | null,
): readonly unknown[] {
  return requestSignatureSha256 === null
    ? []
    : [deliveryId, requestSignatureSha256];
}

// The mutation half of the guard. Only operator commands carry it, so no
// consumer/resolver transition inherits the changes() dependency.
function appliedOnceUpdateGuard(requestSignatureSha256: string | null): string {
  return requestSignatureSha256 === null ? "" : " AND changes() > 0";
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
    // F4: present only for operator commands — the audit row is the ledger
    // entry, so refusing to write it here is what makes the command one-shot.
    requestSignatureSha256: string | null = null,
  ): D1PreparedStatement {
    return this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, ?, ?, ?, ?
         FROM dispatch_outbox
         WHERE delivery_id = ?
           AND state IN (${placeholders(expectedStates.length)})${appliedOnceAuditGuard(requestSignatureSha256)}`,
      )
      .bind(
        toState,
        evidenceJson,
        actor,
        atMs,
        deliveryId,
        ...expectedStates,
        ...appliedOnceBindings(deliveryId, requestSignatureSha256),
      );
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

  // Review finding F-C (ADR §10 H42): /healthz probed the LEGACY schema only,
  // so a deploy whose dispatch migration never applied reported ready while
  // every dispatch path threw. Read-only, aggregate-free, and deliberately not
  // on the DispatchStore interface: this is a deployment probe, not part of
  // the dispatcher's state machine. Both dispatcher-owned tables are touched
  // because 0010 creates both and a partial apply is the shape being caught.
  // Returns a BOOLEAN rather than propagating, so the `ready &&` term at the
  // call site genuinely carries the signal instead of being a constant — the
  // same shape as the legacy `healthcheck` it sits beside. /healthz answers one
  // generic 503 for every cause (§6.7), so nothing is lost by not
  // discriminating here.
  async dispatchSchemaReady(): Promise<boolean> {
    try {
      await this.#database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM dispatch_outbox WHERE 0) AS outbox,
             (SELECT COUNT(*) FROM dispatch_audit WHERE 0) AS audit,
             (SELECT COUNT(*) FROM dispatch_rate_limit WHERE 0) AS pacing`,
        )
        .first<number>("outbox");
      return true;
    } catch {
      return false;
    }
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
    // ADR §6.8 presence fence, in-batch (Copilot finding F8): a non-shadow
    // INSERT itself refuses a GUID present in the legacy deliveries table,
    // closing the check-then-insert window. Shadow rows are exempt — F2
    // pairing REQUIRES the legacy row to exist (§6.8, shadow exclusion).
    const shadowFlag = row.shadow ? 1 : 0;
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT ?, 'none', 'queued', ?, 'ingress', ?
         WHERE NOT EXISTS (
           SELECT 1 FROM dispatch_outbox WHERE delivery_id = ?
         )
           AND (? = 1 OR NOT EXISTS (
             SELECT 1 FROM deliveries WHERE delivery_id = ?
           ))`,
      )
      .bind(
        row.deliveryId,
        JSON.stringify({ destination: row.destination, shadow: row.shadow }),
        row.now,
        row.deliveryId,
        shadowFlag,
        row.deliveryId,
      );
    const insert = this.#database
      .prepare(
        `INSERT INTO dispatch_outbox (
           delivery_id, destination, shadow, payload_json, state,
           created_ms, updated_ms
         )
         SELECT ?, ?, ?, ?, 'queued', ?, ?
         WHERE ? = 1 OR NOT EXISTS (
           SELECT 1 FROM deliveries WHERE delivery_id = ?
         )
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(
        row.deliveryId,
        row.destination,
        shadowFlag,
        row.payloadJson,
        row.now,
        row.now,
        shadowFlag,
        row.deliveryId,
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

  // The audit + UPDATE pair of a `-> delivered` CAS. Extracted so the single
  // source of this SQL serves both markDelivered and recordLateProof, whose
  // batch (Copilot suppressed comment F2) carries TWO of these pairs.
  #deliveredPair(
    deliveryId: string,
    now: number,
    ts: string,
    channel: string,
    actor: "consumer" | "resolver" | "operator",
    expectedStates: readonly DispatchState[],
    evidenceJson: string,
    requestSignatureSha256: string | null,
  ): [D1PreparedStatement, D1PreparedStatement] {
    const audit = this.#transitionAudit(
      deliveryId,
      expectedStates,
      "delivered",
      asEvidenceJson(evidenceJson),
      actor,
      now,
      requestSignatureSha256,
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
           AND state IN (${placeholders(expectedStates.length)})${appliedOnceUpdateGuard(requestSignatureSha256)}`,
      )
      .bind(
        ts,
        channel,
        now + VERIFY_FIRST_SCAN_DELAY_MS,
        now,
        deliveryId,
        ...expectedStates,
      );
    return [audit, update];
  }

  async markDelivered(
    deliveryId: string,
    now: number,
    ts: string,
    channel: string,
    actor: "consumer" | "resolver" | "operator",
    expectedStates: readonly DispatchState[],
    evidenceJson: string,
    requestSignatureSha256: string | null = null,
  ): Promise<boolean> {
    const results = await this.#database.batch(
      this.#deliveredPair(
        deliveryId,
        now,
        ts,
        channel,
        actor,
        expectedStates,
        evidenceJson,
        requestSignatureSha256,
      ),
    );
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
    // Audit finding B3/B8 (ADR §10 H15, narrowing H9): the predicate was
    // `state IN ('queued','sending')` with no lease term, and its only caller
    // decides from a bare read-then-act snapshot. Two consequences, both
    // reachable because duplicate DLQ arrivals are routine: a row in `sending`
    // under a LIVE lease — a send genuinely in flight — was killed mid-flight,
    // and an operator resend landing between the handler's read and its write
    // was dead-lettered, recording the `queued -> dead_letter` transition H9
    // declares impossible. The predicate now encodes the handler's decision:
    // only a `sending` row whose lease has EXPIRED (a crash between claim and
    // outcome) dead-letters. A live-lease row is left alone; if that send does
    // crash, lease expiry hands the row to the resolver (§6.3.1
    // normalization), which is the safer of the two outcomes.
    const predicate =
      " AND state = 'sending'" +
      " AND lease_until_ms IS NOT NULL AND lease_until_ms < ?";
    // Inlined rather than via #transitionAudit, which has no bind slot for the
    // lease parameter: the audit must carry the SAME predicate as the UPDATE
    // so the journal and the row stay atomic and consistent (§6.1).
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, 'dead_letter', ?, 'consumer', ?
         FROM dispatch_outbox
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(JSON.stringify({ reason }), now, deliveryId, now);
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'dead_letter',
             last_error = ?,
             updated_ms = ?
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(reason, now, deliveryId, now);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async recordLateProof(
    deliveryId: string,
    now: number,
    ts: string,
    channel: string,
    actor: "consumer" | "resolver",
  ): Promise<"ambiguous_cas" | "manual_cas" | "audit_only"> {
    // §6.3 (R2): the unconditional audit append — canonical proof lands
    // durably no matter which state the resolver reached — and the
    // proof-beats-inference CAS, in ONE batch().
    // Copilot suppressed comment (F2): the audit used to commit in a separate
    // database operation from the CAS that follows it. A worker termination in
    // that window left the row `manual` with the proof recorded only in the
    // journal; queue redelivery then saw an unclaimable manual row and ACKed
    // it, so canonical proof never won over inference without operator
    // intervention. One batch closes the window: either the proof and the
    // transition both commit, or neither does.
    // Copilot suppressed comment (F6): the resolver also lands here when its
    // FOUND CAS loses, so the provenance of BOTH the proof audit row and the
    // delivered transition is the caller's actor — never a hard-coded
    // `consumer`.
    const evidenceJson = JSON.stringify({ late_proof: true, ts, channel });
    // Statement 1, UNCONDITIONAL (audit_only is the outcome when neither CAS
    // applies, including a delivery_id with no row at all — hence the
    // COALESCE to 'unknown' rather than an INSERT ... SELECT from the row).
    // It runs FIRST so it records the state as it was BEFORE the transitions
    // below; reordering the batch would silently rewrite that provenance.
    const proofAudit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         VALUES (
           ?,
           COALESCE((
             SELECT state FROM dispatch_outbox WHERE delivery_id = ?
           ), 'unknown'),
           COALESCE((
             SELECT state FROM dispatch_outbox WHERE delivery_id = ?
           ), 'unknown'),
           ?, ?, ?
         )`,
      )
      .bind(deliveryId, deliveryId, deliveryId, evidenceJson, actor, now);
    // Statements 2-3 then 4-5: CAS ambiguous -> delivered(ts) FIRST, manual ->
    // delivered(ts) as the fallback (§6.3 late-proof rule, R2 amended). The
    // manual-guarded pair cannot fire after the ambiguous one delivered the
    // row: both its statements carry `state IN ('manual')`, and the row is
    // `delivered` by then — the state predicate makes it an in-batch no-op.
    // (Pinned by the R2 tests: an ambiguous row returns "ambiguous_cas" with
    // exactly one transition audit row.)
    const [ambiguousAudit, ambiguousUpdate] = this.#deliveredPair(
      deliveryId,
      now,
      ts,
      channel,
      actor,
      ["ambiguous"],
      evidenceJson,
      null,
    );
    const [manualAudit, manualUpdate] = this.#deliveredPair(
      deliveryId,
      now,
      ts,
      channel,
      actor,
      ["manual"],
      evidenceJson,
      null,
    );
    const results = await this.#database.batch([
      proofAudit,
      ambiguousAudit,
      ambiguousUpdate,
      manualAudit,
      manualUpdate,
    ]);
    if (changed(results[2])) return "ambiguous_cas";
    if (changed(results[4])) return "manual_cas";
    return "audit_only";
  }

  async normalizeExpiredLeases(now: number): Promise<number> {
    // ADR §6.3.1: normalization first — audited lease_expired; the rows
    // become resolver input. Shadow rows never posted anything (§9.A1), so
    // an expired shadow lease returns to queued for the next cron pass
    // instead of entering the egress-bearing ambiguous path (panel V12).
    const realPredicate =
      "state = 'sending' AND shadow = 0" +
      " AND lease_until_ms IS NOT NULL AND lease_until_ms < ?";
    const shadowPredicate =
      "state = 'sending' AND shadow = 1" +
      " AND lease_until_ms IS NOT NULL AND lease_until_ms < ?";
    const realAudit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, 'sending', 'ambiguous', ?, 'resolver', ?
         FROM dispatch_outbox
         WHERE ${realPredicate}`,
      )
      .bind(JSON.stringify({ reason: "lease_expired" }), now, now);
    const realUpdate = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'ambiguous',
             last_error = 'lease_expired',
             next_attempt_ms = NULL,
             updated_ms = ?
         WHERE ${realPredicate}`,
      )
      .bind(now, now);
    const shadowAudit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, 'sending', 'queued', ?, 'resolver', ?
         FROM dispatch_outbox
         WHERE ${shadowPredicate}`,
      )
      .bind(JSON.stringify({ reason: "lease_expired_shadow" }), now, now);
    const shadowUpdate = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'queued',
             last_error = 'lease_expired_shadow',
             lease_until_ms = NULL,
             next_attempt_ms = NULL,
             updated_ms = ?
         WHERE ${shadowPredicate}`,
      )
      .bind(now, now);
    const results = await this.#database.batch([
      realAudit,
      realUpdate,
      shadowAudit,
      shadowUpdate,
    ]);
    return (
      (results[1]?.meta.changes ?? 0) + (results[3]?.meta.changes ?? 0)
    );
  }

  async ambiguousRowsDue(
    now: number,
    limit: number,
  ): Promise<DispatchOutboxRow[]> {
    const result = await this.#database
      .prepare(
        `SELECT * FROM dispatch_outbox
         WHERE state = 'ambiguous'
           AND shadow = 0
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
    // Copilot suppressed comment (F3) / ADR §6.3.1: "all verdict CASes run
    // WHERE state='ambiguous' only". Without the predicate, a row delivered
    // or parked by another resolver/consumer AFTER the scan snapshot is still
    // mutated here and gets a false `resolver_attempt_inconclusive` audit
    // entry. BOTH statements of the batch carry it, so both apply or neither;
    // the read-back below then returns the CURRENT (unchanged) attempts.
    const ambiguousOnly = " AND state = 'ambiguous'";
    const audit = this.#inPlaceAudit(
      deliveryId,
      JSON.stringify({ reason: "resolver_attempt_inconclusive" }),
      "resolver",
      now,
      ambiguousOnly,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET resolver_attempts = resolver_attempts + 1,
             updated_ms = ?
         WHERE delivery_id = ?${ambiguousOnly}`,
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

  async inconclusiveAttemptsSince(
    deliveryId: string,
    sinceMs: number,
  ): Promise<number> {
    // Copilot suppressed comment (F5) / ADR §6.3.1, verbatim: "after 6
    // attempts within 1 h → `manual`". The threshold is a WINDOW, not the
    // lifetime `resolver_attempts` counter, so the count is derived from the
    // inconclusive markers incrementResolverAttempts appends — the same
    // audit-marker idiom as consecutiveVerificationDeferrals, no schema
    // column.
    const count = await this.#database
      .prepare(
        `SELECT COUNT(*) AS n
         FROM dispatch_audit
         WHERE delivery_id = ?
           AND json_extract(evidence_json, '$.reason')
             = 'resolver_attempt_inconclusive'
           AND at_ms >= ?`,
      )
      .bind(deliveryId, sinceMs)
      .first<number>("n");
    return count ?? 0;
  }

  async reserveSendSlot(
    destination: DispatchDestination,
    now: number,
    intervalMs: number,
  ): Promise<number> {
    // Copilot suppressed comment (F7) / ADR §4 item 4 (~1 msg/sec/channel):
    // max_concurrency 1 only serializes consumers, it does not pace them.
    // Durable per-destination reservation with the same semantics as the
    // legacy reserveSlackSlot (src/store.ts, relay_state.next_slack_at) —
    // reserve or report the remaining wait — but on the dispatcher's own
    // table, so no legacy row is written. The upsert is a single atomic
    // statement: it self-heals a missing row and the conditional DO UPDATE
    // reports 0 changes when the slot is still held.
    const nextSendMs = now + intervalMs;
    const reservation = await this.#database
      .prepare(
        `INSERT INTO dispatch_rate_limit (destination, next_send_ms)
         VALUES (?, ?)
         ON CONFLICT(destination) DO UPDATE SET next_send_ms = ?
         WHERE dispatch_rate_limit.next_send_ms <= ?`,
      )
      .bind(destination, nextSendMs, nextSendMs, now)
      .run();
    if (changed(reservation)) return 0;
    const current = await this.#database
      .prepare(
        "SELECT next_send_ms FROM dispatch_rate_limit WHERE destination = ?",
      )
      .bind(destination)
      .first<number>("next_send_ms");
    if (current === null) return 0;
    return Math.max(1, current - now);
  }

  async operatorSweepVerification(
    deliveryId: string,
    now: number,
    evidenceJson: string,
    requestSignatureSha256: string | null,
  ): Promise<boolean> {
    // Copilot finding F5 (ADR §6.3.3/R19 repair-from-anywhere): the operator
    // sweep is the production entry point for a duplicate that materialized
    // after both automatic scans (`delivered` with verify_scans_remaining =
    // 0). It re-arms at least one scan AND stamps verify_after_ms = now,
    // because verificationRowsDue selects on verify_after_ms — arming the
    // counter alone would leave the row invisible to every resolver pass.
    // Same delivered/non-shadow predicate as the other repair-from-delivered
    // mutations: a shadow row never posted anything (§9.A1) and a
    // non-delivered row belongs to the resolver, not to a sweep.
    // Panel finding (ADR §10 H11, corrected): the counter is a CLAMPED
    // increment, because migration 0010 CHECKs `verify_scans_remaining
    // BETWEEN 0 AND 2` and an operator-resent delivered row sits at exactly 2
    // — indefinitely, since a §6.3.3/R18 inconclusive scan does not decrement
    // and F3 defers it. An unconditional `+ 1` threw the CHECK from precisely
    // the state the R19 last-resort sweep exists to rescue, rolling back the
    // audit row with it and reporting a permanent state precondition as a
    // transient 503.
    // The clamp alone would re-open F1: from 2 the counter would not move
    // while verify_after_ms = now can equal the due time a verification pass
    // already in flight observed, so BOTH halves of its completion CAS would
    // match and it would consume the operator's fresh scan. The predicate
    // therefore guarantees a CHANGE: below the maximum the counter
    // increments, so a stale pass's expected counter cannot match; at the
    // maximum the due time necessarily moves, because the one case where it
    // would not is rejected — so a stale pass's expected due time cannot
    // match. That rejected case (already at 2 AND already due at exactly this
    // instant) is a genuine no-op: the row is already armed and due, and it
    // answers 409, never 503. `IS NOT ?` — NULL-safe inequality in SQLite, so
    // a row with no due time always changes.
    const predicate =
      " AND state = 'delivered' AND shadow = 0" +
      " AND (verify_scans_remaining < 2 OR verify_after_ms IS NOT ?)";
    // Inlined rather than via #inPlaceAudit, which has no bind slot for the
    // predicate's parameter: the audit must carry the SAME predicate so the
    // journal and the row stay atomic and consistent (§6.1).
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, state, ?, 'operator', ?
         FROM dispatch_outbox
         WHERE delivery_id = ?${predicate}${appliedOnceAuditGuard(requestSignatureSha256)}`,
      )
      .bind(
        asEvidenceJson(evidenceJson),
        now,
        deliveryId,
        now,
        ...appliedOnceBindings(deliveryId, requestSignatureSha256),
      );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET verify_scans_remaining = MIN(verify_scans_remaining + 1, 2),
             verify_after_ms = ?,
             updated_ms = ?
         WHERE delivery_id = ?${predicate}${appliedOnceUpdateGuard(requestSignatureSha256)}`,
      )
      .bind(now, now, deliveryId, now);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async completeVerificationScan(
    deliveryId: string,
    now: number,
    nextVerifyAfterMs: number | null,
    expectedRemaining: number,
    expectedVerifyAfterMs: number | null,
  ): Promise<boolean> {
    // CAS on the caller's snapshot so overlapping resolver passes cannot
    // double-decrement and burn both §6.3.3 scans (panel V13).
    // Copilot finding F1: the counter alone is satisfiable by a REARM — an
    // overlapping pass that detected a partial scan or a failed deletion
    // calls flagDuplicateRepairPending, which restores
    // verify_scans_remaining to the value the stale caller observed, and the
    // stale completion then consumes the rearmed scan. verify_after_ms joins
    // the CAS as the monotonic half: a rearm always pushes it strictly
    // forward (a due row satisfies verify_after_ms <= now, the rearm sets
    // now + 15 min), so no rearm can coincidentally satisfy this predicate.
    // `IS ?` rather than `= ?` — NULL-safe equality in SQLite.
    const predicate =
      " AND verify_scans_remaining = ? AND verify_after_ms IS ?";
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, state, ?, 'resolver', ?
         FROM dispatch_outbox
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(
        JSON.stringify({
          verification_scan_complete: true,
          next_verify_after_ms: nextVerifyAfterMs,
        }),
        now,
        deliveryId,
        expectedRemaining,
        expectedVerifyAfterMs,
      );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET verify_scans_remaining = verify_scans_remaining - 1,
             verify_after_ms = ?,
             updated_ms = ?
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(
        nextVerifyAfterMs,
        now,
        deliveryId,
        expectedRemaining,
        expectedVerifyAfterMs,
      );
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async consecutiveNoProgressScans(deliveryId: string): Promise<number> {
    // Copilot finding (resolver starvation) + audit finding B1: the streak is
    // derived from the audit journal — the TRAILING run of no-progress
    // markers, i.e. every marker written after the last audit row for this
    // delivery that is not one (a completed scan, a repair, a state
    // transition, the abandon marker all reset the streak). No schema column
    // is added for it.
    // B1: the predicate is the SHARED `no_progress` field, carried by BOTH the
    // deferral marker and the duplicate-repair-pending re-arm. Two streaks —
    // one per marker kind — would reset each other, so an alternating sequence
    // (partial scan, then history 429, then partial again…), the normal shape
    // on a busy channel, would never reach any ceiling and the livelock would
    // survive the fix.
    // Review finding F2 (ADR §10 H21): the two deletion-bookkeeping markers are
    // NEUTRAL — neither progress nor no-progress. They are written between the
    // scan and its re-arm, so counting them as progress would reset the streak
    // on every pass of a row whose chat.delete keeps failing and would restore
    // exactly the unbounded livelock H14 closed. The COMPLETION marker
    // (`repaired_duplicate`) is deliberately NOT neutral: a deleted copy is
    // real progress and resets the streak, as it always did.
    const count = await this.#database
      .prepare(
        `SELECT COUNT(*) AS n
         FROM dispatch_audit
         WHERE delivery_id = ?
           AND json_extract(evidence_json, '$.no_progress') = 1
           AND seq > COALESCE((
             SELECT MAX(seq)
             FROM dispatch_audit
             WHERE delivery_id = ?
               AND COALESCE(
                 json_extract(evidence_json, '$.no_progress'), 0
               ) != 1
               AND COALESCE(
                 json_extract(evidence_json, '$.duplicate_deletion_intent'), 0
               ) != 1
               AND COALESCE(
                 json_extract(
                   evidence_json, '$.duplicate_deletion_not_applied'
                 ), 0
               ) != 1
           ), 0)`,
      )
      .bind(deliveryId, deliveryId)
      .first<number>("n");
    return count ?? 0;
  }

  async deferVerificationScan(
    deliveryId: string,
    now: number,
    nextVerifyAfterMs: number,
    evidenceJson: string,
    expectedVerifyAfterMs: number | null,
  ): Promise<boolean> {
    // §6.3.3: verification scans are INCONCLUSIVE-safe — the counter is
    // untouched; only verify_after_ms moves forward, so the row leaves the
    // due set and a due ambiguous row can be examined.
    // Audit finding B7: the caller's OBSERVED verify_after_ms joins the CAS,
    // exactly as completeVerificationScan carries it. Without it a pass acting
    // on a stale snapshot pushed the due time of a row that had been re-armed
    // after that snapshot — including by an operator sweep (H11), whose whole
    // point is a scan due NOW. `IS ?` rather than `= ?` — NULL-safe equality
    // in SQLite.
    const predicate =
      " AND state = 'delivered' AND shadow = 0" +
      " AND verify_scans_remaining > 0 AND verify_after_ms IS ?";
    // Inlined rather than via #inPlaceAudit, which has no bind slot for the
    // snapshot parameter: the audit carries the SAME predicate as the UPDATE.
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, state, ?, 'resolver', ?
         FROM dispatch_outbox
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(
        asEvidenceJson(evidenceJson),
        now,
        deliveryId,
        expectedVerifyAfterMs,
      );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET verify_after_ms = ?,
             updated_ms = ?
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(nextVerifyAfterMs, now, deliveryId, expectedVerifyAfterMs);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async abandonVerification(
    deliveryId: string,
    now: number,
    expectedVerifyAfterMs: number | null,
    evidenceJson: string,
  ): Promise<boolean> {
    // Audit finding B1 / ADR §10 H14: the exit the non-exhausted re-arm never
    // had. The row stays `delivered` and KEEPS verify_scans_remaining as
    // evidence of the unfinished verification; clearing verify_after_ms is
    // what removes it from verificationRowsDue (which requires a non-null due
    // time), and it is also the signal statusCounters counts for the
    // `verification_abandoned` alarm. An operator sweep (H11) stamps
    // verify_after_ms = now and restarts verification — with a fresh streak,
    // because this marker carries no `no_progress` field and therefore breaks
    // the trailing run.
    // Same snapshot guard as deferVerificationScan (B7): a sweep that landed
    // after this pass's snapshot must never be abandoned by it.
    const predicate =
      " AND state = 'delivered' AND shadow = 0" +
      " AND verify_scans_remaining > 0 AND verify_after_ms IS ?";
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, state, ?, 'resolver', ?
         FROM dispatch_outbox
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(
        asEvidenceJson(evidenceJson),
        now,
        deliveryId,
        expectedVerifyAfterMs,
      );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET verify_after_ms = NULL,
             updated_ms = ?
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(now, deliveryId, expectedVerifyAfterMs);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async updateCanonicalTs(
    deliveryId: string,
    now: number,
    ts: string,
    evidenceJson: string,
    expectedTs: string | null,
  ): Promise<boolean> {
    // §6.3.2/§6.3.3: repair FROM delivered — the earliest ts becomes the
    // recorded canonical ts; the row never leaves delivered.
    // E1 enumeration (ADR §10 H25): the caller decides from the ts it OBSERVED
    // (`row.slackMessageTs`, or the re-read `fresh.slackMessageTs` after a lost
    // found_many CAS) and the predicate did not encode it. A pass whose scan
    // was PARTIAL could therefore overwrite an earlier canonical ts that a
    // fuller concurrent scan had just recorded, regressing the row to a LATER
    // copy and contradicting §6.3.2's "the EARLIEST ts is canonical" — while
    // the deletion loop's "never delete the recorded ts" filter kept using the
    // stale observed value. The observed ts joins the CAS: a concurrent
    // repair's ts survives, and R19 keeps any residual repairable by a later
    // scan. `IS ?` — NULL-safe equality in SQLite.
    const predicate =
      " AND state = 'delivered' AND shadow = 0 AND slack_message_ts IS ?";
    // Inlined rather than via #inPlaceAudit, which has no bind slot for the
    // snapshot parameter: the audit carries the SAME predicate as the UPDATE.
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, state, ?, 'resolver', ?
         FROM dispatch_outbox
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(asEvidenceJson(evidenceJson), now, deliveryId, expectedTs);
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET slack_message_ts = ?,
             updated_ms = ?
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(ts, now, deliveryId, expectedTs);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async flagDuplicateRepairPending(
    deliveryId: string,
    now: number,
    nextVerifyAfterMs: number,
    evidenceJson: string,
    expectedVerifyAfterMs: number | null,
    expectedScansRemaining: number,
  ): Promise<boolean> {
    // Copilot finding F5 (ADR §6.3.2/R19): a detected duplicate whose
    // deletion failed must keep a future scan — verify_scans_remaining is
    // raised to at least 1 and the next scan is due at the caller's time.
    // One batch with its pending-marker audit row (§6.1).
    // Audit finding B1: the due time used to be a FLAT now + 15 min written
    // here, which is what made the non-exhausted scan re-arm itself every
    // 15 minutes for ever. The caller now supplies it from the shared
    // no-progress backoff and stops re-arming at the ceiling (H14).
    // Review finding F1 (ADR §10 H20): this re-arm was the ONE no-progress
    // writer with no snapshot guard, while completeVerificationScan (F1),
    // deferVerificationScan and abandonVerification (B7) all carry one. An
    // operator sweep (H11) landing after the caller's observation stamps
    // verify_after_ms = now to force a due-now scan; this UPDATE then pushed
    // it to now + backoff and postponed exactly the scan the sweep promised.
    // BOTH observed halves join the CAS, because H11's change-guaranteeing
    // predicate moves the counter OR the due time and never neither: below the
    // schema maximum the sweep increments the counter, at the maximum it
    // necessarily moves the due time. Guarding on one half alone would
    // therefore leave the other case open. `IS ?` — NULL-safe equality in
    // SQLite, so a row with no due time is matched by a null expectation.
    const predicate =
      " AND state = 'delivered' AND shadow = 0" +
      " AND verify_after_ms IS ? AND verify_scans_remaining = ?";
    // Inlined rather than via #inPlaceAudit, which has no bind slot for the
    // snapshot parameters: the audit carries the SAME predicate as the UPDATE
    // so the journal and the row stay atomic and consistent (§6.1).
    const audit = this.#database
      .prepare(
        `INSERT INTO dispatch_audit (
           delivery_id, from_state, to_state, evidence_json, actor, at_ms
         )
         SELECT delivery_id, state, state, ?, 'resolver', ?
         FROM dispatch_outbox
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(
        asEvidenceJson(evidenceJson),
        now,
        deliveryId,
        expectedVerifyAfterMs,
        expectedScansRemaining,
      );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET verify_scans_remaining = MAX(verify_scans_remaining, 1),
             verify_after_ms = ?,
             updated_ms = ?
         WHERE delivery_id = ?${predicate}`,
      )
      .bind(
        nextVerifyAfterMs,
        now,
        deliveryId,
        expectedVerifyAfterMs,
        expectedScansRemaining,
      );
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async operatorResend(
    deliveryId: string,
    now: number,
    evidenceJson: string,
    requestSignatureSha256: string | null,
  ): Promise<boolean> {
    // ADR §6.2 routes dead_letter to the operator menu alongside manual
    // (Copilot finding F7): same audited possible-duplicate resend, same
    // §6.3.3 verification arming.
    const expectedStates: readonly DispatchState[] = ["manual", "dead_letter"];
    const audit = this.#transitionAudit(
      deliveryId,
      expectedStates,
      "queued",
      asEvidenceJson(evidenceJson),
      "operator",
      now,
      requestSignatureSha256,
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
         WHERE delivery_id = ?
           AND state IN (${placeholders(expectedStates.length)})${appliedOnceUpdateGuard(requestSignatureSha256)}`,
      )
      .bind(now, deliveryId, ...expectedStates);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async operatorCloseManual(
    deliveryId: string,
    now: number,
    evidenceJson: string,
    requestSignatureSha256: string | null,
  ): Promise<boolean> {
    const audit = this.#transitionAudit(
      deliveryId,
      ["manual"],
      "closed_manual",
      asEvidenceJson(evidenceJson),
      "operator",
      now,
      requestSignatureSha256,
    );
    const update = this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET state = 'closed_manual',
             updated_ms = ?
         WHERE delivery_id = ? AND state = 'manual'${appliedOnceUpdateGuard(requestSignatureSha256)}`,
      )
      .bind(now, deliveryId);
    const results = await this.#database.batch([audit, update]);
    return changed(results[1]);
  }

  async operatorCommandApplied(
    deliveryId: string,
    requestSignatureSha256: string,
  ): Promise<boolean> {
    // Copilot finding F6: the five-minute freshness window bounds replay but
    // does not make a non-idempotent operator command one-shot. Every
    // operator transition bakes the SHA-256 of its request signature into
    // its audit evidence, so the audit journal IS the applied-command
    // ledger — no schema column, and the CAS-guarded audit INSERT means a
    // command that changed nothing (409) leaves no marker and stays
    // retryable.
    const count = await this.#database
      .prepare(
        `SELECT COUNT(*) AS n
         FROM dispatch_audit
         WHERE delivery_id = ?
           AND actor = 'operator'
           AND json_extract(evidence_json, '$.request_signature_sha256') = ?`,
      )
      .bind(deliveryId, requestSignatureSha256)
      .first<number>("n");
    return (count ?? 0) > 0;
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

  async markQueuedRepublished(
    deliveryId: string,
    now: number,
  ): Promise<boolean> {
    // Audit finding B3 (the amplifier behind duplicate DLQ arrivals): the cron
    // republished every stale `queued` row on EVERY pass, because a republish
    // changed nothing on the row and staleQueuedRows selects on updated_ms
    // alone. Stamping updated_ms restarts that window, so the same row is
    // republished at most once per STALE_QUEUED_REQUEUE_AFTER_MS instead of
    // once per pass. This reduces duplicate queue messages, it does not
    // eliminate them (R13 keeps republishing until the row leaves `queued`,
    // and the queue is at-least-once by construction) — the actual protection
    // against a duplicate arrival is the claim CAS (R1) and the markDeadLetter
    // predicate narrowed with this finding. No audit row: see the file header.
    const result = await this.#database
      .prepare(
        `UPDATE dispatch_outbox
         SET updated_ms = ?
         WHERE delivery_id = ? AND state = 'queued'`,
      )
      .bind(now, deliveryId)
      .run();
    return changed(result);
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
    > = { alerts: zero() };
    // Review finding F3 (ADR §10 H18, correcting H3) — and RETAINED under H39
    // on different grounds. H39 narrowed migration 0010 to
    // `CHECK (destination = 'alerts')`, so no foreign-destination row can
    // exist any more and this predicate can no longer change a result set.
    // It stays because the dereference below is an unchecked dynamic index
    // into a map declared `{ alerts: … }`, and the predicate — bound from that
    // map's OWN keys — is the only guard on it the TypeScript compiler can
    // see; removing it would re-parent that safety onto a CHECK in a .sql file
    // the compiler cannot read. The history it was written for:
    // migration 0010 CHECKed
    // `destination IN ('alerts','activity')` and the schema REDs inserted such
    // a row, but §10 H2 reduced the dispatcher to `alerts`, so this map — and
    // the DispatchDestination union it is keyed by — knows only that one. The
    // grouped query returned every destination the TABLE holds, so a
    // schema-valid `activity` row made the dereference below throw: `/status`
    // answered 503 and, because runDispatchCronPass opens with this call,
    // EVERY dispatch cron pass aborted. The aggregates are therefore scoped to
    // the destinations the dispatcher owns, and the scope is bound from the
    // counter map's OWN keys — the query can no longer return a destination
    // the map lacks, which is exactly the invariant whose absence caused this.
    const ownedDestinations = Object.keys(byStateAndDestination);
    const ownedPredicate = `destination IN (${placeholders(ownedDestinations.length)})`;
    const grouped = await this.#database
      .prepare(
        `SELECT destination, state, COUNT(*) AS n
         FROM dispatch_outbox
         WHERE ${ownedPredicate}
         GROUP BY destination, state`,
      )
      .bind(...ownedDestinations)
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
         WHERE state IN ('queued', 'sending', 'ambiguous', 'manual')
           AND ${ownedPredicate}`,
      )
      .bind(...ownedDestinations)
      .first<number | null>("oldest_ms");
    // Copilot finding F6 (ADR §6.7): ambiguous_stale alarms on the oldest
    // AMBIGUOUS row specifically, never on an old manual/queued row.
    // Review finding F-A (ADR §10 H40): and it measures TIME IN STATE, not row
    // age. `created_ms` is the INGRESS instant, so a row that waited hours in
    // `queued` — mode off, pacing, a token outage — or an operator-resent row
    // days old raised the alarm the instant it first went ambiguous, i.e.
    // exactly while the system was recovering normally. No column records the
    // ambiguous transition (`dispatch_audit` does, but the resolver appends a
    // second ambiguous->ambiguous entry per Retry-After, so the episode start
    // is a per-row query, not one MIN). The anchor is therefore the claim
    // instant of the last send attempt: `claim()` is the ONLY writer of
    // `last_send_start_ms` and the only writer of `state = 'sending'`, and
    // every path into `ambiguous` comes from `sending` (or from `ambiguous`,
    // which preserves it), so the COALESCE is defensive only. It still
    // over-reports, but boundedly — by at most the 30 s client timeout on the
    // consumer path, or one 90 s lease plus one `*/5` cron period on the
    // normalization path, against a 30 min threshold. `updated_ms` was
    // considered and REJECTED as fail-dangerous: `incrementResolverAttempts`
    // bumps it while the row stays ambiguous, and H10 computes the contended
    // per-row cadence as 15 min, so the measured age would sit below the
    // threshold during precisely the outage the alarm exists for.
    const oldestAmbiguous = await this.#database
      .prepare(
        `SELECT MIN(COALESCE(last_send_start_ms, created_ms)) AS oldest_ms
         FROM dispatch_outbox
         WHERE state = 'ambiguous'
           AND ${ownedPredicate}`,
      )
      .bind(...ownedDestinations)
      .first<number | null>("oldest_ms");
    // Audit finding B1 / ADR §10 H14: rows that stopped re-arming their
    // verification — `delivered`, scans still remaining, no due time left.
    // markDelivered stamps verify_after_ms whenever the counter is positive
    // and every re-arm sets both, so abandonVerification is the only writer
    // that produces this shape. Row-derived rather than marker-derived, so an
    // operator sweep clears the alarm instead of leaving it latched forever.
    const abandoned = await this.#database
      .prepare(
        `SELECT COUNT(*) AS n
         FROM dispatch_outbox
         WHERE state = 'delivered'
           AND shadow = 0
           AND verify_scans_remaining > 0
           AND verify_after_ms IS NULL
           AND ${ownedPredicate}`,
      )
      .bind(...ownedDestinations)
      .first<number>("n");
    return {
      byStateAndDestination,
      oldestNonTerminalAgeMs: oldest === null ? null : now - oldest,
      oldestAmbiguousAgeMs:
        oldestAmbiguous === null ? null : now - oldestAmbiguous,
      repairedDuplicates: await this.repairedDuplicatesTotal(),
      verificationAbandoned: abandoned ?? 0,
      // Review finding F2 / ADR §10 H21: a deletion whose completion never
      // landed is countable here and alarmed by the observer.
      unreconciledDeletionIntents: await this.unreconciledDeletionIntents(),
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

  async unreconciledDeletionIntents(): Promise<number> {
    // Review finding F2 (ADR §10 H21): §6.3.2 requires every deletion to be
    // audited, and the repair marker was written AFTER chat.delete returned.
    // A worker termination — or any D1 failure — in that window destroyed the
    // evidence for ever: the copy is gone from Slack, so no later history scan
    // can rediscover it, and the row's own state is unchanged. The resolver
    // now records the INTENT before the call and reconciles it afterwards, so
    // this counts intents left without an outcome for the SAME target ts.
    // `target_ts` is the correlation key carried by all three markers (the
    // intent, the `repaired_duplicate` completion, the `not_applied` marker of
    // a chat.delete that did not succeed); `seq >` scopes the match to
    // outcomes recorded after the intent, so a retried deletion of the same ts
    // in a later pass reconciles the earlier intent too — a copy that survived
    // and is repaired later is not an unreconciled deletion.
    const count = await this.#database
      .prepare(
        `SELECT COUNT(*) AS n
         FROM dispatch_audit AS intent
         WHERE json_extract(intent.evidence_json, '$.duplicate_deletion_intent')
             = 1
           AND NOT EXISTS (
             SELECT 1 FROM dispatch_audit AS outcome
             WHERE outcome.delivery_id = intent.delivery_id
               AND outcome.seq > intent.seq
               AND json_extract(outcome.evidence_json, '$.target_ts')
                 = json_extract(intent.evidence_json, '$.target_ts')
               AND (
                 json_extract(outcome.evidence_json, '$.repaired_duplicate') = 1
                 OR json_extract(
                      outcome.evidence_json, '$.duplicate_deletion_not_applied'
                    ) = 1
               )
           )`,
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
