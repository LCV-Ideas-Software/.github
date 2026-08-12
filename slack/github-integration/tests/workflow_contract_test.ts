import GitHubActivityWorkflow from "../workflows/github_activity.ts";
import GitHubAlertWorkflow from "../workflows/github_alert.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

for (
  const [name, workflow, expectedChannel] of [
    ["activity", GitHubActivityWorkflow, "C0BMQMW3L4E"],
    ["alerts", GitHubAlertWorkflow, "C0BMUK793NV"],
  ] as const
) {
  Deno.test(`${name} binds the delivered receipt to the live SendMessage output`, () => {
    const serialized = JSON.parse(JSON.stringify(workflow)) as {
      steps: Array<{
        function_id: string;
        inputs: Record<string, unknown>;
      }>;
    };
    assertEquals(serialized.steps.length, 4, `${name} step count`);
    assertEquals(
      serialized.steps[2].function_id,
      "slack#/functions/send_message",
      `${name} send step`,
    );
    assertEquals(
      serialized.steps[2].inputs.channel_id,
      expectedChannel,
      `${name} fixed destination channel`,
    );
    assertEquals(
      serialized.steps[3].inputs.message_ts,
      "{{steps.2.message_context.message_ts}}",
      `${name} delivered message timestamp binding`,
    );
    if (
      JSON.stringify(serialized.steps[3]).includes("message_timestamp")
    ) {
      throw new Error(
        `${name} must not bind the undocumented live message_timestamp output`,
      );
    }
  });
}
