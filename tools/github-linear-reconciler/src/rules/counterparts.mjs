import { finding } from "../domain/findings.mjs";

export function evaluateCounterparts(context) {
  const {
    linear,
    github,
    mappingByTeam,
    mappingByRepository,
    githubIssueByKey,
  } = context;
  const findings = [];
  const teamByKey = new Map(linear.teams.map((team) => [team.key, team]));
  const teamKeys = new Set(teamByKey.keys());
  const activeRepositories = github.repositories.filter(
    (repository) => repository.archived !== true,
  );
  const repositoryNames = new Set(
    activeRepositories.map((repository) => repository.name),
  );

  for (const team of linear.teams) {
    if (team.active && !mappingByTeam.has(team.key)) {
      findings.push(
        finding(
          "incomplete",
          "team_mapping_missing",
          team.key,
          "normalized Linear team has no explicit mapping",
        ),
      );
    }
  }
  for (const mapping of mappingByTeam.values()) {
    if (!teamKeys.has(mapping.linearTeamKey)) {
      findings.push(
        finding(
          "incomplete",
          "configured_team_missing",
          mapping.linearTeamKey,
          "configured team is absent from the complete Linear snapshot",
        ),
      );
    } else if (!teamByKey.get(mapping.linearTeamKey).active) {
      findings.push(
        finding(
          "incomplete",
          "configured_team_inactive",
          mapping.linearTeamKey,
          "configured team is archived or retired in the complete Linear snapshot",
        ),
      );
    }
    if (
      mapping.mode === "github-backed" &&
      !repositoryNames.has(mapping.repository)
    ) {
      findings.push(
        finding(
          "incomplete",
          "configured_repository_missing",
          mapping.repository,
          "configured repository is absent from the complete GitHub snapshot",
        ),
      );
    }
  }
  for (const repository of activeRepositories) {
    if (!mappingByRepository.has(repository.name)) {
      findings.push(
        finding(
          "incomplete",
          "github_repository_mapping_missing",
          repository.name,
          "normalized GitHub repository has no github-backed mapping",
        ),
      );
    }
  }

  const claims = new Map();
  for (const issue of linear.issues) {
    const mapping = mappingByTeam.get(issue.teamKey);
    if (!mapping) continue;
    if (mapping.mode === "linear-only") {
      if (issue.nativeCounterpartKeys.length > 0) {
        findings.push(
          finding(
            "drift",
            "linear_only_github_counterpart",
            issue.identifier,
            "linear-only issue contains a GitHub counterpart",
            issue.nativeCounterpartKeys,
          ),
        );
      }
      continue;
    }
    if (mapping.mode !== "github-backed") continue;
    for (const key of issue.nativeCounterpartKeys) {
      const owners = claims.get(key) ?? [];
      owners.push(issue.identifier);
      claims.set(key, owners);
    }
    if (issue.nativeCounterpartKeys.length === 0) {
      findings.push(
        finding(
          "drift",
          "linear_issue_without_native_counterpart",
          issue.identifier,
          "github-backed Linear issue has no native Issues Sync counterpart",
        ),
      );
      continue;
    }
    if (issue.nativeCounterpartKeys.length > 1) {
      findings.push(
        finding(
          "drift",
          "linear_issue_multiple_native_counterparts",
          issue.identifier,
          "github-backed Linear issue has multiple native Issues Sync counterparts",
          issue.nativeCounterpartKeys,
        ),
      );
      continue;
    }
    const githubIssue = githubIssueByKey.get(issue.nativeCounterpartKeys[0]);
    if (!githubIssue) {
      findings.push(
        finding(
          "drift",
          "github_counterpart_missing",
          issue.identifier,
          "claimed GitHub counterpart is absent from the complete snapshot",
          issue.nativeCounterpartKeys,
        ),
      );
    } else if (githubIssue.repository !== mapping.repository) {
      findings.push(
        finding(
          "drift",
          "team_repository_mismatch",
          issue.identifier,
          "counterpart repository differs from the explicit team mapping",
          [githubIssue.key, mapping.repository],
        ),
      );
    }
  }

  for (const githubIssue of github.issues) {
    if (!mappingByRepository.has(githubIssue.repository)) continue;
    const owners = claims.get(githubIssue.key) ?? [];
    if (owners.length === 0) {
      findings.push(
        finding(
          "drift",
          "github_issue_without_linear_counterpart",
          githubIssue.key,
          "GitHub issue has no canonical Linear counterpart",
        ),
      );
    } else if (owners.length > 1) {
      findings.push(
        finding(
          "drift",
          "github_issue_multiple_linear_counterparts",
          githubIssue.key,
          "GitHub issue is claimed by multiple Linear counterparts",
          owners,
        ),
      );
    }
  }
  return findings;
}
