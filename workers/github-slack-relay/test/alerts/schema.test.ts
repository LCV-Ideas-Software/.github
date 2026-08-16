import { afterEach, describe, expect, it } from "vitest";

import { closeAlertDatabases, makeAlertDb } from "./helpers";

afterEach(closeAlertDatabases);

// ADR-002 §4: três estados, um canal, sem destino. Cada teste aqui prende
// uma propriedade que o desenho declara; um esquema que passe nos três é um
// esquema que não deixa a promessa "nunca perder" cair por construção.
describe("migração 0010: alert_delivery", () => {
  it("aceita os três estados do desenho e recusa qualquer outro", () => {
    const { database } = makeAlertDb();
    for (const state of ["pending", "sent", "failed"]) {
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
    // 'queued' é um dos dez estados do sistema abandonado. Escrever nele
    // faria o banco recusar em produção e o alerta se perder.
    expect(() =>
      database
        .prepare(
          `INSERT INTO alert_delivery
             (delivery_id, payload_json, state, created_ms, updated_ms)
           VALUES ('id-bad', '{}', 'queued', 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
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

  it("attempts e parked têm domínio fechado", () => {
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
    expect(() =>
      database
        .prepare(
          `INSERT INTO alert_delivery
             (delivery_id, payload_json, state, parked, created_ms, updated_ms)
           VALUES ('id-parked', '{}', 'pending', 2, 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
