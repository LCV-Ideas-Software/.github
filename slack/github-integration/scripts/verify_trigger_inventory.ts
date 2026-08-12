const MAX_RESPONSE_BYTES = 1_048_576;

const INPUT_NAMES = Object.freeze([
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
  "relay_signature",
]);

type UnknownRecord = Record<string, unknown>;

function readRuntimeEnvironment(): Record<string, string | undefined> {
  return {
    ACTIVITY_TRIGGER_ID: Deno.env.get("ACTIVITY_TRIGGER_ID"),
    ALERT_TRIGGER_ID: Deno.env.get("ALERT_TRIGGER_ID"),
    SLACK_APP_ID: Deno.env.get("SLACK_APP_ID"),
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnvironmentValue(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const value = environment[name];
  invariant(
    typeof value === "string" && value.trim() !== "",
    `Required environment variable ${name} is missing.`,
  );
  invariant(
    value === value.trim(),
    `Required environment variable ${name} contains surrounding whitespace.`,
  );
  return value;
}

export function readTriggerInventoryConfiguration(
  environment: Record<string, string | undefined> = readRuntimeEnvironment(),
) {
  const activityTriggerId = requiredEnvironmentValue(
    environment,
    "ACTIVITY_TRIGGER_ID",
  );
  const alertTriggerId = requiredEnvironmentValue(
    environment,
    "ALERT_TRIGGER_ID",
  );
  const appId = requiredEnvironmentValue(environment, "SLACK_APP_ID");
  invariant(
    /^Ft[A-Z0-9]{8,}$/.test(activityTriggerId) &&
      /^Ft[A-Z0-9]{8,}$/.test(alertTriggerId),
    "Protected Slack trigger IDs are malformed.",
  );
  invariant(
    activityTriggerId !== alertTriggerId,
    "Protected Slack trigger IDs must be distinct.",
  );
  invariant(/^A[A-Z0-9]{8,}$/.test(appId), "Slack app ID is malformed.");
  return Object.freeze({ activityTriggerId, alertTriggerId, appId });
}

function validateWebhookUrl(value: unknown) {
  invariant(typeof value === "string", "A trigger webhook URL is missing.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A trigger webhook URL is malformed.");
  }
  invariant(
    url.origin === "https://hooks.slack.com" &&
      /^\/triggers\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
        url.pathname,
      ) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "",
    "A trigger webhook URL is outside the official Slack trigger origin.",
  );
}

function validateInputs(inputs: unknown) {
  invariant(isRecord(inputs), "A trigger input mapping is missing.");
  const actualNames = Object.keys(inputs).sort();
  const expectedNames = [...INPUT_NAMES].sort();
  invariant(
    actualNames.length === expectedNames.length &&
      actualNames.every((name, index) => name === expectedNames[index]),
    "A trigger input mapping does not contain the exact contract.",
  );
  for (const name of INPUT_NAMES) {
    const input = inputs[name];
    invariant(
      isRecord(input) && input.value === `{{data.${name}}}`,
      `Trigger input ${name} does not use the exact data mapping.`,
    );
  }
}

function validateTrigger(
  trigger: unknown,
  expected: {
    id: string;
    appId: string;
    callbackId: string;
    name: string;
    description: string;
  },
) {
  invariant(isRecord(trigger), "Slack returned a malformed trigger.");
  invariant(
    trigger.id === expected.id,
    "Slack returned an unexpected trigger ID.",
  );
  invariant(
    trigger.type === "webhook",
    "A protected trigger is not a webhook.",
  );
  invariant(
    trigger.name === expected.name,
    "A protected trigger name drifted.",
  );
  invariant(
    trigger.description === expected.description,
    "A protected trigger description drifted.",
  );
  validateWebhookUrl(trigger.webhook_url);
  invariant(isRecord(trigger.workflow), "A protected trigger has no workflow.");
  invariant(
    trigger.workflow.app_id === expected.appId,
    "A protected trigger belongs to a different Slack app.",
  );
  invariant(
    trigger.workflow.callback_id === expected.callbackId,
    "A protected trigger points to the wrong workflow.",
  );
  validateInputs(trigger.inputs);
}

export function verifyTriggerInventory(
  payload: unknown,
  configuration: ReturnType<typeof readTriggerInventoryConfiguration>,
) {
  invariant(
    isRecord(payload),
    "Slack returned a malformed inventory response.",
  );
  invariant(
    payload.ok === true,
    "Slack rejected the trigger inventory request.",
  );
  invariant(
    Array.isArray(payload.triggers) && payload.triggers.length === 2,
    "Slack must return exactly two production triggers.",
  );
  if (payload.response_metadata !== undefined) {
    invariant(
      isRecord(payload.response_metadata) &&
        (payload.response_metadata.next_cursor === "" ||
          payload.response_metadata.next_cursor === undefined),
      "Slack returned a paginated trigger inventory.",
    );
  }

  const byId = new Map<string, unknown>();
  for (const trigger of payload.triggers) {
    invariant(isRecord(trigger), "Slack returned a malformed trigger.");
    invariant(
      typeof trigger.id === "string" && !byId.has(trigger.id),
      "Slack returned a missing or duplicate trigger ID.",
    );
    byId.set(trigger.id, trigger);
  }
  invariant(
    byId.has(configuration.activityTriggerId) &&
      byId.has(configuration.alertTriggerId),
    "Slack returned an unexpected production trigger set.",
  );

  validateTrigger(byId.get(configuration.activityTriggerId), {
    id: configuration.activityTriggerId,
    appId: configuration.appId,
    callbackId: "github_activity",
    name: "GitHub organization activity",
    description: "Receive normalized non-alert GitHub organization activity",
  });
  validateTrigger(byId.get(configuration.alertTriggerId), {
    id: configuration.alertTriggerId,
    appId: configuration.appId,
    callbackId: "github_actionable_alert",
    name: "GitHub actionable alerts",
    description: "Receive normalized GitHub failures and security alerts",
  });

  return Object.freeze({ triggers: 2 });
}

async function readBoundedStdin() {
  const reader = Deno.stdin.readable.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      invariant(
        byteCount <= MAX_RESPONSE_BYTES,
        "Slack trigger inventory exceeded the size limit.",
      );
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseInventorySource(source: string) {
  invariant(
    new TextEncoder().encode(source).byteLength <= MAX_RESPONSE_BYTES,
    "Slack trigger inventory exceeded the size limit.",
  );
  invariant(source.trim() !== "", "Slack returned an empty trigger inventory.");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("Slack returned malformed trigger inventory JSON.");
  }
}

export async function runTriggerInventoryCli({
  readSource = readBoundedStdin,
  environment = readRuntimeEnvironment(),
  stdout = console.log,
  stderr = console.error,
}: {
  readSource?: () => Promise<string>;
  environment?: Record<string, string | undefined>;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
} = {}) {
  try {
    const payload = parseInventorySource(await readSource());
    verifyTriggerInventory(
      payload,
      readTriggerInventoryConfiguration(environment),
    );
    stdout("Verified exact protected Slack trigger inventory.");
    return 0;
  } catch {
    // Never echo Slack's response: it contains bearer webhook URLs.
    stderr("Slack trigger inventory verification failed.");
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runTriggerInventoryCli();
  if (exitCode !== 0) Deno.exit(exitCode);
}
