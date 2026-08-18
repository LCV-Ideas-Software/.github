import { finding } from "./findings.mjs";
import { NORMALIZED_STATUSES } from "./model.mjs";

function nonempty(value) {
  return (
    typeof value === "string" && value === value.trim() && value.length > 0
  );
}

function canonical(value) {
  return nonempty(value) && value === value.toLowerCase();
}

function sha40(value) {
  return canonical(value) && /^[0-9a-f]{40}$/u.test(value);
}

function stableUuid(value) {
  return (
    nonempty(value) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

function instant(value, nowMs) {
  return Number.isSafeInteger(value) && value >= 0 && value <= nowMs;
}

function uniqueStrings(values) {
  return (
    Array.isArray(values) &&
    values.every(nonempty) &&
    new Set(values).size === values.length
  );
}

function validFailure(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    nonempty(value.source) &&
    nonempty(value.code) &&
    nonempty(value.scope)
  );
}

function incompleteSnapshot(source, snapshot) {
  const references = Array.isArray(snapshot?.failures)
    ? snapshot.failures
        .filter(validFailure)
        .map((failure) => `${failure.source}:${failure.code}:${failure.scope}`)
    : [];
  return finding(
    "incomplete",
    `${source}_snapshot_incomplete`,
    source,
    `${source} snapshot was not completed`,
    references,
  );
}

function validLinearComment(comment, nowMs) {
  if (
    !comment ||
    !nonempty(comment.id) ||
    !["github", "linear"].includes(comment.provenance) ||
    typeof comment.connected !== "boolean" ||
    !instant(comment.createdAtMs, nowMs)
  ) {
    return false;
  }
  if (comment.provenance === "linear") {
    return (
      comment.resourceKey === null &&
      comment.externalId === null &&
      comment.threadId === null &&
      comment.connected === true
    );
  }
  return (
    canonical(comment.resourceKey) &&
    (comment.externalId === null || nonempty(comment.externalId)) &&
    comment.threadId === comment.resourceKey
  );
}

function validRelease(release, nowMs) {
  return (
    release &&
    nonempty(release.id) &&
    stableUuid(release.pipelineId) &&
    ["continuous", "scheduled"].includes(release.pipelineType) &&
    sha40(release.commitSha) &&
    instant(release.completedAtMs, nowMs)
  );
}

function validLinearIssue(issue, teamKeys, nowMs) {
  return (
    issue &&
    nonempty(issue.id) &&
    nonempty(issue.identifier) &&
    teamKeys.has(issue.teamKey) &&
    NORMALIZED_STATUSES.includes(issue.status) &&
    uniqueStrings(issue.nativeCounterpartKeys) &&
    issue.nativeCounterpartKeys.every(canonical) &&
    uniqueStrings(issue.attachmentIssueKeys) &&
    issue.attachmentIssueKeys.every(canonical) &&
    uniqueStrings(issue.insecureGithubResourceKeys) &&
    issue.insecureGithubResourceKeys.every(canonical) &&
    uniqueStrings(issue.carrierPullKeys) &&
    issue.carrierPullKeys.every(canonical) &&
    Array.isArray(issue.comments) &&
    issue.comments.every((comment) => validLinearComment(comment, nowMs)) &&
    new Set(issue.comments.map((comment) => comment.id)).size ===
      issue.comments.length &&
    Array.isArray(issue.releases) &&
    issue.releases.every((release) => validRelease(release, nowMs)) &&
    new Set(issue.releases.map((release) => release.id)).size ===
      issue.releases.length &&
    (issue.duplicateOf === null || nonempty(issue.duplicateOf)) &&
    uniqueStrings(issue.relatedIdentifiers) &&
    (issue.duplicateKey === null || nonempty(issue.duplicateKey)) &&
    uniqueStrings(issue.similarityKeys)
  );
}

function validGithubComment(comment, issueKey, nowMs) {
  return (
    comment &&
    nonempty(comment.id) &&
    comment.threadId === issueKey &&
    instant(comment.createdAtMs, nowMs)
  );
}

function validGithubIssue(issue, repositoryNames, organization, nowMs) {
  return (
    issue &&
    canonical(issue.key) &&
    repositoryNames.has(issue.repository) &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    issue.key === `${organization}/${issue.repository}#${issue.number}` &&
    NORMALIZED_STATUSES.includes(issue.status) &&
    Array.isArray(issue.comments) &&
    issue.comments.every((comment) =>
      validGithubComment(comment, issue.key, nowMs),
    )
  );
}

function validGithubPull(pull, repositoryNames, organization, nowMs) {
  const merged = pull?.mergedAtMs !== null;
  return (
    pull &&
    canonical(pull.key) &&
    repositoryNames.has(pull.repository) &&
    Number.isSafeInteger(pull.number) &&
    pull.number > 0 &&
    pull.key === `${organization}/${pull.repository}#${pull.number}` &&
    (!merged || instant(pull.mergedAtMs, nowMs)) &&
    (!merged || sha40(pull.mergeCommitSha))
  );
}

function duplicateValues(values) {
  return new Set(values).size !== values.length;
}

export function validateSnapshots(linear, github, organization, nowMs) {
  const incomplete = [];
  if (
    linear?.complete === false ||
    (linear?.complete === true && linear?.failures?.length > 0)
  )
    incomplete.push(incompleteSnapshot("linear", linear));
  if (
    github?.complete === false ||
    (github?.complete === true && github?.failures?.length > 0)
  )
    incomplete.push(incompleteSnapshot("github", github));
  if (incomplete.length > 0) return incomplete;
  const problems = [];
  if (linear?.complete !== true || github?.complete !== true) {
    problems.push("snapshot completeness flags are required");
  }
  if (
    !Array.isArray(linear?.failures) ||
    !linear.failures.every(validFailure)
  ) {
    problems.push("linear failures are invalid");
  }
  if (
    !Array.isArray(github?.failures) ||
    !github.failures.every(validFailure)
  ) {
    problems.push("github failures are invalid");
  }

  const teams = Array.isArray(linear?.teams) ? linear.teams : [];
  const teamKeys = new Set(teams.map((team) => team?.key));
  if (
    !Array.isArray(linear?.teams) ||
    teams.some(
      (team) => !nonempty(team?.key) || typeof team?.active !== "boolean",
    ) ||
    teamKeys.size !== teams.length
  ) {
    problems.push("linear teams are invalid or repeated");
  }

  const issues = Array.isArray(linear?.issues) ? linear.issues : [];
  const issueIdentifiers = new Set(issues.map((issue) => issue?.identifier));
  if (
    !Array.isArray(linear?.issues) ||
    issues.some((issue) => !validLinearIssue(issue, teamKeys, nowMs)) ||
    duplicateValues(issues.map((issue) => issue.id)) ||
    duplicateValues(issues.map((issue) => issue.identifier))
  ) {
    problems.push("linear issues are invalid or repeated");
  }
  if (
    issues.some((issue) => {
      if (!issue || !Array.isArray(issue.relatedIdentifiers)) return false;
      return (
        (issue.duplicateOf !== null &&
          (!issueIdentifiers.has(issue.duplicateOf) ||
            issue.duplicateOf === issue.identifier)) ||
        issue.relatedIdentifiers.some(
          (identifier) =>
            !issueIdentifiers.has(identifier) ||
            identifier === issue.identifier,
        )
      );
    })
  ) {
    problems.push("linear issue references are unresolved or self-referential");
  }
  for (const collection of ["cycles", "projects", "initiatives", "documents"]) {
    const entities = linear?.[collection];
    if (
      !Array.isArray(entities) ||
      entities.some(
        (entity) => !nonempty(entity?.id) || !teamKeys.has(entity?.teamKey),
      ) ||
      duplicateValues(
        (entities ?? []).map((entity) => `${entity.id}:${entity.teamKey}`),
      )
    ) {
      problems.push(`linear ${collection} are invalid or repeated`);
    }
  }

  const repositories = Array.isArray(github?.repositories)
    ? github.repositories
    : [];
  const repositoryNames = new Set(
    repositories.map((repository) => repository?.name),
  );
  if (
    !Array.isArray(github?.repositories) ||
    repositories.some(
      (repository) =>
        !canonical(repository?.name) ||
        (repository.archived !== undefined &&
          typeof repository.archived !== "boolean"),
    ) ||
    repositoryNames.size !== repositories.length
  ) {
    problems.push("github repositories are invalid or repeated");
  }
  const githubIssues = Array.isArray(github?.issues) ? github.issues : [];
  if (
    !Array.isArray(github?.issues) ||
    githubIssues.some(
      (issue) => !validGithubIssue(issue, repositoryNames, organization, nowMs),
    ) ||
    duplicateValues(githubIssues.map((issue) => issue.key))
  ) {
    problems.push("github issues are invalid or repeated");
  }
  const pulls = Array.isArray(github?.pulls) ? github.pulls : [];
  if (
    !Array.isArray(github?.pulls) ||
    pulls.some(
      (pull) => !validGithubPull(pull, repositoryNames, organization, nowMs),
    ) ||
    duplicateValues(pulls.map((pull) => pull.key))
  ) {
    problems.push("github pulls are invalid or repeated");
  }
  const githubIssueKeys = new Set(githubIssues.map((issue) => issue?.key));
  if (pulls.some((pull) => githubIssueKeys.has(pull?.key))) {
    problems.push("github resource key is both an issue and a pull");
  }

  return problems.map((problem) =>
    finding("incomplete", "normalized_snapshot_invalid", "snapshot", problem),
  );
}
