import { describe, expect, it } from "vitest";

// O .mjs não tem declaração de tipos; o contrato que importa aqui é a
// LISTA, comparada por valor logo abaixo.
// @ts-expect-error módulo ESM sem declaração de tipos
import { HOOK_EVENTS } from "../../../../scripts/github-slack-hook-audit.mjs";
import {
  SUPPORTED_RELAY_EVENTS,
  isExcludedWorkflowRun,
  normalizeGitHubEvent,
} from "../../src/domain";

// ADR-002 §3 (emendado 16/08): OITO eventos — security_advisory saiu por
// impossibilidade de plataforma ("Availability: app"). Um evento atravessa
// TRÊS portões até o canal; este teste cobre os dois locais (allowlist e
// normalizador) e prende a lista do auditor, que verifica o primeiro.
const OITO = [
  "dependabot_alert",
  "code_scanning_alert",
  "secret_scanning_alert",
  "repository_advisory",
  "security_and_analysis",
  "secret_scanning_alert_location",
  "secret_scanning_scan",
  "workflow_run",
] as const;

function fixturePara(evento: string): Record<string, unknown> {
  const base = { sender: { login: "octocat" } };
  switch (evento) {
    case "workflow_run":
      return {
        ...base,
        action: "completed",
        workflow_run: {
          conclusion: "failure",
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          html_url: "https://github.com/o/r/actions/runs/1",
          updated_at: "2026-08-16T00:00:00Z",
        },
      };
    case "dependabot_alert":
      return {
        ...base,
        action: "created",
        alert: {
          security_advisory: { severity: "high", summary: "S" },
          html_url: "https://github.com/o/r/security/dependabot/1",
        },
      };
    case "code_scanning_alert":
      return {
        ...base,
        action: "created",
        alert: {
          rule: { description: "R" },
          html_url: "https://github.com/o/r/security/code-scanning/1",
        },
      };
    case "secret_scanning_alert":
      return {
        ...base,
        action: "created",
        alert: {
          secret_type_display_name: "Token",
          html_url: "https://github.com/o/r/security/secret-scanning/1",
        },
      };
    case "repository_advisory":
      return {
        ...base,
        action: "published",
        repository_advisory: {
          summary: "Advisory X",
          severity: "high",
          html_url: "https://github.com/o/r/security/advisories/GHSA-1",
          published_at: "2026-08-16T00:00:00Z",
        },
      };
    case "security_and_analysis":
      return {
        ...base,
        changes: { from: { security_and_analysis: {} } },
      };
    case "secret_scanning_alert_location":
      return {
        ...base,
        action: "created",
        alert: {
          html_url: "https://github.com/o/r/security/secret-scanning/2",
        },
        location: { type: "commit" },
      };
    case "secret_scanning_scan":
      return {
        ...base,
        action: "completed",
        type: "backfill",
      };
    default:
      return base;
  }
}

describe("escopo — os portões locais (ADR-002 §3, §12)", () => {
  it("allowlist aceita exatamente os oito", () => {
    expect([...SUPPORTED_RELAY_EVENTS].sort()).toEqual([...OITO].sort());
  });

  it("HOOK_EVENTS do auditor tem os mesmos oito", () => {
    expect([...HOOK_EVENTS].sort()).toEqual([...OITO].sort());
  });

  it.each(OITO)("normalizador produz linha de alerta para %s", (evento) => {
    const resultado = normalizeGitHubEvent(
      evento,
      fixturePara(evento),
      "d-1",
      "LCV-Ideas-Software/astrologo-app",
    );
    expect(resultado.kind).toBe("accepted");
    if (resultado.kind === "accepted") {
      expect(resultado.destination).toBe("alerts");
    }
  });

  it("workflow_run só entra com conclusão de problema", () => {
    const ok = fixturePara("workflow_run");
    (ok as { workflow_run: { conclusion: string } }).workflow_run.conclusion =
      "success";
    expect(
      normalizeGitHubEvent("workflow_run", ok, "d-2", "o/r").kind,
    ).toBe("ignored");
  });

  it("exclusão exige repositório E caminho — caminho igual em OUTRO repo entra", () => {
    expect(
      isExcludedWorkflowRun(
        "LCV-Ideas-Software/.github",
        ".github/workflows/alerts-watchdog.yml",
      ),
    ).toBe(true);
    expect(
      isExcludedWorkflowRun(
        "LCV-Ideas-Software/astrologo-app",
        ".github/workflows/alerts-watchdog.yml",
      ),
    ).toBe(false);
  });

  it("sanitização é aplicada UMA vez — 'R&D' não vira 'R&amp;amp;D' (a classe, nos três normalizadores novos)", () => {
    const advisory = normalizeGitHubEvent(
      "repository_advisory",
      {
        sender: { login: "octocat" },
        action: "published",
        repository_advisory: { summary: "R&D <lab>", severity: "high" },
      },
      "d-san-1",
      "LCV-Ideas-Software/astrologo-app",
    );
    expect(advisory.kind).toBe("accepted");
    if (advisory.kind === "accepted") {
      expect(advisory.payload.title).not.toContain("&amp;amp;");
      expect(advisory.payload.details).not.toContain("&amp;amp;");
    }

    const location = normalizeGitHubEvent(
      "secret_scanning_alert_location",
      {
        sender: { login: "octocat" },
        action: "created",
        alert: {},
        location: { type: "a&b" },
      },
      "d-san-2",
      "LCV-Ideas-Software/astrologo-app",
    );
    expect(location.kind).toBe("accepted");
    if (location.kind === "accepted") {
      expect(location.payload.title).not.toContain("&amp;amp;");
    }

    const scan = normalizeGitHubEvent(
      "secret_scanning_scan",
      {
        sender: { login: "octocat" },
        action: "completed",
        type: "x&y",
      },
      "d-san-3",
      "LCV-Ideas-Software/astrologo-app",
    );
    expect(scan.kind).toBe("accepted");
    if (scan.kind === "accepted") {
      expect(scan.payload.title).not.toContain("&amp;amp;");
    }
  });

  it("a falha do PRÓPRIO vigia não vira linha (instância A do §6)", () => {
    const payload = fixturePara("workflow_run");
    (payload as { workflow_run: { path: string } }).workflow_run.path =
      ".github/workflows/alerts-watchdog.yml";
    expect(
      normalizeGitHubEvent(
        "workflow_run",
        payload,
        "d-3",
        "LCV-Ideas-Software/.github",
      ).kind,
    ).toBe("ignored");
  });
});
