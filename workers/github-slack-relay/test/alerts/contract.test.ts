import { describe, expect, it } from "vitest";

import { recuoMs } from "../../src/alerts/contract";

// ADR-002 §4: recuo(n) = min(24h, 5min × 3^(n-1)), recuo(0) = 0.
// A tabela do ADR é o oráculo; o teste transcreve cada linha dela.
describe("curva de recuo (ADR-002 §4)", () => {
  it.each([
    [0, 0],
    [1, 5 * 60_000],
    [2, 15 * 60_000],
    [3, 45 * 60_000],
    [4, 135 * 60_000],
    [5, 405 * 60_000],
    [6, 1215 * 60_000],
    [7, 24 * 3_600_000],
    [8, 24 * 3_600_000],
    [100, 24 * 3_600_000],
  ])("recuo(%i) = %i ms", (attempts, esperado) => {
    expect(recuoMs(attempts)).toBe(esperado);
  });

  it("é monotônica até saturar — nunca encurta a espera", () => {
    for (let n = 0; n < 12; n++) {
      expect(recuoMs(n + 1)).toBeGreaterThanOrEqual(recuoMs(n));
    }
  });
});
