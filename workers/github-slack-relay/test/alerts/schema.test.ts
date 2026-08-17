import { afterEach, describe, expect, it } from "vitest";

import { closeAlertDatabases, makeAlertDb } from "./helpers";

afterEach(closeAlertDatabases);

// ADR-002 §4 (emendado em 16/08): DOIS estados, um canal, sem destino.
// Cada teste aqui prende uma propriedade que o desenho declara; um esquema
// que passe em todos é um esquema que não deixa a promessa "nunca perder"
// cair por construção.
describe("migração 0010: alert_delivery", () => {
  it("aceita os dois estados do desenho e recusa qualquer outro", () => {
    const { database } = makeAlertDb();
    for (const state of ["pending", "sent"]) {
      expect(() =>
        database
          .prepare(
            `INSERT INTO alert_delivery
               (delivery_id, payload_json, state, created_ms, updated_ms)
             VALUES (?, '{}', ?, 1, 1)`,
          )
          .run(`id-${state}`, state),
      ).not.toThrow();
    }
    // 'queued' é um dos dez estados do sistema abandonado.
    // 'failed' é o estado que a decisão 12 apagou: nada é terminal, e uma
    // linha recusada continua `pending` até entrar. Se o banco o aceitasse,
    // um caminho poderia tornar a linha terminal sem que nenhum teste visse.
    for (const state of ["queued", "failed"]) {
      expect(() =>
        database
          .prepare(
            `INSERT INTO alert_delivery
               (delivery_id, payload_json, state, created_ms, updated_ms)
             VALUES (?, '{}', ?, 1, 1)`,
          )
          .run(`id-bad-${state}`, state),
      ).toThrow(/CHECK constraint failed/);
    }
  });

  it("a coluna de estacionamento não existe", () => {
    // ADR-002 §6, C′: o estacionamento foi apagado, não reformado. Enquanto
    // a coluna existir, alguém a escreve — e volta o alarme que nada limpa.
    const { database } = makeAlertDb();
    expect(() =>
      database
        .prepare(
          `INSERT INTO alert_delivery
             (delivery_id, payload_json, state, parked, created_ms, updated_ms)
           VALUES ('id-parked', '{}', 'pending', 1, 1, 1)`,
        )
        .run(),
    ).toThrow(/has no column named parked/i);
  });

  it("recusa payload que não seja JSON", () => {
    const { database } = makeAlertDb();
    expect(() =>
      database
        .prepare(
          `INSERT INTO alert_delivery
             (delivery_id, payload_json, state, created_ms, updated_ms)
           VALUES ('id-json', ?, 'pending', 1, 1)`,
        )
        .run("não é json"),
    ).toThrow(/CHECK constraint failed/);
  });

  it("o GUID é chave primária: a redelivery do GitHub não vira segunda linha", () => {
    // ADR-002 §5, decisão 10: a linha guardada É a trava de deduplicação.
    const { database } = makeAlertDb();
    const insert = (): unknown =>
      database
        .prepare(
          `INSERT INTO alert_delivery
             (delivery_id, payload_json, state, created_ms, updated_ms)
           VALUES ('guid', '{}', 'pending', 1, 1)`,
        )
        .run();
    insert();
    expect(insert).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it("recusa delivery_id fora do formato do GUID do GitHub", () => {
    const { database } = makeAlertDb();
    for (const bad of ["", "com espaço", "com/barra", "a".repeat(129)]) {
      expect(() =>
        database
          .prepare(
            `INSERT INTO alert_delivery
               (delivery_id, payload_json, state, created_ms, updated_ms)
             VALUES (?, '{}', 'pending', 1, 1)`,
          )
          .run(bad),
      ).toThrow(/CHECK constraint failed/);
    }
  });

  it("next_due_ms existe, nasce devida (0) e tem domínio fechado", () => {
    // ADR-002 §4: o tempo devido é PRÉ-COMPUTADO no carimbo, porque a
    // alternativa — avaliar updated_ms + recuo(attempts) na consulta — não
    // é indexável: updated_ms carrega o agora do último carimbo, então
    // `updated_ms <= agora` casa com praticamente toda linha pendente
    // (achado da revisão). DEFAULT 0 = recuo(0): linha nova é devida já.
    const { database } = makeAlertDb();
    database
      .prepare(
        `INSERT INTO alert_delivery
           (delivery_id, payload_json, state, created_ms, updated_ms)
         VALUES ('id-due-default', '{}', 'pending', 1, 1)`,
      )
      .run();
    const row = database
      .prepare(
        "SELECT next_due_ms, typeof(next_due_ms) AS t FROM alert_delivery WHERE delivery_id = 'id-due-default'",
      )
      .get() as { next_due_ms: number; t: string };
    expect(row).toEqual({ next_due_ms: 0, t: "integer" });

    for (const bad of [-1, 0.5, "x"]) {
      expect(() =>
        database
          .prepare(
            `INSERT INTO alert_delivery
               (delivery_id, payload_json, state, next_due_ms, created_ms, updated_ms)
             VALUES ('id-due-bad', '{}', 'pending', ?, 1, 1)`,
          )
          .run(bad as never),
      ).toThrow(/CHECK constraint failed/);
    }
  });

  it("o índice de tempo devido cobre (state, next_due_ms)", () => {
    // Sem ele, cada passe do cron varre o conjunto pendente inteiro — e o
    // conjunto pendente é ilimitado por desenho (decisão 12).
    const { database } = makeAlertDb();
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT delivery_id FROM alert_delivery
          WHERE state = 'pending' AND next_due_ms <= 99
          ORDER BY next_due_ms ASC`,
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" | ")).toMatch(
      /idx_alert_delivery_due/,
    );
  });

  it("created_ms e updated_ms têm o mesmo domínio fechado — a classe inteira, não a instância", () => {
    // Mesma afinidade-não-é-tipo do attempts, e o dano é maior: o vigia
    // computa idade de created_ms e o carimbo do cron soma sobre updated_ms.
    // Um valor malformado numa delas corrompe detecção E agendamento.
    const { database } = makeAlertDb();
    const casos: ReadonlyArray<readonly [string, string, unknown, unknown]> = [
      ["id-cm-txt", "created_ms texto", "x", 1],
      ["id-cm-frac", "created_ms fração", 0.5, 1],
      ["id-um-txt", "updated_ms texto", 1, "x"],
      ["id-um-frac", "updated_ms fração", 1, 0.5],
    ];
    for (const [id, , createdMs, updatedMs] of casos) {
      expect(() =>
        database
          .prepare(
            `INSERT INTO alert_delivery
               (delivery_id, payload_json, state, created_ms, updated_ms)
             VALUES (?, '{}', 'pending', ?, ?)`,
          )
          .run(id, createdMs as never, updatedMs as never),
      ).toThrow(/CHECK constraint failed/);
    }
  });

  it("attempts tem domínio fechado: nem negativo, nem fracionário, nem texto", () => {
    // `INTEGER` no SQLite é AFINIDADE, não tipo: sem typeof(), o CHECK
    // `attempts >= 0` aceita 0.5 e aceita texto numérico. E agora attempts
    // não é mais só diagnóstico — ele entra no cálculo do recuo que decide
    // quando o cron reagenda (ADR-002 §4), então valor malformado adia ou
    // adianta a próxima tentativa em vez de apenas sujar um relatório.
    const { database } = makeAlertDb();
    // Os ids são fixos e válidos DE PROPÓSITO. A versão anterior deste teste
    // montava o id a partir do valor (`id-att-0.5`), e o ponto é proibido
    // pelo CHECK do delivery_id — então o caso 0.5 passava por rejeição da
    // coluna ERRADA, e teria passado igual se attempts aceitasse fração.
    // Achado do Copilot; um teste que passa pelo motivo errado é pior que
    // teste ausente, porque compra confiança sem entregar restrição.
    const casos: ReadonlyArray<readonly [string, unknown]> = [
      ["id-att-neg", -1],
      ["id-att-frac", 0.5],
      ["id-att-txt-x", "x"],
    ];
    for (const [id, bad] of casos) {
      expect(() =>
        database
          .prepare(
            `INSERT INTO alert_delivery
               (delivery_id, payload_json, state, attempts, created_ms, updated_ms)
             VALUES (?, '{}', 'pending', ?, 1, 1)`,
          )
          .run(id, bad as never),
      ).toThrow(/CHECK constraint failed/);
    }
    expect(() =>
      database
        .prepare(
          `INSERT INTO alert_delivery
             (delivery_id, payload_json, state, attempts, created_ms, updated_ms)
           VALUES ('id-att-ok', '{}', 'pending', 7, 1, 1)`,
        )
        .run(),
    ).not.toThrow();

    // O texto numérico "3" É aceito, e isso não é furo: a afinidade INTEGER
    // converte sem perda ANTES do CHECK, então o que fica guardado é o
    // inteiro 3. Verificado, não suposto — foi assim que este teste me
    // corrigiu quando eu o escrevi esperando rejeição.
    database
      .prepare(
        `INSERT INTO alert_delivery
           (delivery_id, payload_json, state, attempts, created_ms, updated_ms)
         VALUES ('id-att-txt', '{}', 'pending', '3', 1, 1)`,
      )
      .run();
    const row = database
      .prepare(
        "SELECT attempts, typeof(attempts) AS t FROM alert_delivery WHERE delivery_id = 'id-att-txt'",
      )
      .get() as { attempts: number; t: string };
    expect(row).toEqual({ attempts: 3, t: "integer" });
  });
});
