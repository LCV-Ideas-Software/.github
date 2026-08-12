import { Manifest } from "deno-slack-sdk/mod.ts";
import { ReportRelayProgressDefinition } from "./functions/report_relay_progress.ts";
import { ValidateRelayMessageDefinition } from "./functions/validate_relay_message.ts";
import GitHubActivityWorkflow from "./workflows/github_activity.ts";
import GitHubAlertWorkflow from "./workflows/github_alert.ts";

export default Manifest({
  name: "LCV GitHub integration",
  description:
    "Routes organization GitHub activity and actionable alerts to private Slack channels",
  icon: "assets/default_new_app_icon.png",
  functions: [ValidateRelayMessageDefinition, ReportRelayProgressDefinition],
  workflows: [GitHubActivityWorkflow, GitHubAlertWorkflow],
  outgoingDomains: ["github-slack-alerts.lcv.workers.dev"],
  botScopes: ["chat:write", "chat:write.public", "channels:read"],
});
