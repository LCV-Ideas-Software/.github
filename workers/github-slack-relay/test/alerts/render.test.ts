import { describe, expect, it } from "vitest";

import { renderAlertText } from "../../src/alerts/render";

// A montagem é NO ENVIO (ADR-002 §4): corrigir o renderizador e implantar
// conserta a próxima tentativa da MESMA linha. O formato é o observado no
// canal em 16/08 (mensagens do relay legado, que o Slack Workflow formatava
// e agora é responsabilidade nossa).
describe("renderAlertText", () => {
  it("monta título, campos, link e a linha de delivery", () => {
    const texto = renderAlertText({
      severity: "high",
      title: "OpenSSF Scorecard: failure",
      repository: "LCV-Ideas-Software/astrologo-app",
      source: "GitHub Actions / workflow_run:completed",
      branch: "main",
      actor: "github-merge-queue[bot]",
      body: "Workflow OpenSSF Scorecard completed with conclusion failure.",
      html_url:
        "https://github.com/LCV-Ideas-Software/astrologo-app/actions/runs/1",
      delivery_id: "fa20c8e0-0000-0000-0000-000000000000",
      occurred_at: "2026-08-16T18:43:01Z",
    });
    expect(texto).toContain("*[high] OpenSSF Scorecard: failure*");
    expect(texto).toContain("Repository: LCV-Ideas-Software/astrologo-app");
    expect(texto).toContain(
      "<https://github.com/LCV-Ideas-Software/astrologo-app/actions/runs/1|Open in GitHub>",
    );
    expect(texto).toContain("fa20c8e0-0000-0000-0000-000000000000");
  });

  it("campo ausente não derruba: linha é omitida, nunca 'undefined' no texto", () => {
    const texto = renderAlertText({ title: "X", delivery_id: "d-1" });
    expect(texto).not.toContain("undefined");
    expect(texto).toContain("*X*");
  });

  it("payload vazio ainda produz um título — nada lança", () => {
    const texto = renderAlertText({});
    expect(texto).toContain("*GitHub alert*");
  });
});
