import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizeGitHubEvent, sanitizeText } from "../src/domain";
import { canonicalSlackRelayPayload } from "../src/security";

const DELIVERY_ID = "00000000-0000-4000-8000-000000000020";
const REPOSITORY = "LCV-Ideas-Software/cross-review";
const RELAY_SIGNED_FIELD_ORDER = [
  "source",
  "severity",
  "repository",
  "title",
  "details",
  "actor",
  "branch",
  "url",
  "occurred_at",
  "delivery_id",
  "event",
  "action",
  "destination",
  "relay_attempt",
  "relay_timestamp",
] as const;
const EXPECTED_KEYS = [
  "action",
  "actor",
  "branch",
  "delivery_id",
  "destination",
  "details",
  "event",
  "occurred_at",
  "relay_attempt",
  "relay_signature",
  "relay_timestamp",
  "repository",
  "severity",
  "source",
  "title",
  "url",
];

function dependabotPayload(action: string): Record<string, unknown> {
  return {
    action,
    alert: {
      created_at: "2026-08-03T10:00:00Z",
      dependency: { package: { name: "example-package" } },
      html_url:
        "https://github.com/LCV-Ideas-Software/cross-review/security/dependabot/1",
      security_advisory: { severity: "critical", summary: "Example advisory" },
      updated_at: "2026-08-03T12:00:00Z",
    },
    sender: { login: "dependabot[bot]" },
  };
}

function codeScanningPayload(action: string): Record<string, unknown> {
  return {
    action,
    alert: {
      created_at: "2026-08-03T10:00:00Z",
      html_url:
        "https://github.com/LCV-Ideas-Software/cross-review/security/code-scanning/1",
      most_recent_instance: {
        location: { path: "src/private-location.ts", start_line: 42 },
      },
      rule: {
        description: "Unsafe operation",
        id: "rule-id",
        name: "Example rule",
        security_severity_level: "high",
      },
      updated_at: "2026-08-03T12:00:00Z",
    },
    ref: "refs/heads/main",
    sender: { login: "github" },
  };
}

