import { ZodError } from "zod";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const LINEAR_NODE_NORMALIZATION_REASON_CODES = Object.freeze([
  "comment_github_external_id_invalid",
  "comment_github_resource_missing",
  "comment_github_sync_ambiguous",
  "comment_thread_integration_conflict",
  "comment_thread_resource_conflict",
  "entity_chronology_invalid",
  "github_discriminator_conflict",
  "github_sync_duplicate",
  "github_sync_invalid",
  "identity_duplicate",
  "issue_duplicate_target_ambiguous",
  "issue_duplicate_target_conflict",
  "relation_ownership_invalid",
  "release_completion_chronology_invalid",
  "schema_invalid",
  "timestamp_invalid",
  "timestamp_outside_capture_window",
  "topology_team_missing",
]);

export const LINEAR_BOUNDARY_REASON_CODES = Object.freeze([
  "captured_at_invalid",
  "connection_cursor_missing",
  "connection_cursor_repeated",
  "connection_fetch_next_failed",
  "connection_fetch_next_missing",
  "connection_nodes_missing",
  "connection_page_info_invalid",
  "connection_read_failed",
  "github_comment_identity_duplicate",
  "issue_duplicate_self_reference",
  "issue_identifier_duplicate",
  "issue_identity_duplicate",
  "issue_reference_unresolved",
  "issue_release_association_duplicate",
  "issue_release_issue_unresolved",
  "issue_release_precedes_release",
  "issue_release_release_unresolved",
  "linear_comment_identity_duplicate",
  "native_github_issue_identity_duplicate",
  "pagination_limit_exceeded",
  "release_pipeline_unresolved",
  "sdk_reader_missing",
  "sdk_relation_read_failed",
  "team_identity_duplicate",
  "team_key_duplicate",
  "team_reference_unresolved",
]);

const NODE_REASON_CODES = new Set(LINEAR_NODE_NORMALIZATION_REASON_CODES);
const BOUNDARY_REASON_CODES = new Set(LINEAR_BOUNDARY_REASON_CODES);
const ROOT_SCOPES =
  "teams|issues|cycles|projects|initiatives|documents|releasePipelines|releases|issueToReleases";
const CHILD_SCOPES = "attachments|comments|relations|inverseRelations|teams";
const NODE_SCOPE_PATTERN = new RegExp(
  `^(?:${ROOT_SCOPES})\\[\\d+\\](?:\\.(?:${CHILD_SCOPES})\\[\\d+\\])?$`,
  "u",
);
const BOUNDARY_SCOPE_PATTERN = new RegExp(
  `^(?:workspace|(?:${ROOT_SCOPES})(?:\\[\\d+\\])?(?:\\.(?:${CHILD_SCOPES})(?:\\[\\d+\\])?)?)$`,
  "u",
);

function normalizedReasonCodes(reasonCodes, allowlist, label) {
  if (!Array.isArray(reasonCodes) || reasonCodes.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  const normalized = [...new Set(reasonCodes)].sort(compareText);
  if (
    normalized.some(
      (reasonCode) =>
        typeof reasonCode !== "string" || !allowlist.has(reasonCode),
    )
  ) {
    throw new TypeError(`${label} contains an unsupported reason code`);
  }
  return Object.freeze(normalized);
}

function assertScope(scope, pattern, label) {
  if (typeof scope !== "string" || !pattern.test(scope)) {
    throw new TypeError(`${label} is not an ordinal Linear scope`);
  }
  return scope;
}

export class LinearNodeNormalizationError extends Error {
  constructor(reasonCodes) {
    super("linear node normalization failed");
    this.name = "LinearNodeNormalizationError";
    this.reasonCodes = normalizedReasonCodes(
      reasonCodes,
      NODE_REASON_CODES,
      "Linear node reasonCodes",
    );
    Object.freeze(this);
  }
}

export class LinearBoundaryError extends Error {
  constructor(scope, reasonCode, cause) {
    super("linear boundary failed", { cause });
    this.name = "LinearBoundaryError";
    this.scope = assertScope(
      scope,
      BOUNDARY_SCOPE_PATTERN,
      "Linear boundary scope",
    );
    this.reasonCodes = normalizedReasonCodes(
      [reasonCode],
      BOUNDARY_REASON_CODES,
      "Linear boundary reasonCodes",
    );
    Object.freeze(this);
  }
}

export function linearNodeNormalizationError(...reasonCodes) {
  return new LinearNodeNormalizationError(reasonCodes);
}

export function linearBoundaryError(scope, reasonCode, cause) {
  return new LinearBoundaryError(scope, reasonCode, cause);
}

export function linearNodeReasonCodes(error) {
  if (error instanceof LinearNodeNormalizationError) return error.reasonCodes;
  if (error instanceof ZodError) return Object.freeze(["schema_invalid"]);
  return null;
}

export function linearNodeFailure(scope, error) {
  const reasonCodes = linearNodeReasonCodes(error);
  if (reasonCodes === null) return null;
  return Object.freeze({
    source: "linear",
    code: "node_invalid",
    scope: assertScope(scope, NODE_SCOPE_PATTERN, "Linear node scope"),
    reasonCodes,
    message: "linear node normalization failed",
  });
}

export function linearBoundaryFailure(error) {
  if (!(error instanceof LinearBoundaryError)) return null;
  return Object.freeze({
    source: "linear",
    code: "boundary_invalid",
    scope: error.scope,
    reasonCodes: error.reasonCodes,
    message: "linear boundary failed",
  });
}

export function linearAdapterInternalFailure() {
  return Object.freeze({
    source: "linear",
    code: "adapter_internal_error",
    scope: "workspace",
    reasonCodes: Object.freeze([]),
    message: "linear adapter internal error",
  });
}

export function validLinearFailure(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.source !== "linear" ||
    !Array.isArray(value.reasonCodes)
  ) {
    return false;
  }
  if (
    value.code === "node_invalid" &&
    value.message === "linear node normalization failed" &&
    typeof value.scope === "string" &&
    NODE_SCOPE_PATTERN.test(value.scope)
  ) {
    try {
      const normalized = normalizedReasonCodes(
        value.reasonCodes,
        NODE_REASON_CODES,
        "Linear node failure reasonCodes",
      );
      return (
        value.reasonCodes.length > 0 &&
        normalized.every(
          (reasonCode, index) => reasonCode === value.reasonCodes[index],
        ) &&
        normalized.length === value.reasonCodes.length
      );
    } catch {
      return false;
    }
  }
  if (
    value.code === "boundary_invalid" &&
    value.message === "linear boundary failed" &&
    typeof value.scope === "string" &&
    BOUNDARY_SCOPE_PATTERN.test(value.scope)
  ) {
    try {
      const normalized = normalizedReasonCodes(
        value.reasonCodes,
        BOUNDARY_REASON_CODES,
        "Linear boundary failure reasonCodes",
      );
      return (
        value.reasonCodes.length === 1 && normalized[0] === value.reasonCodes[0]
      );
    } catch {
      return false;
    }
  }
  return (
    value.code === "adapter_internal_error" &&
    value.scope === "workspace" &&
    value.message === "linear adapter internal error" &&
    value.reasonCodes.length === 0
  );
}

export function linearFailureReferences(value) {
  if (!validLinearFailure(value)) return Object.freeze([]);
  const prefix = `${value.source}:${value.code}:${value.scope}`;
  return Object.freeze(
    value.reasonCodes.length === 0
      ? [prefix]
      : value.reasonCodes.map((reasonCode) => `${prefix}:${reasonCode}`),
  );
}
