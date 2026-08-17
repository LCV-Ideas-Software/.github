export const TARGET_ORGANIZATION = "LCV-Ideas-Software";

// ADR-002 §3 (emendado 16/08): OITO eventos — só o que o app oficial não
// entrega. Os eventos de atividade saíram da allowlist (o oficial os
// cobre); os normalizadores deles permanecem abaixo como código morto
// declarado, com retirada fora do escopo desta mudança. security_advisory
// não entra: disponibilidade "app" — webhook de organização não o recebe.
export const SUPPORTED_RELAY_EVENTS: ReadonlySet<string> = new Set([
  "workflow_run",
  "dependabot_alert",
  "code_scanning_alert",
  "secret_scanning_alert",
  "repository_advisory",
  "security_and_analysis",
  "secret_scanning_alert_location",
  "secret_scanning_scan",
]);

// ADR-002 §5, decisão 1 (emendada): a exclusão exige repositório E caminho
// — caminho sozinho suprimiria o workflow homônimo de outro repositório.
const RELAY_REPOSITORY = "LCV-Ideas-Software/.github";
const EXCLUDED_WORKFLOW_PATHS: ReadonlySet<string> = new Set([
  ".github/workflows/alerts-watchdog.yml",
  ".github/workflows/github-slack-integration.yml",
]);

