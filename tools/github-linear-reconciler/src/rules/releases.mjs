import { finding } from "../domain/findings.mjs";

export function evaluateReleases(context) {
  const {
    linear,
    mappingByTeam,
    mappingByRepository,
    githubPullByKey,
    releaseRequiredAfterMs,
  } = context;
  const findings = [];
  for (const issue of linear.issues) {
    const mode = mappingByTeam.get(issue.teamKey)?.mode;
    if (mode === "linear-only" && issue.releases.length > 0) {
      findings.push(
        finding(
          "drift",
          "linear_only_github_release",
          issue.identifier,
          "linear-only issue contains GitHub release evidence",
          issue.releases.map((release) => release.id),
        ),
      );
    }
    if (mode !== "github-backed") continue;
    for (const pullKey of issue.carrierPullKeys) {
      const pull = githubPullByKey.get(pullKey);
      if (!pull) {
        findings.push(
          finding(
            "drift",
            "carrier_pull_missing",
            issue.identifier,
            "carrier pull is absent from the complete GitHub snapshot",
            [pullKey],
          ),
        );
        continue;
      }
      if (
        pull.mergedAtMs === null ||
        pull.mergedAtMs < releaseRequiredAfterMs
      ) {
        continue;
      }
      const pipelineId = mappingByRepository.get(
        pull.repository,
      )?.linearReleasePipelineId;
      if (!pipelineId) continue;
      const matches = issue.releases.filter(
        (release) =>
          release.commitSha === pull.mergeCommitSha &&
          release.pipelineId === pipelineId &&
          release.pipelineType === "continuous",
      );
      if (matches.some((release) => release.completedAtMs < pull.mergedAtMs)) {
        findings.push(
          finding(
            "incomplete",
            "release_chronology_invalid",
            issue.identifier,
            "matching release predates the carrier merge",
            [pullKey, ...matches.map((release) => release.id)],
          ),
        );
      } else if (matches.length === 0) {
        findings.push(
          finding(
            "drift",
            "missing_release",
            issue.identifier,
            "merged carrier has no exact commit and pipeline release",
            [pullKey],
          ),
        );
      }
    }
  }
  return findings;
}
