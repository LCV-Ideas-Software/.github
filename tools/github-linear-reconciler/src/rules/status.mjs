import { finding } from "../domain/findings.mjs";

export function evaluateStatus(context) {
  const { linear, mappingByTeam, githubIssueByKey } = context;
  const findings = [];
  for (const issue of linear.issues) {
    if (mappingByTeam.get(issue.teamKey)?.mode !== "github-backed") continue;
    if (issue.nativeCounterpartKeys.length !== 1) continue;
    const githubIssue = githubIssueByKey.get(issue.nativeCounterpartKeys[0]);
    if (!githubIssue || githubIssue.status === issue.status) continue;
    findings.push(
      finding(
        "drift",
        "status_divergence",
        issue.identifier,
        `normalized statuses differ: Linear=${issue.status}; GitHub=${githubIssue.status}`,
        [githubIssue.key],
      ),
    );
  }
  return findings;
}
