import type { AlertQueueMessage } from "../src/alerts/contract";

// Fixture, nunca um segredo real; ≥32 bytes porque a rota e a prontidão
// exigem o piso do webhook.
export const TEST_WEBHOOK_SECRET = "unit-test-github-webhook-secret-32";

export class FakeQueue {
  readonly sent: AlertQueueMessage[] = [];
  fail = false;

  async send(body: AlertQueueMessage): Promise<void> {
    if (this.fail) {
      throw new Error("test queue failure");
    }
    this.sent.push(structuredClone(body));
  }
}

export function makeEnv(
  queue: FakeQueue,
  options: {
    githubSecret?: string;
    botToken?: string;
    statusSecret?: string;
    workerRevision?: string;
  } = {},
): Env {
  return {
    ALERT_QUEUE: queue as unknown as Queue,
    DB: {} as D1Database,
    GITHUB_WEBHOOK_SECRET: (options.githubSecret ??
      TEST_WEBHOOK_SECRET) as unknown as SecretsStoreSecret,
    // ADR-002 §5, decisão 11. Fixture, nunca um token real.
    SLACK_BOT_TOKEN: (options.botToken ??
      "xoxb-token-de-teste") as unknown as SecretsStoreSecret,
    // ADR-002 §5, decisão 9. Fixture, nunca o segredo real; ≥32 bytes
    // porque a rota e a prontidão exigem o piso do webhook.
    ALERTS_STATUS_SECRET: (options.statusSecret ??
      "segredo-status-de-teste-com-mais-de-32-bytes") as unknown as SecretsStoreSecret,
    WORKER_VERSION: {
      id: "test-worker-version",
      tag: options.workerRevision ?? "a".repeat(40),
      timestamp: "2026-08-03T12:00:00.000Z",
    },
  };
}

export function workflowPayload(
  conclusion: string = "failure",
): Record<string, unknown> {
  return {
    action: "completed",
    organization: { login: "LCV-Ideas-Software" },
    repository: {
      archived: false,
      full_name: "LCV-Ideas-Software/cross-review",
      owner: { login: "LCV-Ideas-Software" },
    },
    sender: { login: "dependabot[bot]" },
    workflow_run: {
      actor: { login: "dependabot[bot]" },
      conclusion,
      created_at: "2026-08-03T11:58:00Z",
      head_branch: "dependabot/npm_and_yarn/example-1.0.0",
      html_url:
        "https://github.com/LCV-Ideas-Software/cross-review/actions/runs/1",
      name: "CI",
      updated_at: "2026-08-03T12:00:00Z",
    },
  };
}

export async function signedRequest(
  event: string,
  deliveryId: string,
  payload: unknown,
  options: { secret?: string; rawBody?: string } = {},
): Promise<Request> {
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  const body = new TextEncoder().encode(rawBody);
  const secret = options.secret ?? TEST_WEBHOOK_SECRET;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "HMAC" }, key, body),
  );
  const hexadecimal = [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return new Request("https://relay.example/github/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": deliveryId,
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": `sha256=${hexadecimal}`,
    },
    body,
  });
}
