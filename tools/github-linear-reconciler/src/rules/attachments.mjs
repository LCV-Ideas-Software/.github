import { finding } from "../domain/findings.mjs";

export function evaluateAttachments(context) {
  const { linear, mappingByTeam, githubIssueByKey } = context;
  const findings = [];
  for (const issue of linear.issues) {
    const mode = mappingByTeam.get(issue.teamKey)?.mode;
    if (
      mode === "linear-only" &&
      (issue.attachmentIssueKeys.length > 0 ||
        issue.carrierPullKeys.length > 0 ||
        issue.insecureGithubResourceKeys.length > 0)
    ) {
      findings.push(
        finding(
          "drift",
          "linear_only_github_attachment",
          issue.identifier,
          "linear-only issue contains a GitHub attachment",
          [
            ...issue.attachmentIssueKeys,
            ...issue.carrierPullKeys,
            ...issue.insecureGithubResourceKeys,
          ],
        ),
      );
    }
    if (mode !== "github-backed") continue;
    if (issue.insecureGithubResourceKeys.length > 0) {
      findings.push(
        finding(
          "drift",
          "insecure_github_attachment",
          issue.identifier,
          "GitHub attachment uses an insecure HTTP resource",
          issue.insecureGithubResourceKeys,
        ),
      );
    }
    for (const attachmentKey of issue.attachmentIssueKeys) {
      if (githubIssueByKey.has(attachmentKey)) continue;
      findings.push(
        finding(
          "drift",
          "github_attachment_target_missing",
          issue.identifier,
          "GitHub Issue attachment is absent from the complete snapshot",
          [attachmentKey],
        ),
      );
    }
    if (issue.nativeCounterpartKeys.length !== 1) continue;
    const counterpartKey = issue.nativeCounterpartKeys[0];
    if (!issue.attachmentIssueKeys.includes(counterpartKey)) {
      findings.push(
        finding(
          "drift",
          "missing_github_issue_attachment",
          issue.identifier,
          "canonical GitHub counterpart is not explicitly attached",
          [counterpartKey],
        ),
      );
    }
  }
  return findings;
}
