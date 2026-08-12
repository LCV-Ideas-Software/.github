export const TARGET_ORGANIZATION = "LCV-Ideas-Software";

export const SUPPORTED_RELAY_EVENTS: ReadonlySet<string> = new Set([
  "workflow_run",
  "dependabot_alert",
  "code_scanning_alert",
  "secret_scanning_alert",
  "deployment_status",
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
  "release",
  "discussion",
  "discussion_comment",
]);

const PROBLEMATIC_WORKFLOW_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);

const SECURITY_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  dependabot_alert: new Set([
    "auto_dismissed",
    "auto_reopened",
    "created",
    "dismissed",
    "fixed",
    "reintroduced",
    "reopened",
  ]),
  code_scanning_alert: new Set([
    "appeared_in_branch",
    "closed_by_user",
    "created",
    "fixed",
    "reopened",
    "reopened_by_user",
  ]),
  secret_scanning_alert: new Set([
    "created",
    "publicly_leaked",
    "reopened",
    "resolved",
    "validated",
  ]),
};

const ACTIVITY_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pull_request: new Set([
    "auto_merge_disabled",
    "auto_merge_enabled",
    "closed",
    "converted_to_draft",
    "dequeued",
    "enqueued",
    "opened",
    "ready_for_review",
    "reopened",
    "synchronize",
  ]),
  pull_request_review: new Set(["dismissed", "submitted"]),
  pull_request_review_comment: new Set(["created", "deleted", "edited"]),
  issues: new Set(["closed", "deleted", "opened", "reopened", "transferred"]),
  issue_comment: new Set(["created", "deleted", "edited"]),
  release: new Set(["deleted", "published", "unpublished"]),
  discussion: new Set([
    "answered",
    "closed",
    "created",
    "deleted",
    "reopened",
    "transferred",
    "unanswered",
  ]),
  discussion_comment: new Set(["created", "deleted", "edited"]),
};

const MAX_LENGTHS = {
  action: 64,
  actor: 100,
  branch: 255,
  deliveryId: 128,
  details: 1_500,
  event: 64,
  repository: 200,
  severity: 20,
  source: 50,
  title: 300,
  url: 2_048,
} as const;

export type RelayDestination = "alerts" | "activity";

export interface SlackWorkflowPayload {
  source: string;
  severity: string;
  repository: string;
  title: string;
  details: string;
  actor: string;
  branch: string;
  url: string;
  occurred_at: string;
  delivery_id: string;
  event: string;
  action: string;
  destination: RelayDestination;
  relay_attempt: string;
  relay_timestamp: string;
  relay_signature: string;
}

export type NormalizeResult =
  | {
      kind: "accepted";
      destination: RelayDestination;
      payload: SlackWorkflowPayload;
    }
  | { kind: "ignored"; reason: string };

type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonRecord;
}

export function nestedRecord(
  root: JsonRecord,
  ...path: string[]
): JsonRecord | undefined {
  let current: JsonRecord | undefined = root;

  for (const segment of path) {
    current = current === undefined ? undefined : asRecord(current[segment]);
  }

  return current;
}

export function nestedString(root: JsonRecord, ...path: string[]): string {
  if (path.length === 0) {
    return "";
  }

  let current: unknown = root;
  for (const segment of path) {
    const record = asRecord(current);
    if (record === undefined) {
      return "";
    }
    current = record[segment];
  }

  return typeof current === "string" ? current : "";
}

export function sanitizeText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value
    .toWellFormed()
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");

  if (normalized.length <= maximumLength) {
    return normalized;
  }

  const truncated = normalized.slice(0, Math.max(0, maximumLength - 1));
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  const codePointSafe =
    lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
      ? truncated.slice(0, -1)
      : truncated;
  return `${codePointSafe}…`;
}

function normalizedSeverity(value: string, fallback = "high"): string {
  const severity = value.trim().toLowerCase();

  switch (severity) {
    case "critical":
      return "critical";
    case "error":
    case "high":
      return "high";
    case "moderate":
    case "medium":
    case "warning":
      return "medium";
    case "low":
    case "note":
      return "low";
    case "info":
    case "informational":
      return "info";
    default:
      return fallback;
  }
}

