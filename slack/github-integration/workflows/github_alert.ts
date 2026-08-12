import { DefineWorkflow, Schema } from "deno-slack-sdk/mod.ts";
import { ReportRelayProgressDefinition } from "../functions/report_relay_progress.ts";
import { ValidateRelayMessageDefinition } from "../functions/validate_relay_message.ts";

export const GitHubAlertWorkflow = DefineWorkflow({
  callback_id: "github_actionable_alert",
  title: "GitHub actionable alert",
  description:
    "Post normalized failures and security alerts to the private alerts channel",
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

const validated = GitHubAlertWorkflow.addStep(ValidateRelayMessageDefinition, {
  source: GitHubAlertWorkflow.inputs.source,
  severity: GitHubAlertWorkflow.inputs.severity,
  repository: GitHubAlertWorkflow.inputs.repository,
  title: GitHubAlertWorkflow.inputs.title,
  details: GitHubAlertWorkflow.inputs.details,
  actor: GitHubAlertWorkflow.inputs.actor,
  branch: GitHubAlertWorkflow.inputs.branch,
  url: GitHubAlertWorkflow.inputs.url,
  occurred_at: GitHubAlertWorkflow.inputs.occurred_at,
  delivery_id: GitHubAlertWorkflow.inputs.delivery_id,
  event: GitHubAlertWorkflow.inputs.event,
  action: GitHubAlertWorkflow.inputs.action,
  destination: GitHubAlertWorkflow.inputs.destination,
  relay_timestamp: GitHubAlertWorkflow.inputs.relay_timestamp,
  relay_signature: GitHubAlertWorkflow.inputs.relay_signature,
  expected_destination: "alerts",
});

const sendBoundary = GitHubAlertWorkflow.addStep(
  ReportRelayProgressDefinition,
  {
    delivery_id: GitHubAlertWorkflow.inputs.delivery_id,
    destination: GitHubAlertWorkflow.inputs.destination,
    phase: "send_started",
    message_ts: "",
    message: validated.outputs.message,
    relay_timestamp: GitHubAlertWorkflow.inputs.relay_timestamp,
    progress_token: validated.outputs.progress_token,
  },
);

const sent = GitHubAlertWorkflow.addStep(Schema.slack.functions.SendMessage, {
  channel_id: "C0BMUK793NV",
  message: sendBoundary.outputs.message,
});

GitHubAlertWorkflow.addStep(ReportRelayProgressDefinition, {
  delivery_id: GitHubAlertWorkflow.inputs.delivery_id,
  destination: GitHubAlertWorkflow.inputs.destination,
  phase: "delivered",
  message_ts: sent.outputs.message_timestamp,
  message: "",
  relay_timestamp: GitHubAlertWorkflow.inputs.relay_timestamp,
  progress_token: validated.outputs.progress_token,
});

export default GitHubAlertWorkflow;