describe("event normalization", () => {
  it("keeps the exact documented relay HMAC input aligned with production", () => {
    const payload = Object.fromEntries(
      RELAY_SIGNED_FIELD_ORDER.map((field) => [field, field]),
    );
    const canonicalValues = JSON.parse(
      canonicalSlackRelayPayload(payload as never),
    );
    expect(canonicalValues).toEqual([...RELAY_SIGNED_FIELD_ORDER]);

    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("- the current durable D1 `relay_attempt`;");
    expect(readme).toContain(
      `JSON.stringify([${RELAY_SIGNED_FIELD_ORDER.join(",")}])`,
    );
  });

  it("documents stale sending recovery as manual review without resend", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain(
      "- recovers due `pending`, `enqueueing`, `queued`, and `dead_letter` records;",
    );
    expect(readme).toContain(
      "- moves stale `sending` rows to `manual_review` as ambiguous, without resending;",
    );
  });

  it("always emits the exact flat Workflow Builder contract using only strings", () => {
    const result = normalizeGitHubEvent(
      "dependabot_alert",
      dependabotPayload("created"),
      DELIVERY_ID,
      REPOSITORY,
    );

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;

    expect(Object.keys(result.payload).sort()).toEqual(EXPECTED_KEYS);
    expect(
      Object.values(result.payload).every((value) => typeof value === "string"),
    ).toBe(true);
    expect(result.payload.delivery_id).toBe(DELIVERY_ID);
  });

  it("never relays secret values, raw locations, or resolution comments", () => {
    const rawSecret = "ghp_SUPER_SECRET_VALUE";
    const rawLocation = "src/private/credentials.txt:17";
    const resolutionComment = "Token rotated to another-private-value";
    const result = normalizeGitHubEvent(
      "secret_scanning_alert",
      {
        action: "created",
        alert: {
          created_at: "2026-08-03T12:00:00Z",
          html_url:
            "https://github.com/LCV-Ideas-Software/cross-review/security/secret-scanning/1",
          locations: [{ details: { path: rawLocation } }],
          resolution_comment: resolutionComment,
          secret: rawSecret,
          secret_type: "github_personal_access_token",
          secret_type_display_name: "GitHub personal access token",
        },
        sender: { login: "github" },
      },
      DELIVERY_ID,
      REPOSITORY,
    );

    expect(result.kind).toBe("accepted");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawLocation);
    expect(serialized).not.toContain(resolutionComment);
    expect(serialized).not.toContain('"locations":');
  });

  it("omits code-scanning locations but includes the documented ref", () => {
    const result = normalizeGitHubEvent(
      "code_scanning_alert",
      codeScanningPayload("reopened_by_user"),
      DELIVERY_ID,
      REPOSITORY,
    );

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.payload.branch).toBe("refs/heads/main");
    expect(JSON.stringify(result.payload)).not.toContain("private-location.ts");
    expect(result.payload.severity).toBe("high");
  });

  it.each([
    ["dependabot_alert", dependabotPayload("fixed"), "info"],
    ["dependabot_alert", dependabotPayload("dismissed"), "info"],
    ["dependabot_alert", dependabotPayload("auto_dismissed"), "info"],
    ["dependabot_alert", dependabotPayload("auto_reopened"), "critical"],
    ["code_scanning_alert", codeScanningPayload("fixed"), "info"],
    ["code_scanning_alert", codeScanningPayload("closed_by_user"), "info"],
    ["code_scanning_alert", codeScanningPayload("reopened"), "high"],
    ["code_scanning_alert", codeScanningPayload("reopened_by_user"), "high"],
  ])(
    "maps the %s lifecycle action to severity %s",
    (event, payload, expectedSeverity) => {
      const result = normalizeGitHubEvent(
        event,
        payload,
        DELIVERY_ID,
        REPOSITORY,
      );
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") return;
      expect(result.payload.severity).toBe(expectedSeverity);
    },
  );

  it("maps a resolved secret-scanning alert to info", () => {
    const result = normalizeGitHubEvent(
      "secret_scanning_alert",
      {
        action: "resolved",
        alert: {
          html_url:
            "https://github.com/LCV-Ideas-Software/cross-review/security/secret-scanning/1",
          secret_type: "custom_pattern",
          updated_at: "2026-08-03T12:00:00Z",
        },
      },
      DELIVERY_ID,
      REPOSITORY,
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.payload.severity).toBe("info");
  });

  it("rejects non-problematic workflow and in-progress deployment states", () => {
    const workflow = normalizeGitHubEvent(
      "workflow_run",
      { action: "completed", workflow_run: { conclusion: "success" } },
      DELIVERY_ID,
      REPOSITORY,
    );

    expect(workflow.kind).toBe("ignored");
    for (const state of ["pending", "queued", "in_progress"]) {
      const deployment = normalizeGitHubEvent(
        "deployment_status",
        { action: "created", deployment_status: { state } },
        DELIVERY_ID,
        REPOSITORY,
      );
      expect(deployment.kind).toBe("ignored");
    }
  });

  it.each(["error", "failure"])(
    "routes a %s deployment to alerts without relaying its description",
    (state) => {
      const sentinel = "PRIVATE_DEPLOYMENT_DESCRIPTION";
      const result = normalizeGitHubEvent(
        "deployment_status",
        {
          action: "created",
          deployment: { environment: "production", ref: "main" },
          deployment_status: {
            created_at: "2026-08-03T12:00:00Z",
            description: sentinel,
            repository_url:
              "https://github.com/LCV-Ideas-Software/cross-review",
            state,
          },
        },
        DELIVERY_ID,
        REPOSITORY,
      );

      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") return;
      expect(result.destination).toBe("alerts");
      expect(result.payload.destination).toBe("alerts");
      expect(result.payload.severity).toBe("high");
      expect(JSON.stringify(result)).not.toContain(sentinel);
    },
  );

  it.each(["success", "inactive"])(
    "routes a %s deployment to activity without relaying its description",
    (state) => {
      const sentinel = "PRIVATE_DEPLOYMENT_DESCRIPTION";
      const result = normalizeGitHubEvent(
        "deployment_status",
        {
          action: "created",
          deployment: { environment: "production", ref: "main" },
          deployment_status: {
            created_at: "2026-08-03T12:00:00Z",
            description: sentinel,
            repository_url:
              "https://github.com/LCV-Ideas-Software/cross-review",
            state,
          },
        },
        DELIVERY_ID,
        REPOSITORY,
      );

      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") return;
      expect(result.destination).toBe("activity");
      expect(result.payload.destination).toBe("activity");
      expect(result.payload.severity).toBe("info");
      expect(JSON.stringify(result)).not.toContain(sentinel);
    },
  );

  it("ignores an unknown deployment state", () => {
    const result = normalizeGitHubEvent(
      "deployment_status",
      { action: "created", deployment_status: { state: "unexpected" } },
      DELIVERY_ID,
      REPOSITORY,
    );

    expect(result).toEqual({
      kind: "ignored",
      reason: "deployment_state_not_relayed",
    });
  });

  it("falls back to the repository URL for an untrusted URL", () => {
    const payload = dependabotPayload("created");
    (payload.alert as Record<string, unknown>).html_url =
      "https://attacker.example/<!channel>/credential";
    const result = normalizeGitHubEvent(
      "dependabot_alert",
      payload,
      DELIVERY_ID,
      REPOSITORY,
    );

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.payload.url).toBe(`https://github.com/${REPOSITORY}`);
  });

  it("escapes Slack control syntax and enforces length limits", () => {
    const sanitized = sanitizeText(`<!channel>${"x".repeat(400)}`, 30);
    expect(sanitized).not.toContain("<!channel>");
    expect(sanitized.length).toBe(30);
    expect(sanitized.endsWith("…")).toBe(true);
  });

  it("never splits an astral character at a truncation boundary", () => {
    for (const [value, maximumLength] of [
      [`${"x".repeat(28)}\ud800tail`, 30],
      [`${"x".repeat(28)}😀tail`, 30],
      [`${"x".repeat(98)}😀tail`, 100],
      [`${"x".repeat(253)}😀tail`, 255],
      [`${"x".repeat(298)}😀tail`, 300],
      [`${"x".repeat(1_498)}😀tail`, 1_500],
      [`${"x".repeat(2_046)}😀tail`, 2_048],
    ] as const) {
      const sanitized = sanitizeText(value, maximumLength);
      expect(sanitized.length).toBeLessThanOrEqual(maximumLength);
      expect(sanitized.endsWith("…")).toBe(true);
      expect(sanitized.isWellFormed()).toBe(true);
    }
  });
});
