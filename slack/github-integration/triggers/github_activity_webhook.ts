import type { Trigger } from "deno-slack-sdk/types.ts";
import { TriggerTypes } from "deno-slack-api/mod.ts";
import GitHubActivityWorkflow from "../workflows/github_activity.ts";

const GitHubActivityWebhook: Trigger<typeof GitHubActivityWorkflow.definition> =
  {
    type: TriggerTypes.Webhook,
    name: "GitHub organization activity",
    description: "Receive normalized non-alert GitHub organization activity",
    workflow: `#/workflows/${GitHubActivityWorkflow.definition.callback_id}`,
    inputs: {
      source: { value: "{{data.source}}" },
      severity: { value: "{{data.severity}}" },
      repository: { value: "{{data.repository}}" },
      title: { value: "{{data.title}}" },
      details: { value: "{{data.details}}" },
      actor: { value: "{{data.actor}}" },
      branch: { value: "{{data.branch}}" },
      url: { value: "{{data.url}}" },
      occurred_at: { value: "{{data.occurred_at}}" },
      delivery_id: { value: "{{data.delivery_id}}" },
      event: { value: "{{data.event}}" },
      action: { value: "{{data.action}}" },
      destination: { value: "{{data.destination}}" },
      relay_attempt: { value: "{{data.relay_attempt}}" },
      relay_timestamp: { value: "{{data.relay_timestamp}}" },
      relay_signature: { value: "{{data.relay_signature}}" },
    },
  };

export default GitHubActivityWebhook;
