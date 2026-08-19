import { finding } from "./findings.mjs";
import { findDuplicateOfCycles } from "./duplicate-graph.mjs";
import {
  parseGithubOwner,
  parseGithubRepository,
  parseGithubResourceKey,
} from "./github-resource.mjs";
import {
  linearFailureReferences,
  validLinearFailure,
} from "./linear-failures.mjs";
import { NORMALIZED_STATUSES } from "./model.mjs";

function nonempty(value) {
  return (
    typeof value === "string" && value === value.trim() && value.length > 0
  );
}

function canonical(value) {
  return nonempty(value) && value === value.toLowerCase();
}

function githubResourceKey(value) {
  return parseGithubResourceKey(value)?.key === value;
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

function compareOpaque(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validFailure(value) {
  if (value?.source === "linear") return validLinearFailure(value);
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
        .flatMap((failure) =>
          failure.source === "linear"
            ? linearFailureReferences(failure)
            : [`${failure.source}:${failure.code}:${failure.scope}`],
        )
    : [];
  return finding(
    "incomplete",
    `${source}_snapshot_incomplete`,
    source,
    `${source} snapshot was not completed`,
    references,
  );
}

function validLinearComment(comment, capturedAtMs) {
  if (
    !comment ||
    !nonempty(comment.id) ||
    !["github", "linear"].includes(comment.provenance) ||
    typeof comment.connected !== "boolean" ||
    !instant(comment.createdAtMs, capturedAtMs) ||
    !instant(comment.updatedAtMs, capturedAtMs) ||
    comment.createdAtMs > comment.updatedAtMs
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
    githubResourceKey(comment.resourceKey) &&
    (comment.externalId === null || nonempty(comment.externalId)) &&
    comment.threadId === comment.resourceKey
  );
}

function validNativeCounterpart(counterpart) {
  return (
    counterpart &&
    githubResourceKey(counterpart.resourceKey) &&
    nonempty(counterpart.externalId)
  );
}

function validGithubThreadControl(control) {
  if (
    !control ||
    typeof control !== "object" ||
    Array.isArray(control) ||
    !nonempty(control.linearCommentId) ||
    typeof control.connected !== "boolean" ||
    !["resource", "unparseable", "absent"].includes(control.urlState)
  ) {
    return false;
  }
  return control.urlState === "resource"
    ? githubResourceKey(control.observedResourceKey)
    : control.observedResourceKey === null;
}

function validRelease(release, capturedAtMs) {
  return (
    release &&
    nonempty(release.id) &&
    stableUuid(release.pipelineId) &&
    ["continuous", "scheduled"].includes(release.pipelineType) &&
    sha40(release.commitSha) &&
    (release.completedAtMs === null ||
      instant(release.completedAtMs, capturedAtMs)) &&
    instant(release.updatedAtMs, capturedAtMs) &&
    (release.completedAtMs === null ||
      release.completedAtMs <= release.updatedAtMs) &&
    nonempty(release.issueToReleaseId) &&
    instant(release.issueToReleaseUpdatedAtMs, capturedAtMs)
  );
}

function validLinearIssue(issue, teamById, teamByKey, capturedAtMs) {
  const teamByStableId = teamById.get(issue?.teamId);
  const teamByStableKey = teamByKey.get(issue?.teamKey);
  return (
    issue &&
    nonempty(issue.id) &&
    nonempty(issue.identifier) &&
    teamByStableId !== undefined &&
    teamByStableId === teamByStableKey &&
    instant(issue.updatedAtMs, capturedAtMs) &&
    NORMALIZED_STATUSES.includes(issue.status) &&
    Array.isArray(issue.nativeCounterparts) &&
    issue.nativeCounterparts.every(validNativeCounterpart) &&
    new Set(
      issue.nativeCounterparts.map((counterpart) => counterpart.resourceKey),
    ).size === issue.nativeCounterparts.length &&
    new Set(
      issue.nativeCounterparts.map((counterpart) => counterpart.externalId),
    ).size === issue.nativeCounterparts.length &&
    uniqueStrings(issue.nativeCounterpartKeys) &&
    issue.nativeCounterpartKeys.every(githubResourceKey) &&
    issue.nativeCounterpartKeys.length === issue.nativeCounterparts.length &&
    issue.nativeCounterpartKeys.every(
      (key, index) => key === issue.nativeCounterparts[index].resourceKey,
    ) &&
    uniqueStrings(issue.attachmentIssueKeys) &&
    issue.attachmentIssueKeys.every(githubResourceKey) &&
    uniqueStrings(issue.insecureGithubResourceKeys) &&
    issue.insecureGithubResourceKeys.every(githubResourceKey) &&
    uniqueStrings(issue.carrierPullKeys) &&
    issue.carrierPullKeys.every(githubResourceKey) &&
    Array.isArray(issue.comments) &&
    issue.comments.every((comment) =>
      validLinearComment(comment, capturedAtMs),
    ) &&
    new Set(issue.comments.map((comment) => comment.id)).size ===
      issue.comments.length &&
    Array.isArray(issue.githubThreadControls) &&
    issue.githubThreadControls.every(validGithubThreadControl) &&
    new Set(
      issue.githubThreadControls.map((control) => control.linearCommentId),
    ).size === issue.githubThreadControls.length &&
    Array.isArray(issue.releases) &&
    issue.releases.every((release) => validRelease(release, capturedAtMs)) &&
    new Set(issue.releases.map((release) => release.id)).size ===
      issue.releases.length &&
    (issue.duplicateOf === null || nonempty(issue.duplicateOf)) &&
    uniqueStrings(issue.relatedIdentifiers) &&
    (issue.duplicateKey === null || nonempty(issue.duplicateKey)) &&
    uniqueStrings(issue.similarityKeys)
  );
}

function validGithubComment(comment, issueKey, capturedAtMs) {
  return (
    comment &&
    nonempty(comment.id) &&
    comment.threadId === issueKey &&
    instant(comment.createdAtMs, capturedAtMs) &&
    instant(comment.updatedAtMs, capturedAtMs) &&
    comment.createdAtMs <= comment.updatedAtMs
  );
}

function validGithubIssue(issue, repositoryNames, organization, capturedAtMs) {
  return (
    issue &&
    githubResourceKey(issue.key) &&
    nonempty(issue.nodeId) &&
    repositoryNames.has(issue.repository) &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    issue.key === `${organization}/${issue.repository}#${issue.number}` &&
    NORMALIZED_STATUSES.includes(issue.status) &&
    instant(issue.updatedAtMs, capturedAtMs) &&
    Array.isArray(issue.comments) &&
    issue.comments.every((comment) =>
      validGithubComment(comment, issue.key, capturedAtMs),
    )
  );
}

function validReleasePipeline(pipeline, capturedAtMs) {
  return (
    pipeline &&
    stableUuid(pipeline.id) &&
    ["continuous", "scheduled"].includes(pipeline.type) &&
    instant(pipeline.createdAtMs, capturedAtMs) &&
    instant(pipeline.updatedAtMs, capturedAtMs) &&
    pipeline.createdAtMs <= pipeline.updatedAtMs
  );
}

function validWorkspaceRelease(release, capturedAtMs) {
  return (
    release &&
    nonempty(release.id) &&
    stableUuid(release.pipelineId) &&
    (release.commitSha === null || sha40(release.commitSha)) &&
    (release.completedAtMs === null ||
      instant(release.completedAtMs, capturedAtMs)) &&
    instant(release.createdAtMs, capturedAtMs) &&
    instant(release.updatedAtMs, capturedAtMs) &&
    release.createdAtMs <= release.updatedAtMs &&
    (release.completedAtMs === null ||
      (release.createdAtMs <= release.completedAtMs &&
        release.completedAtMs <= release.updatedAtMs))
  );
}

function validIssueToRelease(association, capturedAtMs) {
  return (
    association &&
    nonempty(association.id) &&
    nonempty(association.issueId) &&
    nonempty(association.releaseId) &&
    instant(association.createdAtMs, capturedAtMs) &&
    instant(association.updatedAtMs, capturedAtMs) &&
    association.createdAtMs <= association.updatedAtMs
  );
}

function releaseProjectionTuple(release) {
  return [
    release?.id,
    release?.pipelineId,
    release?.pipelineType,
    release?.commitSha,
    release?.completedAtMs,
    release?.updatedAtMs,
    release?.issueToReleaseId,
    release?.issueToReleaseUpdatedAtMs,
  ];
}

function validGithubPull(pull, repositoryNames, organization, capturedAtMs) {
  const merged = pull?.mergedAtMs !== null;
  return (
    pull &&
    githubResourceKey(pull.key) &&
    repositoryNames.has(pull.repository) &&
    Number.isSafeInteger(pull.number) &&
    pull.number > 0 &&
    pull.key === `${organization}/${pull.repository}#${pull.number}` &&
    instant(pull.updatedAtMs, capturedAtMs) &&
    (!merged ||
      (instant(pull.mergedAtMs, capturedAtMs) &&
        pull.mergedAtMs <= pull.updatedAtMs)) &&
    (merged
      ? sha40(pull.mergeCommitSha)
      : pull.mergeCommitSha === null || sha40(pull.mergeCommitSha))
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

  const linearCapturedAtMs = linear?.capturedAtMs;
  const githubCapturedAtMs = github?.capturedAtMs;
  if (
    !instant(linearCapturedAtMs, nowMs) ||
    !instant(githubCapturedAtMs, nowMs) ||
    linearCapturedAtMs !== githubCapturedAtMs
  ) {
    problems.push("snapshot capturedAt boundaries are invalid or divergent");
  }
  const capturedAtMs = Number.isSafeInteger(linearCapturedAtMs)
    ? linearCapturedAtMs
    : -1;

  const teams = Array.isArray(linear?.teams) ? linear.teams : [];
  const teamById = new Map(teams.map((team) => [team?.id, team]));
  const teamByKey = new Map(teams.map((team) => [team?.key, team]));
  if (
    !Array.isArray(linear?.teams) ||
    teams.some(
      (team) =>
        !nonempty(team?.id) ||
        !nonempty(team?.key) ||
        typeof team?.active !== "boolean" ||
        !instant(team?.updatedAtMs, capturedAtMs),
    ) ||
    teamById.size !== teams.length ||
    teamByKey.size !== teams.length
  ) {
    problems.push("linear teams are invalid or repeated");
  }

  const issues = Array.isArray(linear?.issues) ? linear.issues : [];
  const issueIdentifiers = new Set(issues.map((issue) => issue?.identifier));
  const issueById = new Map(issues.map((issue) => [issue?.id, issue]));
  if (
    !Array.isArray(linear?.issues) ||
    issues.some(
      (issue) => !validLinearIssue(issue, teamById, teamByKey, capturedAtMs),
    ) ||
    issueById.size !== issues.length ||
    duplicateValues(issues.map((issue) => issue?.identifier))
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
  if (
    issues.every(
      (issue) =>
        issue &&
        nonempty(issue.identifier) &&
        (issue.duplicateOf === null || nonempty(issue.duplicateOf)),
    ) &&
    findDuplicateOfCycles(issues).length > 0
  ) {
    problems.push("linear duplicateOf graph contains a cycle");
  }
  const linearComments = issues.flatMap((issue) => issue?.comments ?? []);
  if (
    duplicateValues(linearComments.map((comment) => comment?.id)) ||
    duplicateValues(
      linearComments
        .map((comment) => comment?.externalId)
        .filter((externalId) => externalId !== null),
    )
  ) {
    problems.push("linear comment identities are not globally unique");
  }
  const githubThreadControls = issues.flatMap(
    (issue) => issue?.githubThreadControls ?? [],
  );
  const linearCommentIds = new Set(
    linearComments.map((comment) => comment?.id),
  );
  if (
    duplicateValues(
      githubThreadControls.map((control) => control?.linearCommentId),
    ) ||
    githubThreadControls.some((control) =>
      linearCommentIds.has(control?.linearCommentId),
    )
  ) {
    problems.push(
      "linear GitHub thread control identities are repeated or collide with comments",
    );
  }

  const releasePipelines = Array.isArray(linear?.releasePipelines)
    ? linear.releasePipelines
    : [];
  const pipelineById = new Map(
    releasePipelines.map((pipeline) => [pipeline?.id, pipeline]),
  );
  if (
    !Array.isArray(linear?.releasePipelines) ||
    releasePipelines.some(
      (pipeline) => !validReleasePipeline(pipeline, capturedAtMs),
    ) ||
    pipelineById.size !== releasePipelines.length
  ) {
    problems.push("linear release pipelines are invalid or repeated");
  }

  const workspaceReleases = Array.isArray(linear?.releases)
    ? linear.releases
    : [];
  const releaseById = new Map(
    workspaceReleases.map((release) => [release?.id, release]),
  );
  if (
    !Array.isArray(linear?.releases) ||
    workspaceReleases.some((release) => {
      const pipeline = pipelineById.get(release?.pipelineId);
      return (
        !validWorkspaceRelease(release, capturedAtMs) ||
        !pipeline ||
        pipeline.createdAtMs > release.createdAtMs
      );
    }) ||
    releaseById.size !== workspaceReleases.length
  ) {
    problems.push("linear releases are invalid, repeated, or unresolved");
  }

  const issueToReleases = Array.isArray(linear?.issueToReleases)
    ? linear.issueToReleases
    : [];
  const associationPairs = issueToReleases.map(
    (association) => `${association?.issueId}\0${association?.releaseId}`,
  );
  if (
    !Array.isArray(linear?.issueToReleases) ||
    issueToReleases.some((association) => {
      const release = releaseById.get(association?.releaseId);
      return (
        !validIssueToRelease(association, capturedAtMs) ||
        !issueById.has(association?.issueId) ||
        !release ||
        release.createdAtMs > association.createdAtMs
      );
    }) ||
    duplicateValues(issueToReleases.map((association) => association?.id)) ||
    duplicateValues(associationPairs)
  ) {
    problems.push(
      "linear issue-to-release associations are invalid, repeated, or unresolved",
    );
  }

  const associationsByIssueId = new Map();
  for (const association of issueToReleases) {
    const associations = associationsByIssueId.get(association.issueId) ?? [];
    associations.push(association);
    associationsByIssueId.set(association.issueId, associations);
  }

  if (
    issues.some((issue) => {
      if (!issue || !Array.isArray(issue.releases)) return false;
      const expected = (associationsByIssueId.get(issue.id) ?? [])
        .map((association) => {
          const release = releaseById.get(association.releaseId);
          const pipeline = release && pipelineById.get(release.pipelineId);
          if (!release || !pipeline || release.commitSha === null) return null;
          return {
            id: release.id,
            pipelineId: pipeline.id,
            pipelineType: pipeline.type,
            commitSha: release.commitSha,
            completedAtMs: release.completedAtMs,
            updatedAtMs: release.updatedAtMs,
            issueToReleaseId: association.id,
            issueToReleaseUpdatedAtMs: association.updatedAtMs,
          };
        })
        .filter(Boolean)
        .sort((left, right) => compareOpaque(left.id, right.id));
      const actual = [...issue.releases].sort((left, right) =>
        compareOpaque(String(left?.id), String(right?.id)),
      );
      return (
        JSON.stringify(actual.map(releaseProjectionTuple)) !==
        JSON.stringify(expected.map(releaseProjectionTuple))
      );
    })
  ) {
    problems.push(
      "linear issue release evidence is not a strict graph projection",
    );
  }

  for (const collection of ["cycles", "projects", "initiatives", "documents"]) {
    const entities = linear?.[collection];
    if (
      !Array.isArray(entities) ||
      entities.some(
        (entity) =>
          !nonempty(entity?.id) ||
          teamById.get(entity?.teamId) === undefined ||
          teamById.get(entity?.teamId) !== teamByKey.get(entity?.teamKey) ||
          !instant(entity?.updatedAtMs, capturedAtMs),
      ) ||
      duplicateValues(
        (entities ?? []).map(
          (entity) => `${entity.id}:${entity.teamId}:${entity.teamKey}`,
        ),
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
  const repositoryIds = new Set(
    repositories.map((repository) => repository?.id),
  );
  if (
    github?.organization !== organization ||
    parseGithubOwner(github?.organization) !== github?.organization ||
    !Array.isArray(github?.repositories) ||
    repositories.some(
      (repository) =>
        !Number.isSafeInteger(repository?.id) ||
        repository.id <= 0 ||
        parseGithubRepository(repository?.name) !== repository?.name ||
        repository.archived !== false ||
        typeof repository.issuesEnabled !== "boolean" ||
        typeof repository.fork !== "boolean",
    ) ||
    repositoryNames.size !== repositories.length ||
    repositoryIds.size !== repositories.length
  ) {
    problems.push("github repositories are invalid or repeated");
  }
  const githubIssues = Array.isArray(github?.issues) ? github.issues : [];
  if (
    !Array.isArray(github?.issues) ||
    githubIssues.some(
      (issue) =>
        !validGithubIssue(
          issue,
          repositoryNames,
          organization,
          githubCapturedAtMs,
        ),
    ) ||
    duplicateValues(githubIssues.map((issue) => issue?.key))
  ) {
    problems.push("github issues are invalid or repeated");
  }
  if (
    duplicateValues(
      githubIssues
        .map((issue) => issue?.nodeId)
        .filter((nodeId) => nonempty(nodeId)),
    )
  ) {
    problems.push("github issue node identities are not globally unique");
  }
  const githubIssueByKey = new Map(
    githubIssues.map((issue) => [issue?.key, issue]),
  );
  if (
    issues.some((issue) =>
      (issue?.nativeCounterparts ?? []).some((counterpart) => {
        const githubIssue = githubIssueByKey.get(counterpart.resourceKey);
        return !githubIssue || githubIssue.nodeId !== counterpart.externalId;
      }),
    )
  ) {
    problems.push(
      "linear native counterpart does not resolve the exact github issue node",
    );
  }
  const githubComments = githubIssues.flatMap((issue) => issue?.comments ?? []);
  if (duplicateValues(githubComments.map((comment) => comment?.id))) {
    problems.push("github comment identities are not globally unique");
  }
  const pulls = Array.isArray(github?.pulls) ? github.pulls : [];
  if (
    !Array.isArray(github?.pulls) ||
    pulls.some(
      (pull) =>
        !validGithubPull(
          pull,
          repositoryNames,
          organization,
          githubCapturedAtMs,
        ),
    ) ||
    duplicateValues(pulls.map((pull) => pull?.key))
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