function validOccurredAt(value: string): string {
  if (value === "") {
    return "";
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : "";
}

function githubUrl(value: string, repository: string): string {
  const fallback = `https://github.com/${repository}`;

  try {
    const parsed = new URL(value === "" ? fallback : value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com"
    ) {
      return fallback;
    }

    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return sanitizeText(parsed.toString(), MAX_LENGTHS.url);
  } catch {
    return fallback;
  }
}

function commonFields(
  event: string,
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): Pick<
  SlackWorkflowPayload,
  "repository" | "actor" | "delivery_id" | "event" | "action"
> {
  return {
    repository: sanitizeText(repository, MAX_LENGTHS.repository),
    actor: sanitizeText(
      nestedString(payload, "sender", "login"),
      MAX_LENGTHS.actor,
    ),
    delivery_id: sanitizeText(deliveryId, MAX_LENGTHS.deliveryId),
    event: sanitizeText(event, MAX_LENGTHS.event),
    action: sanitizeText(action, MAX_LENGTHS.action),
  };
}

function normalizeWorkflowRun(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  const run = nestedRecord(payload, "workflow_run");
  if (action !== "completed" || run === undefined) {
    return { kind: "ignored", reason: "workflow_not_completed" };
  }

  const conclusion = nestedString(run, "conclusion").toLowerCase();
  if (!PROBLEMATIC_WORKFLOW_CONCLUSIONS.has(conclusion)) {
    return { kind: "ignored", reason: "workflow_not_problematic" };
  }

  const workflow =
    sanitizeText(nestedString(run, "name"), 200) || "Unnamed workflow";
  const branch = sanitizeText(
    nestedString(run, "head_branch"),
    MAX_LENGTHS.branch,
  );
  const runActor = sanitizeText(
    nestedString(run, "actor", "login"),
    MAX_LENGTHS.actor,
  );
  const fields = commonFields(
    "workflow_run",
    action,
    deliveryId,
    repository,
    payload,
  );

  return {
    kind: "accepted",
    destination: "alerts",
    payload: {
      source: "GitHub Actions",
      severity: normalizedSeverity(conclusion, "high"),
      ...fields,
      actor: runActor || fields.actor,
      branch,
      title: sanitizeText(`${workflow}: ${conclusion}`, MAX_LENGTHS.title),
      details: sanitizeText(
        `Workflow ${workflow} completed with conclusion ${conclusion}.`,
        MAX_LENGTHS.details,
      ),
      url: githubUrl(nestedString(run, "html_url"), repository),
      occurred_at: validOccurredAt(
        nestedString(run, "updated_at") || nestedString(run, "created_at"),
      ),
      destination: "alerts",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

function normalizeDeployment(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  const status = nestedRecord(payload, "deployment_status");
  if (status === undefined) {
    return { kind: "ignored", reason: "deployment_status_missing" };
  }

  const state = nestedString(status, "state").toLowerCase();
  const isAlert = state === "error" || state === "failure";
  const isActivity = state === "success" || state === "inactive";
  if (!isAlert && !isActivity) {
    return { kind: "ignored", reason: "deployment_state_not_relayed" };
  }

  const deployment = nestedRecord(payload, "deployment");
  const environment = sanitizeText(
    nestedString(status, "environment") ||
      (deployment === undefined ? "" : nestedString(deployment, "environment")),
    200,
  );
  const ref = sanitizeText(
    deployment === undefined ? "" : nestedString(deployment, "ref"),
    MAX_LENGTHS.branch,
  );
  const fields = commonFields(
    "deployment_status",
    action,
    deliveryId,
    repository,
    payload,
  );
  const title = sanitizeText(
    `Deployment ${state}${environment === "" ? "" : `: ${environment}`}`,
    MAX_LENGTHS.title,
  );
  const details = sanitizeText(
    `Deployment entered the ${state} state${
      environment === "" ? "" : ` in environment ${environment}`
    }.`,
    MAX_LENGTHS.details,
  );
  const url = githubUrl(nestedString(status, "repository_url"), repository);
  const occurredAt = validOccurredAt(nestedString(status, "created_at"));

  if (isActivity) {
    return activityResult({
      event: "deployment_status",
      action,
      deliveryId,
      repository,
      rawPayload: payload,
      source: "GitHub Deployments",
      title,
      details,
      branch: ref,
      url,
      occurredAt,
    });
  }

  return {
    kind: "accepted",
    destination: "alerts",
    payload: {
      source: "GitHub Deployments",
      severity: "high",
      ...fields,
      branch: ref,
      title,
      details,
      url,
      occurred_at: occurredAt,
      destination: "alerts",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

function normalizeDependabot(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  const allowed = SECURITY_ACTIONS.dependabot_alert;
  if (allowed === undefined || !allowed.has(action)) {
    return { kind: "ignored", reason: "dependabot_lifecycle_not_relevant" };
  }

  const alert = nestedRecord(payload, "alert");
  if (alert === undefined) {
    return { kind: "ignored", reason: "dependabot_alert_missing" };
  }

  const advisory = nestedRecord(alert, "security_advisory");
  const vulnerability = nestedRecord(alert, "security_vulnerability");
  const dependency = nestedRecord(alert, "dependency");
  const packageRecord =
    dependency === undefined ? undefined : nestedRecord(dependency, "package");
  const packageName = sanitizeText(
    packageRecord === undefined ? "" : nestedString(packageRecord, "name"),
    200,
  );
  const severity = ["auto_dismissed", "dismissed", "fixed"].includes(action)
    ? "info"
    : normalizedSeverity(
        (advisory === undefined ? "" : nestedString(advisory, "severity")) ||
          (vulnerability === undefined
            ? ""
            : nestedString(vulnerability, "severity")),
      );
  const advisorySummary = sanitizeText(
    advisory === undefined ? "" : nestedString(advisory, "summary"),
    1_000,
  );
  const fields = commonFields(
    "dependabot_alert",
    action,
    deliveryId,
    repository,
    payload,
  );

  return {
    kind: "accepted",
    destination: "alerts",
    payload: {
      source: "Dependabot",
      severity,
      ...fields,
      branch: "",
      title: sanitizeText(
        `Dependabot ${action}${packageName === "" ? "" : `: ${packageName}`}`,
        MAX_LENGTHS.title,
      ),
      details: sanitizeText(
        advisorySummary || `Dependabot alert lifecycle changed to ${action}.`,
        MAX_LENGTHS.details,
      ),
      url: githubUrl(nestedString(alert, "html_url"), repository),
      occurred_at: validOccurredAt(
        nestedString(alert, "updated_at") || nestedString(alert, "created_at"),
      ),
      destination: "alerts",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

function normalizeCodeScanning(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  const allowed = SECURITY_ACTIONS.code_scanning_alert;
  if (allowed === undefined || !allowed.has(action)) {
    return { kind: "ignored", reason: "code_scanning_lifecycle_not_relevant" };
  }

  const alert = nestedRecord(payload, "alert");
  const rule = alert === undefined ? undefined : nestedRecord(alert, "rule");
  if (alert === undefined || rule === undefined) {
    return { kind: "ignored", reason: "code_scanning_alert_missing" };
  }

  const ruleName = sanitizeText(
    nestedString(rule, "name") || nestedString(rule, "id"),
    200,
  );
  const description = sanitizeText(nestedString(rule, "description"), 1_000);
  const severity = ["closed_by_user", "fixed"].includes(action)
    ? "info"
    : normalizedSeverity(
        nestedString(rule, "security_severity_level") ||
          nestedString(rule, "severity"),
      );
  const fields = commonFields(
    "code_scanning_alert",
    action,
    deliveryId,
    repository,
    payload,
  );

  return {
    kind: "accepted",
    destination: "alerts",
    payload: {
      source: "GitHub Code Scanning",
      severity,
      ...fields,
      branch: sanitizeText(nestedString(payload, "ref"), MAX_LENGTHS.branch),
      title: sanitizeText(
        `Code scanning ${action}${ruleName === "" ? "" : `: ${ruleName}`}`,
        MAX_LENGTHS.title,
      ),
      details: sanitizeText(
        description || `Code scanning alert lifecycle changed to ${action}.`,
        MAX_LENGTHS.details,
      ),
      url: githubUrl(nestedString(alert, "html_url"), repository),
      occurred_at: validOccurredAt(
        nestedString(alert, "updated_at") || nestedString(alert, "created_at"),
      ),
      destination: "alerts",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

function normalizeSecretScanning(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  const allowed = SECURITY_ACTIONS.secret_scanning_alert;
  if (allowed === undefined || !allowed.has(action)) {
    return {
      kind: "ignored",
      reason: "secret_scanning_lifecycle_not_relevant",
    };
  }

  const alert = nestedRecord(payload, "alert");
  if (alert === undefined) {
    return { kind: "ignored", reason: "secret_scanning_alert_missing" };
  }

  const secretType = sanitizeText(
    nestedString(alert, "secret_type_display_name") ||
      nestedString(alert, "secret_type"),
    200,
  );
  const severity =
    action === "publicly_leaked"
      ? "critical"
      : action === "resolved"
        ? "info"
        : "high";
  const fields = commonFields(
    "secret_scanning_alert",
    action,
    deliveryId,
    repository,
    payload,
  );

  return {
    kind: "accepted",
    destination: "alerts",
    payload: {
      source: "GitHub Secret Scanning",
      severity,
      ...fields,
      branch: "",
      title: sanitizeText(
        `Secret scanning ${action}${secretType === "" ? "" : `: ${secretType}`}`,
        MAX_LENGTHS.title,
      ),
      details: sanitizeText(
        "Secret-scanning lifecycle notification. Secret values, locations, and resolution comments are intentionally omitted.",
        MAX_LENGTHS.details,
      ),
      url: githubUrl(nestedString(alert, "html_url"), repository),
      occurred_at: validOccurredAt(
        nestedString(alert, "updated_at") || nestedString(alert, "created_at"),
      ),
      destination: "alerts",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

function eventNumber(record: JsonRecord | undefined): string {
  const value = record?.number;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : "";
}

function activityResult(input: {
  event: string;
  action: string;
  deliveryId: string;
  repository: string;
  rawPayload: JsonRecord;
  source: string;
  title: string;
  details: string;
  branch?: string;
  url?: string;
  occurredAt?: string;
  actor?: string;
}): NormalizeResult {
  const fields = commonFields(
    input.event,
    input.action,
    input.deliveryId,
    input.repository,
    input.rawPayload,
  );

  return {
    kind: "accepted",
    destination: "activity",
    payload: {
      source: sanitizeText(input.source, MAX_LENGTHS.source),
      severity: "info",
      ...fields,
      actor: sanitizeText(input.actor ?? fields.actor, MAX_LENGTHS.actor),
      branch: sanitizeText(input.branch ?? "", MAX_LENGTHS.branch),
      title: sanitizeText(input.title, MAX_LENGTHS.title),
      details: sanitizeText(input.details, MAX_LENGTHS.details),
      url: githubUrl(input.url ?? "", input.repository),
      occurred_at: validOccurredAt(input.occurredAt ?? ""),
      destination: "activity",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

function normalizePush(
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
  defaultBranch: string,
): NormalizeResult {
  const ref = nestedString(payload, "ref");
  if (defaultBranch === "" || ref !== `refs/heads/${defaultBranch}`) {
    return { kind: "ignored", reason: "push_not_default_branch" };
  }
  const sizeValue = payload.size;
  const size =
    typeof sizeValue === "number" &&
    Number.isSafeInteger(sizeValue) &&
    sizeValue >= 0
      ? sizeValue
      : 0;
  const forced = payload.forced === true;
  const created = payload.created === true;
  const deleted = payload.deleted === true;
  const operation = deleted ? "deleted" : created ? "created" : "updated";
  const headCommit = nestedRecord(payload, "head_commit");

  return activityResult({
    event: "push",
    action: "push",
    deliveryId,
    repository,
    rawPayload: payload,
    source: "GitHub Push",
    title: `Push ${operation}${ref === "" ? "" : `: ${ref}`}`,
    details: `${size} commit${size === 1 ? "" : "s"} in push; ref ${operation}${
      forced ? "; forced update" : ""
    }.`,
    branch: ref,
    url: nestedString(payload, "compare"),
    occurredAt:
      headCommit === undefined ? "" : nestedString(headCommit, "timestamp"),
  });
}

function allowedActivityAction(event: string, action: string): boolean {
  return ACTIVITY_ACTIONS[event]?.has(action) ?? false;
}

function normalizePullRequest(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  if (!allowedActivityAction("pull_request", action)) {
    return { kind: "ignored", reason: "pull_request_action_not_relevant" };
  }

  const pullRequest = nestedRecord(payload, "pull_request");
  if (pullRequest === undefined) {
    return { kind: "ignored", reason: "pull_request_missing" };
  }

  const number = eventNumber(pullRequest) || eventNumber(payload);
  const title = sanitizeText(nestedString(pullRequest, "title"), 200);
  const merged = pullRequest.merged === true;
  const stateDetail = action === "closed" && merged ? "merged" : action;

  return activityResult({
    event: "pull_request",
    action,
    deliveryId,
    repository,
    rawPayload: payload,
    source: "GitHub Pull Requests",
    title: `PR${number === "" ? "" : ` #${number}`} ${stateDetail}${
      title === "" ? "" : `: ${title}`
    }`,
    details: `Pull request${number === "" ? "" : ` #${number}`} ${stateDetail}.`,
    branch: nestedString(pullRequest, "head", "ref"),
    url: nestedString(pullRequest, "html_url"),
    occurredAt:
      nestedString(pullRequest, "updated_at") ||
      nestedString(pullRequest, "created_at"),
    actor: nestedString(payload, "sender", "login"),
  });
}

function normalizePullRequestReview(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  if (!allowedActivityAction("pull_request_review", action)) {
    return {
      kind: "ignored",
      reason: "pull_request_review_action_not_relevant",
    };
  }

  const pullRequest = nestedRecord(payload, "pull_request");
  const review = nestedRecord(payload, "review");
  if (pullRequest === undefined || review === undefined) {
    return { kind: "ignored", reason: "pull_request_review_missing" };
  }

  const number = eventNumber(pullRequest);
  const state = sanitizeText(nestedString(review, "state"), 50) || action;
  const title = sanitizeText(nestedString(pullRequest, "title"), 200);

  return activityResult({
    event: "pull_request_review",
    action,
    deliveryId,
    repository,
    rawPayload: payload,
    source: "GitHub PR Reviews",
    title: `Review ${state}${number === "" ? "" : ` on PR #${number}`}${
      title === "" ? "" : `: ${title}`
    }`,
    details: `Pull-request review ${action} with state ${state}. Review body is omitted.`,
    branch: nestedString(pullRequest, "head", "ref"),
    url:
      nestedString(review, "html_url") || nestedString(pullRequest, "html_url"),
    occurredAt:
      nestedString(review, "submitted_at") ||
      nestedString(pullRequest, "updated_at"),
    actor:
      nestedString(review, "user", "login") ||
      nestedString(payload, "sender", "login"),
  });
}

function normalizePullRequestReviewComment(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  if (!allowedActivityAction("pull_request_review_comment", action)) {
    return {
      kind: "ignored",
      reason: "pull_request_comment_action_not_relevant",
    };
  }

  const pullRequest = nestedRecord(payload, "pull_request");
  const comment = nestedRecord(payload, "comment");
  if (pullRequest === undefined || comment === undefined) {
    return { kind: "ignored", reason: "pull_request_comment_missing" };
  }

  const number = eventNumber(pullRequest);
  const title = sanitizeText(nestedString(pullRequest, "title"), 200);

  return activityResult({
    event: "pull_request_review_comment",
    action,
    deliveryId,
    repository,
    rawPayload: payload,
    source: "GitHub PR Comments",
    title: `Review comment ${action}${number === "" ? "" : ` on PR #${number}`}${
      title === "" ? "" : `: ${title}`
    }`,
    details: `Pull-request review comment ${action}. Comment body, diff, and file location are omitted.`,
    branch: nestedString(pullRequest, "head", "ref"),
    url:
      nestedString(comment, "html_url") ||
      nestedString(pullRequest, "html_url"),
    occurredAt:
      nestedString(comment, "updated_at") ||
      nestedString(comment, "created_at"),
    actor:
      nestedString(comment, "user", "login") ||
      nestedString(payload, "sender", "login"),
  });
}

function normalizeIssue(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  if (!allowedActivityAction("issues", action)) {
    return { kind: "ignored", reason: "issue_action_not_relevant" };
  }

  const issue = nestedRecord(payload, "issue");
  if (issue === undefined || asRecord(issue.pull_request) !== undefined) {
    return { kind: "ignored", reason: "issue_missing_or_pull_request" };
  }

  const number = eventNumber(issue);
  const title = sanitizeText(nestedString(issue, "title"), 200);

  return activityResult({
    event: "issues",
    action,
    deliveryId,
    repository,
    rawPayload: payload,
    source: "GitHub Issues",
    title: `Issue${number === "" ? "" : ` #${number}`} ${action}${
      title === "" ? "" : `: ${title}`
    }`,
    details: `Issue${number === "" ? "" : ` #${number}`} ${action}. Issue body is omitted.`,
    url: nestedString(issue, "html_url"),
    occurredAt:
      nestedString(issue, "updated_at") || nestedString(issue, "created_at"),
  });
}

function normalizeIssueComment(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  if (!allowedActivityAction("issue_comment", action)) {
    return { kind: "ignored", reason: "issue_comment_action_not_relevant" };
  }

  const issue = nestedRecord(payload, "issue");
  const comment = nestedRecord(payload, "comment");
  if (issue === undefined || comment === undefined) {
    return { kind: "ignored", reason: "issue_comment_missing" };
  }

  const number = eventNumber(issue);
  const title = sanitizeText(nestedString(issue, "title"), 200);
  const isPullRequest = asRecord(issue.pull_request) !== undefined;
  const subject = isPullRequest ? "PR" : "issue";

  return activityResult({
    event: "issue_comment",
    action,
    deliveryId,
    repository,
    rawPayload: payload,
    source: "GitHub Comments",
    title: `Comment ${action}${number === "" ? "" : ` on ${subject} #${number}`}${
      title === "" ? "" : `: ${title}`
    }`,
    details: `${subject === "PR" ? "Pull-request" : "Issue"} comment ${action}. Comment body is omitted.`,
    url: nestedString(comment, "html_url") || nestedString(issue, "html_url"),
    occurredAt:
      nestedString(comment, "updated_at") ||
      nestedString(comment, "created_at"),
    actor:
      nestedString(comment, "user", "login") ||
      nestedString(payload, "sender", "login"),
  });
}

function normalizeRelease(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  if (!allowedActivityAction("release", action)) {
    return { kind: "ignored", reason: "release_action_not_relevant" };
  }

  const release = nestedRecord(payload, "release");
  if (release === undefined) {
    return { kind: "ignored", reason: "release_missing" };
  }

  const tag = sanitizeText(nestedString(release, "tag_name"), 200);
  const name = sanitizeText(nestedString(release, "name"), 200);

  return activityResult({
    event: "release",
    action,
    deliveryId,
    repository,
    rawPayload: payload,
    source: "GitHub Releases",
    title: `Release ${action}${tag === "" ? "" : `: ${tag}`}${
      name === "" || name === tag ? "" : ` — ${name}`
    }`,
    details: `Release ${action}. Release body and asset metadata are omitted.`,
    branch: nestedString(release, "target_commitish"),
    url: nestedString(release, "html_url"),
    occurredAt:
      nestedString(release, "published_at") ||
      nestedString(release, "created_at") ||
      nestedString(release, "updated_at"),
    actor:
      nestedString(release, "author", "login") ||
      nestedString(payload, "sender", "login"),
  });
}

function normalizeDiscussion(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  if (!allowedActivityAction("discussion", action)) {
    return { kind: "ignored", reason: "discussion_action_not_relevant" };
  }

  const discussion = nestedRecord(payload, "discussion");
  if (discussion === undefined) {
    return { kind: "ignored", reason: "discussion_missing" };
  }

  const number = eventNumber(discussion);
  const title = sanitizeText(nestedString(discussion, "title"), 200);

  return activityResult({
    event: "discussion",
    action,
    deliveryId,
    repository,
    rawPayload: payload,
    source: "GitHub Discussions",
    title: `Discussion${number === "" ? "" : ` #${number}`} ${action}${
      title === "" ? "" : `: ${title}`
    }`,
    details: `Discussion${number === "" ? "" : ` #${number}`} ${action}. Discussion body is omitted.`,
    url: nestedString(discussion, "html_url"),
    occurredAt:
      nestedString(discussion, "updated_at") ||
      nestedString(discussion, "created_at"),
    actor:
      nestedString(discussion, "user", "login") ||
      nestedString(payload, "sender", "login"),
  });
}

function normalizeDiscussionComment(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  if (!allowedActivityAction("discussion_comment", action)) {
    return {
      kind: "ignored",
      reason: "discussion_comment_action_not_relevant",
    };
  }

  const discussion = nestedRecord(payload, "discussion");
  const comment = nestedRecord(payload, "comment");
  if (discussion === undefined || comment === undefined) {
    return { kind: "ignored", reason: "discussion_comment_missing" };
  }

  const number = eventNumber(discussion);
  const title = sanitizeText(nestedString(discussion, "title"), 200);

  return activityResult({
    event: "discussion_comment",
    action,
    deliveryId,
    repository,
    rawPayload: payload,
    source: "GitHub Discussion Comments",
    title: `Discussion comment ${action}${
      number === "" ? "" : ` on discussion #${number}`
    }${title === "" ? "" : `: ${title}`}`,
    details: `Discussion comment ${action}. Comment body is omitted.`,
    url:
      nestedString(comment, "html_url") || nestedString(discussion, "html_url"),
    occurredAt:
      nestedString(comment, "updated_at") ||
      nestedString(comment, "created_at"),
    actor:
      nestedString(comment, "user", "login") ||
      nestedString(payload, "sender", "login"),
  });
}

export function normalizeGitHubEvent(
  event: string,
  payload: JsonRecord,
  deliveryId: string,
  repository: string,
  defaultBranch = "",
): NormalizeResult {
  const action = nestedString(payload, "action").toLowerCase();

  switch (event) {
    case "workflow_run":
      return normalizeWorkflowRun(action, deliveryId, repository, payload);
    case "deployment_status":
      return normalizeDeployment(action, deliveryId, repository, payload);
    case "dependabot_alert":
      return normalizeDependabot(action, deliveryId, repository, payload);
    case "code_scanning_alert":
      return normalizeCodeScanning(action, deliveryId, repository, payload);
    case "secret_scanning_alert":
      return normalizeSecretScanning(action, deliveryId, repository, payload);
    case "push":
      return normalizePush(deliveryId, repository, payload, defaultBranch);
    case "pull_request":
      return normalizePullRequest(action, deliveryId, repository, payload);
    case "pull_request_review":
      return normalizePullRequestReview(
        action,
        deliveryId,
        repository,
        payload,
      );
    case "pull_request_review_comment":
      return normalizePullRequestReviewComment(
        action,
        deliveryId,
        repository,
        payload,
      );
    case "issues":
      return normalizeIssue(action, deliveryId, repository, payload);
    case "issue_comment":
      return normalizeIssueComment(action, deliveryId, repository, payload);
    case "release":
      return normalizeRelease(action, deliveryId, repository, payload);
    case "discussion":
      return normalizeDiscussion(action, deliveryId, repository, payload);
    case "discussion_comment":
      return normalizeDiscussionComment(
        action,
        deliveryId,
        repository,
        payload,
      );
    default:
      return { kind: "ignored", reason: "event_not_supported" };
  }
}
