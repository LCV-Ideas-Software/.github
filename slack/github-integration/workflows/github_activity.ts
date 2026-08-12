import { DefineWorkflow, Schema } from "deno-slack-sdk/mod.ts";
import { ReportRelayProgressDefinition } from "../functions/report_relay_progress.ts";
import { ValidateRelayMessageDefinition } from "../functions/validate_relay_message.ts";

export const GitHubActivityWorkflow = DefineWorkflow({
  callback_id: "github_activity",
  title: "GitHub activity",
  description:
    "Post normalized organization activity to the private activity channel",
  input_parameters: {
    properties: {
      source: { type: Schema.types.string },
      severity: { type: Schema.types.string },
      repository: { type: Schema.types.string },
      title: { type: Schema.types.string },
      details: { type: Schema.types.string },
      actor: { type: Schema.types.string },
      branch: { type: Schema.types.string },
      url: { type: Schema.types.string },
      occurred_at: { type: Schema.types.string },
      delivery_id: { type: Schema.types.string },
      event: { type: Schema.types.string },
      action: { type: Schema.types.string },
      destination: { type: Schema.types.string },
      relay_timestamp: { type: Schema.types.string },
      relay_signature: { type: Schema.types.string },
    },
    required: [
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
    ],
  },
});

const validated = GitHubActivityWorkflow.addStep(
  ValidateRelayMessageDefinition,
  {
    source: GitHubActivityWorkflow.inputs.source,
    severity: GitHubActivityWorkflow.inputs.severity,
    repository: GitHubActivityWorkflow.inputs.repository,
    title: GitHubActivityWorkflow.inputs.title,
    details: GitHubActivityWorkflow.inputs.details,
    actor: GitHubActivityWorkflow.inputs.actor,
    branch: GitHubActivityWorkflow.inputs.branch,
    url: GitHubActivityWorkflow.inputs.url,
    occurred_at: GitHubActivityWorkflow.inputs.occurred_at,
    delivery_id: GitHubActivityWorkflow.inputs.delivery_id,
    event: GitHubActivityWorkflow.inputs.event,
    action: GitHubActivityWorkflow.inputs.action,
    destination: GitHubActivityWorkflow.inputs.destination,
    relay_timestamp: GitHubActivityWorkflow.inputs.relay_timestamp,
    relay_signature: GitHubActivityWorkflow.inputs.relay_signature,
    expected_destination: "activity",
  },
);

const sendBoundary = GitHubActivityWorkflow.addStep(
  ReportRelayProgressDefinition,
  {
    delivery_id: GitHubActivityWorkflow.inputs.delivery_id,
    destination: GitHubActivityWorkflow.inputs.destination,
    phase: "send_started",
    message_ts: "",
    message: validated.outputs.message,
    relay_timestamp: GitHubActivityWorkflow.inputs.relay_timestamp,
    progress_token: validated.outputs.progress_token,
  },
);

const sent = GitHubActivityWorkflow.addStep(
  Schema.slack.functions.SendMessage,
  {
    channel_id: "C0BMQMW3L4E",
    message: sendBoundary.outputs.message,
  },
);

GitHubActivityWorkflow.addStep(ReportRelayProgressDefinition, {
  delivery_id: GitHubActivityWorkflow.inputs.delivery_id,
  destination: GitHubActivityWorkflow.inputs.destination,
  phase: "delivered",
  message_ts: sent.outputs.message_timestamp,
  message: "",
  relay_timestamp: GitHubActivityWorkflow.inputs.relay_timestamp,
  progress_token: validated.outputs.progress_token,
});

export default GitHubActivityWorkflow;
