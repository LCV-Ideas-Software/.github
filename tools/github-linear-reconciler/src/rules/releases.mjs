import { finding } from "../domain/findings.mjs";

export function evaluateReleases(context) {
  const { linear, mappingByTeam, githubPullByKey, releaseRequiredAfterMs } =
    context;
  const findings = [];
  const pipelineById = new Map(
    linear.releasePipelines.map((pipeline) => [pipeline.id, pipeline]),
  );
  const invalidPipelineTeamKeys = new Set();
  for (const [teamKey, mapping] of mappingByTeam) {
    if (mapping.mode !== "github-backed") continue;
    const pipeline = pipelineById.get(mapping.linearReleasePipelineId);
    if (!pipeline) {
      invalidPipelineTeamKeys.add(teamKey);
      findings.push(
        finding(
          "incomplete",
          "configured_release_pipeline_missing",
          teamKey,
          "configured release pipeline is absent from the complete Linear snapshot",
          [mapping.linearReleasePipelineId],
        ),
      );
    } else if (pipeline.type !== "continuous") {
      invalidPipelineTeamKeys.add(teamKey);
      findings.push(
        finding(
          "incomplete",
          "configured_release_pipeline_not_continuous",
          teamKey,
          "configured release pipeline is not continuous",
          [mapping.linearReleasePipelineId, pipeline.type],
        ),
      );
    }
  }
  for (const issue of linear.issues) {
    const teamMapping = mappingByTeam.get(issue.teamKey);
    const mode = teamMapping?.mode;
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
    if (invalidPipelineTeamKeys.has(issue.teamKey)) continue;
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
      if (pull.repository !== teamMapping.repository) {
        findings.push(
          finding(
            "drift",
            "carrier_repository_mismatch",
            issue.identifier,
            "carrier repository does not match the issue team mapping",
            [pullKey, teamMapping.repository, pull.repository],
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
      const pipelineId = teamMapping.linearReleasePipelineId;
      if (!pipelineId) continue;
      const matches = issue.releases.filter(
        (release) =>
          release.commitSha === pull.mergeCommitSha &&
          release.pipelineId === pipelineId &&
          release.pipelineType === "continuous" &&
          Number.isSafeInteger(release.completedAtMs),
      );
      if (matches.some((release) => release.completedAtMs >= pull.mergedAtMs)) {
        continue;
      }
      if (matches.length > 0) {
        findings.push(
          finding(
            "incomplete",
            "release_chronology_invalid",
            issue.identifier,
            "matching release predates the carrier merge",
            [pullKey, ...matches.map((release) => release.id)],
          ),
        );
      } else {
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
