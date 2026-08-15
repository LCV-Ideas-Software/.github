// ADR-001 §6.1/§6.7/§6.8 — glue between index.ts and the dispatch modules.
// Everything here is inert while DISPATCH_MODE is "off" and dispatch_outbox
// is empty (F1 ships in that state); mode flips are config-only deploys.
import type { RelayDestination } from "../domain";
import {
  type DispatchDestination,
  type DispatchMode,
  type DispatchOutboxRow,
  type DispatchState,
  type DispatchStatusCounters,
  type DispatchStore,
} from "./contract";
import { processDispatchMessage } from "./consumer";
import { fenceDecision } from "./mode";
import { observerAlarms } from "./observer";
import { D1DispatchStore } from "./outbox";
import { runResolverPass } from "./resolver";

// §9.A1/§9.A2 + §10 (operator decisions, issue #192 comments 5297040618 and
// 5299997975): the dispatcher's only destination is the existing private
// channel #github-alerts; #github-activity belongs to the official
// "GitHub for Slack" app.
export const DISPATCH_CHANNELS: Readonly<
  Record<DispatchDestination, string>
> = Object.freeze({
  alerts: "C0BMUK793NV",
});

// §10: the aggregate helpers below iterate this list instead of naming each
// destination, so restoring a second destination stays a one-line change.
const DISPATCH_DESTINATIONS: readonly DispatchDestination[] = ["alerts"];

// R9/§9.A4: workspace retention verified "never delete" (operator screenshot;
// probes green). Proven-absent verdicts are unreachable if this is ever
// reset to null.
export const RETENTION_VERIFIED_EVIDENCE =
  "issue #192 comments 5297493344 + 5297540210 (2026-08-14)";

// §6.7: "increased since the last observation" is derived read-only by
// comparing the marker count at now minus two cron periods with the total.
export const OBSERVER_LOOKBACK_MS = 10 * 60 * 1_000;

const CRON_PROCESS_LIMIT = 20;

export function channelForDestination(
  destination: DispatchDestination,
): string {
  return DISPATCH_CHANNELS[destination];
}

export interface DispatchQueueJobBody {
  deliveryId: string;
  path: "dispatch";
}

export function dispatchQueueJobBody(deliveryId: string): DispatchQueueJobBody {
  return { deliveryId, path: "dispatch" };
}

// Published bodies carry the marker; legacy bodies never do, so unmarked
// messages keep flowing to the legacy consumers untouched during F3 drain.
export function isDispatchQueueJob(body: unknown): body is DispatchQueueJobBody {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>)["path"] === "dispatch" &&
    typeof (body as Record<string, unknown>)["deliveryId"] === "string"
  );
}

// §6.8: the legacy ingress (modes off/shadow) accepts a GUID as NEW only if
// the outbox has no non-shadow row for it. Read-only PK lookup.
export async function legacyAcceptBlockedByOutbox(
  store: DispatchStore,
  deliveryId: string,
): Promise<boolean> {
  const row = await store.get(deliveryId);
  return row !== null && !row.shadow;
}

// §6.8 primary mode: the outbox is the accepting path; the legacy table is
// the "other path" the fence reads forever.
export async function acceptPrimary(
  store: DispatchStore,
  input: {
    deliveryId: string;
    destination: DispatchDestination;
    payloadJson: string;
    now: number;
  },
): Promise<"inserted" | "duplicate" | "blocked_other_path"> {
  const [hasLegacyRow, outboxRow] = await Promise.all([
    store.legacyRowExists(input.deliveryId),
    store.get(input.deliveryId),
  ]);
  const decision = fenceDecision(
    "primary",
    hasLegacyRow,
    outboxRow === null
      ? null
      : { state: outboxRow.state, shadow: outboxRow.shadow },
  );
  if (decision === "blocked_other_path") return "blocked_other_path";
  if (decision === "duplicate_same_path") return "duplicate";
  const inserted = await store.insert({
    deliveryId: input.deliveryId,
    destination: input.destination,
    shadow: false,
    payloadJson: input.payloadJson,
    now: input.now,
  });
  return inserted ? "inserted" : "duplicate";
}

