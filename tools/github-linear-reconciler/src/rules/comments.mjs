import { finding } from "../domain/findings.mjs";

function repeated(values) {
  return new Set(values).size !== values.length;
}

export function evaluateComments(context) {
  const { linear, github, mappingByTeam, githubIssueByKey, commentGraceMs } =
    context;
  const findings = [];
  const linearCutoff = linear.captureStartedAtMs - commentGraceMs;
  const githubCutoff = github.captureStartedAtMs - commentGraceMs;
  for (const issue of linear.issues) {
    const mode = mappingByTeam.get(issue.teamKey)?.mode;
    if (mode === "linear-only") {
      const githubComments = issue.comments.filter(
        (comment) => comment.provenance === "github",
      );
      if (githubComments.length > 0) {
        findings.push(
          finding(
            "drift",
            "linear_only_github_comment",
            issue.identifier,
            "linear-only issue contains GitHub comment provenance",
            githubComments.map((comment) => comment.id),
          ),
        );
      }
      continue;
    }
    if (mode !== "github-backed") continue;
    if (issue.nativeCounterpartKeys.length !== 1) continue;
    const resourceKey = issue.nativeCounterpartKeys[0];
    const githubIssue = githubIssueByKey.get(resourceKey);
    if (!githubIssue) continue;
    const linearComments = issue.comments.filter(
      (comment) => comment.provenance === "github",
    );
    const scopedLinear = linearComments.filter(
      (comment) => comment.resourceKey === resourceKey,
    );
    for (const comment of linearComments) {
      if (comment.resourceKey === resourceKey) continue;
      findings.push(
        finding(
          "drift",
          "comment_resource_mismatch",
          comment.id,
          "structured comment provenance points to another counterpart",
          [comment.resourceKey, resourceKey],
        ),
      );
    }
    if (
      repeated(githubIssue.comments.map((comment) => comment.id)) ||
      repeated(
        scopedLinear
          .map((comment) => comment.externalId)
          .filter((externalId) => externalId !== null),
      )
    ) {
      findings.push(
        finding(
          "incomplete",
          "comment_identity_ambiguous",
          issue.identifier,
          "structured comment identities are not one-to-one",
          [resourceKey],
        ),
      );
      continue;
    }
    const githubById = new Map(
      githubIssue.comments.map((comment) => [comment.id, comment]),
    );
    const linearByExternalId = new Map(
      scopedLinear
        .filter((comment) => comment.externalId !== null)
        .map((comment) => [comment.externalId, comment]),
    );
    for (const comment of scopedLinear) {
      if (!comment.connected) {
        findings.push(
          finding(
            "drift",
            "comment_sync_disconnected",
            comment.id,
            "structured GitHub comment thread is disconnected",
            [resourceKey, comment.externalId],
          ),
        );
      }
      if (comment.externalId === null) {
        if (comment.createdAtMs <= linearCutoff) {
          findings.push(
            finding(
              "incomplete",
              "comment_external_identity_missing",
              comment.id,
              "GitHub-provenance Linear comment has no stable external identity",
              [resourceKey],
            ),
          );
        }
        continue;
      }
      const githubComment = githubById.get(comment.externalId);
      if (!githubComment) {
        if (comment.createdAtMs <= githubCutoff) {
          findings.push(
            finding(
              "drift",
              "comment_sync_gap_to_github",
              comment.id,
              "GitHub-provenance Linear comment has no GitHub identity match",
              [resourceKey, comment.externalId],
            ),
          );
        }
      } else if (githubComment.threadId !== comment.threadId) {
        findings.push(
          finding(
            "drift",
            "comment_thread_mismatch",
            comment.id,
            "matching comment IDs point to different structured threads",
            [comment.threadId, githubComment.threadId],
          ),
        );
      }
    }
    for (const comment of githubIssue.comments) {
      if (
        comment.createdAtMs <= linearCutoff &&
        !linearByExternalId.has(comment.id)
      ) {
        findings.push(
          finding(
            "drift",
            "comment_sync_gap_to_linear",
            comment.id,
            "GitHub comment expected to sync has no Linear provenance match",
            [resourceKey],
          ),
        );
      }
    }
  }
  return findings;
}
