// A matriz de escritas do ADR-002 §4 mora aqui, e é ela que os testes
// prendem: o INGRESS escreve a linha inteira no INSERT e nada depois; o
// CRON escreve attempts/updated_ms/next_due_ms (o carimbo) e apaga `sent`
// velho; o CONSUMIDOR escreve só desfecho (state/slack_message_ts no
// sucesso, last_error no fracasso). created_ms NUNCA aparece num SET.

export type AlertRow = {
  deliveryId: string;
  payloadJson: string;
  state: "pending" | "sent";
  attempts: number;
  nextDueMs: number;
  slackMessageTs: string | null;
  lastError: string | null;
  createdMs: number;
  updatedMs: number;
};

type RawRow = {
  delivery_id: string;
  payload_json: string;
  state: "pending" | "sent";
  attempts: number;
  next_due_ms: number;
  slack_message_ts: string | null;
  last_error: string | null;
  created_ms: number;
  updated_ms: number;
};

function toAlertRow(r: RawRow): AlertRow {
  return {
    deliveryId: r.delivery_id,
    payloadJson: r.payload_json,
    state: r.state,
    attempts: r.attempts,
    nextDueMs: r.next_due_ms,
    slackMessageTs: r.slack_message_ts,
    lastError: r.last_error,
    createdMs: r.created_ms,
    updatedMs: r.updated_ms,
  };
}

export class AlertStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async insert(
    deliveryId: string,
    payloadJson: string,
    now: number,
  ): Promise<boolean> {
    const r = await this.#db
      .prepare(
        `INSERT INTO alert_delivery
           (delivery_id, payload_json, state, created_ms, updated_ms)
         VALUES (?, ?, 'pending', ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(deliveryId, payloadJson, now, now)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async get(deliveryId: string): Promise<AlertRow | null> {
    const row = await this.#db
      .prepare("SELECT * FROM alert_delivery WHERE delivery_id = ?")
      .bind(deliveryId)
      .first<RawRow>();
    return row ? toAlertRow(row) : null;
  }

  async dueRows(now: number, limit: number): Promise<AlertRow[]> {
    const r = await this.#db
      .prepare(
        `SELECT * FROM alert_delivery
          WHERE state = 'pending' AND next_due_ms <= ?
          ORDER BY next_due_ms ASC
          LIMIT ?`,
      )
      .bind(now, limit)
      .all<RawRow>();
    return r.results.map(toAlertRow);
  }

  // O carimbo (ADR-002 §4): a linha deixa de ser devida NO enfileiramento.
  async stampDue(
    deliveryId: string,
    now: number,
    nextDueMs: number,
  ): Promise<boolean> {
    const r = await this.#db
      .prepare(
        `UPDATE alert_delivery
            SET attempts = attempts + 1, updated_ms = ?, next_due_ms = ?
          WHERE delivery_id = ? AND state = 'pending' AND next_due_ms <= ?`,
      )
      .bind(now, nextDueMs, deliveryId, now)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async markSent(
    deliveryId: string,
    ts: string | null,
    _now: number,
  ): Promise<void> {
    // A matriz: o consumidor não escreve colunas de agendamento.
    await this.#db
      .prepare(
        `UPDATE alert_delivery
            SET state = 'sent', slack_message_ts = ?, last_error = NULL
          WHERE delivery_id = ? AND state = 'pending'`,
      )
      .bind(ts, deliveryId)
      .run();
  }

  async recordFailure(deliveryId: string, error: string): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE alert_delivery SET last_error = ?
          WHERE delivery_id = ? AND state = 'pending'`,
      )
      .bind(error, deliveryId)
      .run();
  }

  async counts(): Promise<{ pending: number; sent: number }> {
    const row = await this.#db
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent
         FROM alert_delivery`,
      )
      .first<{ pending: number | null; sent: number | null }>();
    return { pending: row?.pending ?? 0, sent: row?.sent ?? 0 };
  }

  async oldestPendingCreatedMs(): Promise<number | null> {
    const row = await this.#db
      .prepare(
        "SELECT MIN(created_ms) AS m FROM alert_delivery WHERE state = 'pending'",
      )
      .first<{ m: number | null }>();
    return row?.m ?? null;
  }

  async deleteSentOlderThan(cutoffMs: number): Promise<number> {
    const r = await this.#db
      .prepare(
        "DELETE FROM alert_delivery WHERE state = 'sent' AND created_ms < ?",
      )
      .bind(cutoffMs)
      .run();
    return r.meta.changes ?? 0;
  }
}
