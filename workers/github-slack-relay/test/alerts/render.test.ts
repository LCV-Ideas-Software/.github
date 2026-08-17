import { describe, expect, it } from "vitest";

import { normalizeGitHubEvent } from "../../src/domain";
import { renderAlertText } from "../../src/alerts/render";

// A montagem é NO ENVIO (ADR-002 §4): corrigir o renderizador e implantar
// conserta a próxima tentativa da MESMA linha. O formato é o observado no
// canal em 16/08 (mensagens do relay legado, que o Slack Workflow formatava
// e agora é responsabilidade nossa).
describe("renderAlertText", () => {
  it("monta título, campos, link e a linha de delivery — com as chaves do CONTRATO (details/url)", () => {
    // A revisão pegou a versão anterior lendo body/html_url, chaves que o
    // payload normalizado NÃO tem (SlackWorkflowPayload define details e
    // url) — corpo e link seriam omitidos em silêncio, e a fixture errada
    // deixava o teste passar.
    const texto = renderAlertText({
      severity: "high",
      title: "OpenSSF Scorecard: failure",
      repository: "LCV-Ideas-Software/astrologo-app",
      source: "GitHub Actions",
      branch: "main",
      actor: "github-merge-queue[bot]",
      details: "Workflow OpenSSF Scorecard completed with conclusion failure.",
      url: "https://github.com/LCV-Ideas-Software/astrologo-app/actions/runs/1",
      delivery_id: "fa20c8e0-0000-0000-0000-000000000000",
      occurred_at: "2026-08-16T18:43:01Z",
    });
    expect(texto).toContain("*[high] OpenSSF Scorecard: failure*");
    expect(texto).toContain("Repository: LCV-Ideas-Software/astrologo-app");
    expect(texto).toContain(
      "Workflow OpenSSF Scorecard completed with conclusion failure.",
    );
    expect(texto).toContain(
      "<https://github.com/LCV-Ideas-Software/astrologo-app/actions/runs/1|Open in GitHub>",
    );
    expect(texto).toContain("fa20c8e0-0000-0000-0000-000000000000");
  });

  it("renderiza a SAÍDA REAL do normalizador — o contrato não pode derivar de novo", () => {
    const resultado = normalizeGitHubEvent(
      "workflow_run",
      {
        action: "completed",
        sender: { login: "octocat" },
        workflow_run: {
          conclusion: "failure",
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          html_url: "https://github.com/o/r/actions/runs/7",
          updated_at: "2026-08-16T00:00:00Z",
        },
      },
      "d-contrato",
      "LCV-Ideas-Software/astrologo-app",
    );
    expect(resultado.kind).toBe("accepted");
    if (resultado.kind !== "accepted") return;
    const texto = renderAlertText(
      resultado.payload as unknown as Record<string, unknown>,
    );
    expect(texto).toContain("CI: failure"); // title
    expect(texto).toContain("completed with conclusion failure"); // details
    expect(texto).toContain("|Open in GitHub>"); // url
    expect(texto).toContain("d-contrato"); // delivery_id
  });

  it("occurred_at é apresentado em dd/MM/aaaa às HH:mm:ss UTC−03:00 — o renderizador é a fronteira de apresentação", () => {
    // Contrato de docs/GITHUB_SLACK_INTEGRATION.md: o Slack Workflow que
    // formatava datas saiu do caminho; quem apresenta agora é este
    // renderizador (achado da revisão: o ISO cru vazava ao usuário).
    const texto = renderAlertText({
      title: "T",
      delivery_id: "d-data",
      occurred_at: "2026-08-14T18:43:01Z",
    });
    expect(texto).toContain("14/08/2026 às 15:43:01");
    expect(texto).not.toContain("2026-08-14T18:43:01Z");
  });

  it("occurred_at inválido ou ausente: 'Data e hora do evento: não informadas'", () => {
    for (const payload of [
      { title: "T", delivery_id: "d-1" },
      { title: "T", delivery_id: "d-2", occurred_at: "não-é-data" },
    ]) {
      const texto = renderAlertText(payload);
      expect(texto).toContain("Data e hora do evento: não informadas");
    }
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
