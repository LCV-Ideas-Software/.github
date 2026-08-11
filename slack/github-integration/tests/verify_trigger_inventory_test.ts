import {
  readTriggerInventoryConfiguration,
  runTriggerInventoryCli,
  verifyTriggerInventory,
} from "../scripts/verify_trigger_inventory.ts";

const environment: Readonly<Record<string, string>> = Object.freeze({
  ACTIVITY_TRIGGER_ID: "Ft0BMSQ5ME1Y",
  ALERT_TRIGGER_ID: "Ft0BMQQTKZUN",
  SLACK_APP_ID: "A0BMWBGES20",
});

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Values are not equal.");
  }
}

function assertThrows(action: () => unknown) {
  let threw = false;
  try {
    action();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("Expected function to throw.");
}
const inputNames = [
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
  "relay_timestamp",
  "relay_signature",
];

function inputs() {
  return Object.fromEntries(
    inputNames.map((name) => [name, { value: `{{data.${name}}}` }]),
  );
}

function trigger(
  id: string,
  callbackId: string,
  name: string,
  description: string,
) {
  return {
    id,
    type: "webhook",
    name,
    description,
    webhook_url: "https://hooks.slack.com/triggers/T000/B000/secret",
    workflow: { app_id: environment.SLACK_APP_ID, callback_id: callbackId },
    inputs: inputs(),
  };
}

function payload() {
  return {
    ok: true,
    triggers: [
      trigger(
        environment.ACTIVITY_TRIGGER_ID,
        "github_activity",
        "GitHub organization activity",
        "Receive normalized non-alert GitHub organization activity",
      ),
      trigger(
        environment.ALERT_TRIGGER_ID,
        "github_actionable_alert",
        "GitHub actionable alerts",
        "Receive normalized GitHub failures and security alerts",
      ),
    ],
    response_metadata: { next_cursor: "" },
  };
}

Deno.test("validates the exact two-trigger production inventory", () => {
  const configuration = readTriggerInventoryConfiguration(environment);
  assertEquals(verifyTriggerInventory(payload(), configuration), {
    triggers: 2,
  });
});

Deno.test("configuration rejects absent, malformed, duplicate, or padded identifiers", () => {
  for (const name of Object.keys(environment)) {
    const candidate = { ...environment } as Record<string, string | undefined>;
    delete candidate[name];
    assertThrows(() => readTriggerInventoryConfiguration(candidate));
  }
  assertThrows(() =>
    readTriggerInventoryConfiguration({
      ...environment,
      ACTIVITY_TRIGGER_ID: environment.ALERT_TRIGGER_ID,
    })
  );
  assertThrows(() =>
    readTriggerInventoryConfiguration({
      ...environment,
      SLACK_APP_ID: ` ${environment.SLACK_APP_ID}`,
    })
  );
});

Deno.test("fails closed on Slack errors, pagination, extras, and duplicates", () => {
  const configuration = readTriggerInventoryConfiguration(environment);
  for (
    const candidate of [
      { ...payload(), ok: false },
      { ...payload(), response_metadata: { next_cursor: "cursor" } },
      {
        ...payload(),
        triggers: [...payload().triggers, payload().triggers[0]],
      },
      {
        ...payload(),
        triggers: [payload().triggers[0], payload().triggers[0]],
      },
    ]
  ) {
    assertThrows(() => verifyTriggerInventory(candidate, configuration));
  }
});

Deno.test("fails closed on type, app, callback, name, URL, or input drift", () => {
  const configuration = readTriggerInventoryConfiguration(environment);
  const mutations: Array<(candidate: ReturnType<typeof payload>) => void> = [
    (candidate) => (candidate.triggers[0].type = "event"),
    (candidate) => (candidate.triggers[0].workflow.app_id = "A0000000000"),
    (
      candidate,
    ) => (candidate.triggers[0].workflow.callback_id =
      "github_actionable_alert"),
    (candidate) => (candidate.triggers[0].name = "Drifted"),
    (
      candidate,
    ) => (candidate.triggers[0].webhook_url = "https://example.test/trigger"),
    (
      candidate,
    ) => (candidate.triggers[0].webhook_url =
      "https://hooks.slack.com:8443/triggers/T000/B000/secret"),
    (
      candidate,
    ) => (candidate.triggers[0].webhook_url =
      "https://hooks.slack.com/triggers/T000/B000/secret?debug=true"),
    (
      candidate,
    ) => (candidate.triggers[0].webhook_url =
      "https://hooks.slack.com/triggers/"),
    (
      candidate,
    ) => (candidate.triggers[0].webhook_url =
      "https://hooks.slack.com/triggers/T000/B000/secret/extra"),
    (candidate) => delete candidate.triggers[0].inputs.source,
    (
      candidate,
    ) => (candidate.triggers[0].inputs.source.value = "{{data.other}}"),
  ];
  for (const mutate of mutations) {
    const candidate = payload();
    mutate(candidate);
    assertThrows(() => verifyTriggerInventory(candidate, configuration));
  }
});

Deno.test("CLI mode never renders bearer URLs, payloads, or parser details", async () => {
  const sentinel = "secret-webhook-sentinel";
  const valid = payload();
  valid.triggers[0].webhook_url =
    `https://hooks.slack.com/triggers/T000/B000/${sentinel}`;
  const cases = [
    JSON.stringify(valid),
    `{\"ok\":false,\"error\":\"${sentinel}\"}`,
    `{malformed-${sentinel}`,
    sentinel.repeat(1_048_577),
  ];

  for (const source of cases) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runTriggerInventoryCli({
      readSource: () => Promise.resolve(source),
      environment,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });
    const output = [...stdout, ...stderr].join("\n");
    if (source === cases[0]) {
      assertEquals(exitCode, 0);
      assertEquals(stdout, [
        "Verified exact protected Slack trigger inventory.",
      ]);
      assertEquals(stderr, []);
    } else {
      assertEquals(exitCode, 1);
      assertEquals(stdout, []);
      assertEquals(stderr, ["Slack trigger inventory verification failed."]);
    }
    if (output.includes(sentinel) || output.includes("hooks.slack.com")) {
      throw new Error("CLI output leaked protected trigger data.");
    }
  }
});
