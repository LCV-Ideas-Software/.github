import { readFileSync } from "node:fs";
import { URL as NodeUrl } from "node:url";

import { describe, expect, it } from "vitest";

import { WATCHDOG_MAX_PENDING_AGE_MS } from "../../src/alerts/contract";

// ADR-002 §5, decisão 8 (emendada): a fila de descarte dos alertas é um
// SEGUNDO mecanismo de entrega, e sai. E o max_retries do consumidor vai ao
// mínimo: com o consumidor que sempre confirma, retentativa de plataforma
// só existe no crash — e o crash pertence ao cron, não à fila.
// A DLQ de ATIVIDADE fica: é legado declarado, com filas pausadas.
function wranglerConfig(): {
  queues: {
    consumers: Array<{
      queue: string;
      dead_letter_queue?: string;
      max_retries: number;
    }>;
  };
} {
  const raw = readFileSync(
    new NodeUrl("../../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  // JSONC: remove comentários de linha e vírgulas finais (o arquivo não
  // usa comentários de bloco nem strings contendo "//" ou ",}").
  const semComentarios = raw
    .split("\n")
    .filter((linha) => !linha.trim().startsWith("//"))
    .join("\n")
    .replace(/,(\s*[}\]])/gu, "$1");
  return JSON.parse(semComentarios) as ReturnType<typeof wranglerConfig>;
}

describe("configuração das filas (ADR-002 §5, decisão 8)", () => {
  it("o consumidor de alertas não tem fila de descarte e retenta o mínimo", () => {
    const consumers = wranglerConfig().queues.consumers;
    const alerts = consumers.find((c) => c.queue === "github-slack-alerts");
    expect(alerts).toBeDefined();
    expect(alerts?.dead_letter_queue).toBeUndefined();
    expect(alerts?.max_retries).toBe(0);
  });

  it("a DLQ de alertas não é mais consumida por ninguém", () => {
    const consumers = wranglerConfig().queues.consumers;
    expect(
      consumers.some((c) => c.queue === "github-slack-alerts-dlq"),
    ).toBe(false);
  });
});

describe("sincronia com o vigia (ADR-002 §4)", () => {
  it("o limiar do vigia no workflow é o MESMO do contrato — a sincronia declarada vira presa", () => {
    // Achado da revisão: 3_600_000 estava duplicado no yml sem nada que
    // ligasse os dois valores — uma mudança de política num lado
    // dessincronizaria Worker e vigia em silêncio.
    const yml = readFileSync(
      new NodeUrl(
        "../../../../.github/workflows/alerts-watchdog.yml",
        import.meta.url,
      ),
      "utf8",
    );
    const declarados = [...yml.matchAll(/MAX_PENDING_AGE_MS: "(\d+)"/gu)];
    expect(declarados).toHaveLength(1);
    expect(Number(declarados[0]?.[1])).toBe(WATCHDOG_MAX_PENDING_AGE_MS);
  });
});
