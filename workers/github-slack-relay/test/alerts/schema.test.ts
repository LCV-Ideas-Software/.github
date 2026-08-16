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

  it("attempts tem domínio fechado", () => {
    const { database } = makeAlertDb();
    expect(() =>
      database
        .prepare(
          `INSERT INTO alert_delivery
             (delivery_id, payload_json, state, attempts, created_ms, updated_ms)
           VALUES ('id-neg', '{}', 'pending', -1, 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