// §6.8 F2: the legacy row and the shadow outbox row commit in ONE batch()
// (a 5xx to GitHub implies neither committed). The legacy INSERT below is a
// deliberate byte-copy of D1DeliveryStore.insert (src/store.ts) — the legacy
// path is frozen, and reaching into the legacy store class would couple the
// new module to code scheduled for F4 removal.
export async function insertShadowPaired(
  database: D1Database,
  input: {
    deliveryId: string;
    eventType: string;
    action: string;
    repository: string;
    destination: DispatchDestination;
    payloadJson: string;
    now: number;
  },
): Promise<{ legacyInserted: boolean; shadowInserted: boolean }> {
  // §6.8 presence fence, in-batch (Copilot finding F8): the legacy INSERT
  // itself refuses a GUID that already has a non-shadow outbox row, closing
  // the check-then-insert window (shadow rows are excluded — §6.8).
  const legacyInsert = database
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
      )
      SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM dispatch_outbox WHERE delivery_id = ? AND shadow = 0
      )
      ON CONFLICT(delivery_id) DO NOTHING`,
    )
    .bind(
      input.deliveryId,
      input.eventType,
      input.action,
      input.repository,
      input.destination,
      input.payloadJson,
      input.now,
      input.now,
      input.now,
      input.deliveryId,
    );
  // changes() reflects the PREVIOUS statement on the same connection, so the
  // shadow row commits only when the legacy insert actually inserted (no
  // orphan shadow row on a redelivered GUID — panel V21) and the audit row
  // commits only when the shadow insert actually inserted (panel V11).
  const shadowInsert = database
    .prepare(
      `INSERT INTO dispatch_outbox (
        delivery_id, destination, shadow, payload_json, state,
        created_ms, updated_ms
      )
      SELECT ?, ?, 1, ?, 'queued', ?, ?
      WHERE changes() > 0`,
    )
    .bind(
      input.deliveryId,
      input.destination,
      input.payloadJson,
      input.now,
      input.now,
    );
  const auditInsert = database
    .prepare(
      `INSERT INTO dispatch_audit (
        delivery_id, from_state, to_state, evidence_json, actor, at_ms
      )
      SELECT ?, 'none', 'queued', ?, 'ingress', ?
      WHERE changes() > 0`,
    )
    .bind(
      input.deliveryId,
      JSON.stringify({ shadow: true, destination: input.destination }),
      input.now,
    );
  const [legacyResult, shadowResult] = await database.batch([
    legacyInsert,
    shadowInsert,
    auditInsert,
  ]);
  return {
    legacyInserted: (legacyResult?.meta.changes ?? 0) > 0,
    shadowInserted: (shadowResult?.meta.changes ?? 0) > 0,
  };
}

// §6.8 modes off (Copilot finding F8): the legacy ingress insert with the
// presence fence INSIDE the statement — the legacy row cannot commit while a
// non-shadow outbox row exists for the GUID (the read fence in index.ts only
// narrows that window). Same deliberate byte-copy rationale as
// insertShadowPaired above; ON CONFLICT DO NOTHING semantics preserved
// (false => duplicate => 202).
// §10: this writes the LEGACY deliveries row, which still carries both
// destinations (an "activity" delivery takes this path in every mode), so the
// field is typed RelayDestination — unlike insertShadowPaired, whose outbox
// row is dispatcher-owned and therefore alerts-only.
export async function insertLegacyFenced(
  database: D1Database,
  input: {
    deliveryId: string;
    eventType: string;
    action: string;
    repository: string;
    destination: RelayDestination;
    payloadJson: string;
    now: number;
  },
): Promise<boolean> {
  const result = await database
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
      )
      SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM dispatch_outbox WHERE delivery_id = ? AND shadow = 0
      )
      ON CONFLICT(delivery_id) DO NOTHING`,
    )
    .bind(
      input.deliveryId,
      input.eventType,
      input.action,
      input.repository,
      input.destination,
      input.payloadJson,
      input.now,
      input.now,
      input.now,
      input.deliveryId,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export interface DispatchCronDeps {
  database: D1Database;
  mode: DispatchMode;
  fetch: typeof fetch;
  now: () => number;
  readBotToken: () => Promise<string>;
  publish: (destination: DispatchDestination, body: DispatchQueueJobBody) => Promise<void>;
}

export interface DispatchCronResult {
  skipped: boolean;
  shadowProcessed: number;
  requeued: number;
  resolverExamined: number;
  // Audit finding B4: rows whose examination threw and was contained, so the
  // pass could finish the remaining rows. Logged by runDispatchScheduled.
  resolverFailed: number;
  // Review finding C (E8): stale-queued rows whose publish or shadow
  // processing threw and was contained — the resolver step ran regardless.
  staleFailed: number;
  alarms: string[];
}

// Copilot suppressed comment (F3) / ADR §6.7 + R5: the observe-only alarms are
// READ-ONLY and must survive any failure of the write/egress steps — a Secrets
// Store or Slack outage is precisely when `manual_present`,
// `dead_letter_present`, `ambiguous_stale` and the queued-backlog alarm matter
// most. The pass therefore computes them even when the stale-requeue, resolver
// or publish step throws, and reports them on the failure path through this
// error, so the caller logs the same alarm set it would have logged on
// success. `cause` carries the ORIGINAL failure untouched, so the existing
// failure summary is unchanged.
export class DispatchCronPassError extends Error {
  readonly alarms: readonly string[];

  constructor(cause: unknown, alarms: readonly string[]) {
    super("dispatch_cron_pass_failed", { cause });
    this.name = "DispatchCronPassError";
    this.alarms = alarms;
  }
}

// R13 / §6.8 regime A / §9.A1 — the per-row unit of the cron's stale-queued
// step, extracted so runDispatchCronPass can contain ONE row's failure
// (review finding C) instead of losing the whole pass with it.
async function processStaleQueuedRow(
  row: DispatchOutboxRow,
  store: DispatchStore,
  deps: DispatchCronDeps,
): Promise<void> {
  if (row.shadow) {
    // §9.A1: shadow rows never reach Slack; they are claimed and terminally
    // recorded here, entirely off-queue.
    await processDispatchMessage(
      {
        body: { deliveryId: row.deliveryId, mode: deps.mode },
        attempts: 1,
        ack: () => {},
        retry: () => {},
      },
      {
        store,
        fetch: deps.fetch,
        now: deps.now,
        botToken: "",
        channelFor: channelForDestination,
      },
    );
    return;
  }
  // R13 in primary; §6.8 regime A in shadow — after a rollback flip the
  // non-shadow backlog must still drain (panel V8/V10). The consumer applies
  // the mode active at consume time, so a republished row is deferred (not
  // sent) if the mode is not primary by then.
  await deps.publish(row.destination, dispatchQueueJobBody(row.deliveryId));
  // Audit finding B3: the republish changed nothing on the row, and
  // staleQueuedRows selects on updated_ms alone, so the SAME row was
  // republished on every pass — the amplifier that made duplicate DLQ
  // arrivals routine. Stamping updated_ms restarts its stale window.
  // Stamped AFTER a successful publish: a failed publish must leave the row
  // immediately re-publishable.
  await store.markQueuedRepublished(row.deliveryId, deps.now());
}

// §6.7 observe-only job + §6.3.1 resolver budget + R13 stale re-enqueue.
// Called from the scheduled() entrypoint OUTSIDE runScheduledRecovery, so
// the legacy protocol-seal early return can never starve it (panel V6).
export async function runDispatchCronPass(
  deps: DispatchCronDeps,
): Promise<DispatchCronResult> {
  const store = new D1DispatchStore(deps.database);
  const now = deps.now();
  const counters = await store.statusCounters(now);
  const totalRows = countAllRows(counters);
  if (totalRows === 0) {
    return {
      skipped: true,
      shadowProcessed: 0,
      requeued: 0,
      resolverExamined: 0,
      resolverFailed: 0,
      staleFailed: 0,
      alarms: [],
    };
  }

  let shadowProcessed = 0;
  let requeued = 0;
  // Review finding C: stale rows whose publish/processing threw and was
  // contained, so the resolver step still ran. Logged by runDispatchScheduled.
  let staleFailed = 0;
  let resolverExamined = 0;
  let resolverFailed = 0;
  // F3: the failure of a write/egress step is captured, never allowed to skip
  // the observe-only snapshot below; it is rethrown after the alarms exist.
  let passFailure: unknown;
  let passFailed = false;

  try {
    // R20: in mode off nothing is processed or published — rows accumulate in
    // queued and the queued_backlog_stale alarm below makes that visible.
    if (deps.mode !== "off") {
      const stale = await store.staleQueuedRows(now, CRON_PROCESS_LIMIT);
      for (const row of stale) {
        // Review finding C (E8): one stale row's failure must not exit the
        // shared pass. A rejecting Queue publish used to escape this loop, the
        // enclosing try and the whole pass, so lease normalization and
        // runResolverPass never ran: a QUEUE-only outage also froze every
        // ambiguous and verification-due row, whose recovery is D1 plus Slack
        // history and does not touch the queue at all. Each row is contained
        // here, exactly as runResolverPass already contains each examined row
        // (audit finding B4). The row itself loses nothing: a failed publish
        // leaves updated_ms unstamped, so R13 re-selects it on the next pass.
        try {
          await processStaleQueuedRow(row, store, deps);
          if (row.shadow) shadowProcessed += 1;
          else requeued += 1;
        } catch {
          staleFailed += 1;
        }
      }
    }

    // §6.8/R20 "egress pauses" in mode off: the resolver performs Slack
    // egress (conversations.history, chat.delete) and therefore never runs in
    // mode off (panel V2); ambiguous rows wait, alarmed, for re-enable.
    if (deps.mode !== "off") {
      // Review finding N1 (ADR §10 H23): §6.3.1 normalization is a D1-only
      // transition — no Slack call, no token. It used to run INSIDE
      // runResolverPass, i.e. after `readBotToken()`, so a Secrets Store
      // outage skipped it entirely: an expired `sending` lease never became
      // `ambiguous`, a crashed real send stayed invisible to the
      // `ambiguous_stale` alarm computed below, and a shadow row — which needs
      // no token at all (§9.A1) — never returned to `queued`. The one moment
      // the token is unreadable is exactly when that visibility matters most.
      // It therefore runs FIRST, and the resolver's own normalization stays
      // where §6.3.1 puts it (a no-op by then, and the direct-call contract
      // for runResolverPass is unchanged).
      await store.normalizeExpiredLeases(now);
      // The need for egress — and therefore for the token — is decided from
      // the POST-normalization due set: rows that just became `ambiguous` are
      // included, and a backlog that is not due yet (§6.2/R4 next_attempt_ms)
      // costs no secret read at all.
      const [ambiguousDue, verificationDue] = await Promise.all([
        store.ambiguousRowsDue(now, 1),
        store.verificationRowsDue(now, 1),
      ]);
      if (ambiguousDue.length > 0 || verificationDue.length > 0) {
        const botToken = await deps.readBotToken();
        const pass = await runResolverPass({
          store,
          fetch: deps.fetch,
          now: deps.now,
          botToken,
          channelFor: channelForDestination,
          retentionVerifiedEvidence: RETENTION_VERIFIED_EVIDENCE,
        });
        resolverExamined = pass.examined;
        resolverFailed = pass.failed;
      }
    }
  } catch (error) {
    // F3: a Secrets Store or Slack failure used to throw past the observe-only
    // snapshot, so the alarms disappeared exactly while egress was unhealthy.
    // The failure is held here and rethrown below, with the alarms attached.
    passFailure = error;
    passFailed = true;
  }

  let alarms: string[] = [];
  try {
    const after = await store.statusCounters(deps.now());
    const previousRepaired = await store.repairedDuplicatesBefore(
      now - OBSERVER_LOOKBACK_MS,
    );
    alarms = observerAlarms(
      {
        deadLetter: sumState(after, "dead_letter"),
        manual: sumState(after, "manual"),
        // §6.7 (Copilot finding F6): ambiguous_stale takes the per-state
        // ambiguous age — an old manual row plus a fresh ambiguous row must
        // not false-alarm. queued_backlog_stale below deliberately keeps the
        // non-terminal age (R20 backlog approximation).
        oldestAmbiguousAgeMs: after.oldestAmbiguousAgeMs,
        repairedDuplicates: after.repairedDuplicates,
        queued: sumState(after, "queued"),
        oldestNonTerminalAgeMs: after.oldestNonTerminalAgeMs,
        // Audit finding B1 / ADR §10 H14: a delivered row that stopped
        // re-arming its verification is alarmed, never silent.
        verificationAbandoned: after.verificationAbandoned,
        // Review finding F2 / ADR §10 H21: a duplicate deletion whose repair
        // record never landed is alarmed — its evidence cannot be rebuilt by
        // any later scan, so the pre-recorded intent is all the operator gets.
        unreconciledDeletionIntents: after.unreconciledDeletionIntents,
      },
      { repairedDuplicates: previousRepaired },
    );
  } catch (observerError) {
    // F3: the observer's own failure keeps its previous behavior when the
    // pass itself was healthy. When the pass had ALREADY failed, the original
    // failure is the one that must reach the log — the snapshot is simply
    // empty. Never let the read-only path overwrite the real cause.
    if (!passFailed) throw observerError;
  }

  if (passFailed) {
    // F3: the alarms are computed and reported; the original failure keeps
    // propagating (and keeps being logged) exactly as before, as `cause`.
    throw new DispatchCronPassError(passFailure, alarms);
  }
  return {
    skipped: false,
    shadowProcessed,
    requeued,
    resolverExamined,
    resolverFailed,
    staleFailed,
    alarms,
  };
}

function countAllRows(counters: DispatchStatusCounters): number {
  let total = 0;
  for (const destination of DISPATCH_DESTINATIONS) {
    for (const count of Object.values(
      counters.byStateAndDestination[destination],
    )) {
      total += count;
    }
  }
  return total;
}

function sumState(
  counters: DispatchStatusCounters,
  state: DispatchState,
): number {
  let total = 0;
  for (const destination of DISPATCH_DESTINATIONS) {
    total += counters.byStateAndDestination[destination][state];
  }
  return total;
}

// §6.7: aggregate counters ONLY — no identifiers, keys or configuration on
// the unauthenticated surface (panel F2).
// Review finding F4: statusCounters computes `verificationAbandoned` and
// `unreconciledDeletionIntents`, and the observer raises an alarm for each, but
// this body dropped both. Until the F3 human notification channel exists (§10
// H26) the runbook sends the operator to /status, so those two actionable
// failures were invisible through the documented interim check. Both are
// aggregate COUNTS — no delivery id, ts or channel — so §6.7's rule for this
// unauthenticated surface is unchanged.
export function dispatchStatusBody(
  counters: DispatchStatusCounters,
): Record<string, unknown> {
  return {
    dispatch: {
      counters: counters.byStateAndDestination,
      oldest_non_terminal_age_ms: counters.oldestNonTerminalAgeMs,
      repaired_duplicates: counters.repairedDuplicates,
      verification_abandoned: counters.verificationAbandoned,
      unreconciled_deletion_intents: counters.unreconciledDeletionIntents,
    },
  };
}
