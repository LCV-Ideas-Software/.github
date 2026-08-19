import { finding } from "../domain/findings.mjs";

function historicalFindings(issue, control) {
  if (control.urlState === "absent") return [];
  if (control.urlState === "unparseable") {
    return [
      finding(
        "advisory",
        "github_thread_control_historical_url_unparseable",
        control.linearCommentId,
        "disconnected GitHub thread control retained an unparseable historical URL",
        [issue.identifier],
      ),
    ];
  }

  if (issue.nativeCounterpartKeys.length === 0) {
    return [
      finding(
        "advisory",
        "github_thread_control_historical_thread_only",
        control.linearCommentId,
        "disconnected GitHub thread control has no native Issues Sync counterpart",
        [issue.identifier, control.observedResourceKey],
      ),
    ];
  }
  const corroboratesNative = issue.nativeCounterpartKeys.includes(
    control.observedResourceKey,
  );
  if (issue.nativeCounterpartKeys.length > 1 && corroboratesNative) {
    return [
      finding(
        "advisory",
        "github_thread_control_historical_native_counterpart_ambiguous",
        control.linearCommentId,
        "disconnected GitHub thread control cannot corroborate multiple native Issues Sync identities",
        [
          issue.identifier,
          control.observedResourceKey,
          ...issue.nativeCounterpartKeys,
        ],
      ),
    ];
  }
  if (!corroboratesNative) {
    return [
      finding(
        "advisory",
        "github_thread_control_historical_mismatch",
        control.linearCommentId,
        "disconnected GitHub thread control differs from native Issues Sync history",
        [
          issue.identifier,
          control.observedResourceKey,
          ...issue.nativeCounterpartKeys,
        ],
      ),
    ];
  }
  return [];
}

function activeFindings(issue, control) {
  const findings = [];
  if (issue.nativeCounterpartKeys.length === 0) {
    findings.push(
      finding(
        "incomplete",
        "github_thread_control_native_counterpart_missing",
        control.linearCommentId,
        "connected GitHub thread control has no native Issues Sync identity",
        [issue.identifier],
      ),
    );
  } else if (issue.nativeCounterpartKeys.length > 1) {
    findings.push(
      finding(
        "incomplete",
        "github_thread_control_native_counterpart_ambiguous",
        control.linearCommentId,
        "connected GitHub thread control cannot corroborate multiple native Issues Sync identities",
        [issue.identifier, ...issue.nativeCounterpartKeys],
      ),
    );
  }

  if (control.urlState === "absent") {
    findings.push(
      finding(
        "incomplete",
        "github_thread_control_active_url_absent",
        control.linearCommentId,
        "connected GitHub thread control has no corroborating resource URL",
        [issue.identifier],
      ),
    );
  } else if (control.urlState === "unparseable") {
    findings.push(
      finding(
        "incomplete",
        "github_thread_control_active_url_unparseable",
        control.linearCommentId,
        "connected GitHub thread control has an unparseable resource URL",
        [issue.identifier],
      ),
    );
  } else if (
    issue.nativeCounterpartKeys.length === 1 &&
    control.observedResourceKey !== issue.nativeCounterpartKeys[0]
  ) {
    findings.push(
      finding(
        "incomplete",
        "github_thread_control_active_resource_mismatch",
        control.linearCommentId,
        "connected GitHub thread control differs from the native Issues Sync identity",
        [
          issue.identifier,
          control.observedResourceKey,
          issue.nativeCounterpartKeys[0],
        ],
      ),
    );
  }
  return findings;
}

export function evaluateGithubThreadControls({ linear }) {
  const findings = [];
  for (const issue of linear.issues) {
    for (const control of issue.githubThreadControls) {
      findings.push(
        ...(control.connected
          ? activeFindings(issue, control)
          : historicalFindings(issue, control)),
      );
    }
  }
  return findings;
}
