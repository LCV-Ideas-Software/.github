// A matriz de escritas do ADR-002 §4 mora aqui, e é ela que os testes
// prendem. O carimbo (attempts/updated_ms/next_due_ms, via stampDue) é do
// PAPEL de agendador: o CRON o executa a cada passe, e o INGRESS o executa
// UMA vez, no aceite, para a tentativa 1 — "publica só quem carimba" vale
// inclusive para ele (a redação anterior, "INSERT e nada depois", ficou
// falsa com essa emenda e a revisão pegou). O CONSUMIDOR escreve só
// desfecho (state/slack_message_ts no sucesso, last_error no fracasso).
// created_ms NUNCA aparece num SET depois do INSERT.

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
  // O CAS pina a VERSÃO observada (attempts) além do prazo — achado da
  // rodada 15 da revisão: dois passes que leram o MESMO retrato podiam
  // ambos carimbar quando o relógio do segundo alcançava o recuo do
  // primeiro (o predicado de prazo passa por igualdade), publicando duas
  // vezes e agendando a tentativa seguinte com o recuo do attempts velho.
  // Quem leu retrato morto não carimba; a leitura fresca do passe seguinte
  // agenda com a curva certa.
  async stampDue(
    deliveryId: string,
    now: number,
    nextDueMs: number,
    observedAttempts: number,
  ): Promise<boolean> {
    const r = await this.#db
      .prepare(
        `UPDATE alert_delivery
            SET attempts = attempts + 1, updated_ms = ?, next_due_ms = ?
          WHERE delivery_id = ? AND state = 'pending' AND next_due_ms <= ?
            AND attempts = ?`,
      )
      .bind(now, nextDueMs, deliveryId, now, observedAttempts)
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

  // Sonda de prontidão em trabalho CONSTANTE (achado da revisão: o
  // /healthz é público, e um agregado de tabela inteira por probe não
  // autenticado vira amplificação de carga no D1 — o conjunto pendente é
  // ilimitado por desenho). LIMIT 1 prova esquema e leitura sem varrer; o
  // retrato agregado fica reservado ao /alerts/status, atrás do segredo.
  async schemaProbe(): Promise<void> {
    await this.#db
      .prepare("SELECT delivery_id FROM alert_delivery LIMIT 1")
      .first();
  }

  // Um retrato ÚNICO para o /status: contagens e idade na MESMA instrução.
  // (A versão anterior fazia duas consultas, e o consumidor marcando `sent`
  // entre elas produzia idade velha com pending 0, ou pendente sem idade —
  // e o vigia decide pela idade. Achado da revisão.)
  async statusSnapshot(): Promise<{
    pending: number;
    sent: number;
    oldestPendingCreatedMs: number | null;
  }> {
    const row = await this.#db
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent,
           MIN(CASE WHEN state = 'pending' THEN created_ms END) AS oldest
         FROM alert_delivery`,
      )
      .first<{
        pending: number | null;
        sent: number | null;
        oldest: number | null;
      }>();
    return {
      pending: row?.pending ?? 0,
      sent: row?.sent ?? 0,
      oldestPendingCreatedMs: row?.oldest ?? null,
    };
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