export function isExcludedWorkflowRun(
  repositoryFullName: string,
  workflowPath: string,
): boolean {
  return (
    repositoryFullName === RELAY_REPOSITORY &&
    EXCLUDED_WORKFLOW_PATHS.has(workflowPath)
  );
}

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
  // ADR-002 §5, decisão 5: todos os eventos de segurança extras entram,
  // inclusive os sub-eventos de secret scanning.
  repository_advisory: new Set(["published", "reported"]),
  secret_scanning_alert_location: new Set(["created"]),
  secret_scanning_scan: new Set(["completed"]),
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

  // ADR-002 §6, instância A: a falha do próprio vigia (ou do deploy do
  // relay) viraria alerta não entregável a cada tique. Repositório E
  // caminho, nunca só caminho.
  if (isExcludedWorkflowRun(repository, nestedString(run, "path"))) {
    return { kind: "ignored", reason: "workflow_excluded_self" };
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
function normalizeRepositoryAdvisory(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  const allowed = SECURITY_ACTIONS.repository_advisory;
  if (allowed === undefined || !allowed.has(action)) {
    return { kind: "ignored", reason: "advisory_lifecycle_not_relevant" };
  }
  const advisory = nestedRecord(payload, "repository_advisory");
  if (advisory === undefined) {
    return { kind: "ignored", reason: "repository_advisory_missing" };
  }
  const fields = commonFields(
    "repository_advisory",
    action,
    deliveryId,
    repository,
    payload,
  );
  // Cru até a composição; sanitiza UMA vez (achado da revisão: sanitizar o
  // summary e depois o título composto duplicava entidades — "R&D" virava
  // "R&amp;amp;D" na mensagem).
  const rawSummary = nestedString(advisory, "summary").slice(0, 1_000);
  return {
    kind: "accepted",
    destination: "alerts",
    payload: {
      source: "GitHub Security Advisory",
      severity: normalizedSeverity(nestedString(advisory, "severity"), "high"),
      ...fields,
      branch: "",
      title: sanitizeText(
        `Repository advisory ${action}${rawSummary === "" ? "" : `: ${rawSummary}`}`,
        MAX_LENGTHS.title,
      ),
      details: sanitizeText(
        rawSummary || `Repository advisory lifecycle changed to ${action}.`,
        MAX_LENGTHS.details,
      ),
      url: githubUrl(nestedString(advisory, "html_url"), repository),
      occurred_at: validOccurredAt(
        nestedString(advisory, "published_at") ||
          nestedString(advisory, "updated_at"),
      ),
      destination: "alerts",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

// ADR-002 §3: mudança de configuração de segurança. O evento NÃO carrega
// campo `action` — o portão é a presença do registro `changes`.
function normalizeSecurityAndAnalysis(
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  const changes = nestedRecord(payload, "changes");
  if (changes === undefined) {
    return { kind: "ignored", reason: "security_and_analysis_changes_missing" };
  }
  const fields = commonFields(
    "security_and_analysis",
    "changed",
    deliveryId,
    repository,
    payload,
  );
  return {
    kind: "accepted",
    destination: "alerts",
    payload: {
      source: "GitHub Security Settings",
      severity: "high",
      ...fields,
      branch: "",
      title: sanitizeText(
        `Security configuration changed: ${repository}`,
        MAX_LENGTHS.title,
      ),
      details: sanitizeText(
        "The security and analysis settings of the repository changed.",
        MAX_LENGTHS.details,
      ),
      url: githubUrl("", repository),
      occurred_at: validOccurredAt(""),
      destination: "alerts",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

// Sub-evento de secret scanning: nova localização de um segredo já
// detectado (decisão 5: os sub-eventos entram).
function normalizeSecretScanningLocation(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  const allowed = SECURITY_ACTIONS.secret_scanning_alert_location;
  if (allowed === undefined || !allowed.has(action)) {
    return { kind: "ignored", reason: "secret_location_lifecycle_not_relevant" };
  }
  const alert = nestedRecord(payload, "alert");
  if (alert === undefined) {
    return { kind: "ignored", reason: "secret_location_alert_missing" };
  }
  const location = nestedRecord(payload, "location");
  // Cru até a composição — sanitiza uma vez, no título (mesma classe do
  // achado do repository_advisory).
  const locationType = (
    location === undefined ? "" : nestedString(location, "type")
  ).slice(0, 100);
  const fields = commonFields(
    "secret_scanning_alert_location",
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
      severity: "high",
      ...fields,
      branch: "",
      title: sanitizeText(
        `Secret detected in new location${locationType === "" ? "" : ` (${locationType})`}`,
        MAX_LENGTHS.title,
      ),
      details: sanitizeText(
        "An existing secret scanning alert gained a new location.",
        MAX_LENGTHS.details,
      ),
      url: githubUrl(nestedString(alert, "html_url"), repository),
      occurred_at: validOccurredAt(""),
      destination: "alerts",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

// Sub-evento de secret scanning: varredura concluída. ADR-002 §12 anota que
// a frequência deste evento não tem relação com haver algo errado — medir
// depois de ligado; se afogar o canal, a decisão volta ao operador.
function normalizeSecretScanningScan(
  action: string,
  deliveryId: string,
  repository: string,
  payload: JsonRecord,
): NormalizeResult {
  const allowed = SECURITY_ACTIONS.secret_scanning_scan;
  if (allowed === undefined || !allowed.has(action)) {
    return { kind: "ignored", reason: "secret_scan_lifecycle_not_relevant" };
  }
  // Cru até a composição — sanitiza uma vez, no título (mesma classe).
  const scanType = nestedString(payload, "type").slice(0, 100);
  const fields = commonFields(
    "secret_scanning_scan",
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
      severity: "info",
      ...fields,
      branch: "",
      title: sanitizeText(
        `Secret scanning scan ${action}${scanType === "" ? "" : ` (${scanType})`}`,
        MAX_LENGTHS.title,
      ),
      details: sanitizeText(
        `A secret scanning scan ${action} for the repository.`,
        MAX_LENGTHS.details,
      ),
      url: githubUrl("", repository),
      occurred_at: validOccurredAt(nestedString(payload, "completed_at")),
      destination: "alerts",
      relay_attempt: "",
      relay_timestamp: "",
      relay_signature: "",
    },
  };
}

export function normalizeGitHubEvent(
  event: string,
  payload: JsonRecord,
  deliveryId: string,
  repository: string,
): NormalizeResult {
  const action = nestedString(payload, "action").toLowerCase();

  switch (event) {
    case "workflow_run":
      return normalizeWorkflowRun(action, deliveryId, repository, payload);
    case "dependabot_alert":
      return normalizeDependabot(action, deliveryId, repository, payload);
    case "code_scanning_alert":
      return normalizeCodeScanning(action, deliveryId, repository, payload);
    case "secret_scanning_alert":
      return normalizeSecretScanning(action, deliveryId, repository, payload);
    case "repository_advisory":
      return normalizeRepositoryAdvisory(action, deliveryId, repository, payload);
    case "security_and_analysis":
      return normalizeSecurityAndAnalysis(deliveryId, repository, payload);
    case "secret_scanning_alert_location":
      return normalizeSecretScanningLocation(
        action,
        deliveryId,
        repository,
        payload,
      );
    case "secret_scanning_scan":
      return normalizeSecretScanningScan(action, deliveryId, repository, payload);
    default:
      return { kind: "ignored", reason: "event_not_supported" };
  }
}
