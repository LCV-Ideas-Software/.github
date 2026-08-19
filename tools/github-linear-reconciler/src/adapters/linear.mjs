import { createHash } from "node:crypto";

import { LinearClient } from "@linear/sdk";
import { z } from "zod";

import { createCaptureWindow } from "../domain/capture-window.mjs";
import {
  buildGithubResourceKey,
  classifyGithubAttachmentUrl,
  parseGithubResourceUrl,
} from "../domain/github-resource.mjs";
import {
  LinearBoundaryError,
  linearAdapterInternalFailure,
  linearBoundaryError,
  linearBoundaryFailure,
  linearNodeFailure,
  linearNodeNormalizationError,
} from "../domain/linear-failures.mjs";

const MAX_PAGES = 1_000;
const idSchema = z.string().trim().min(1);
const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const issueReferenceSchema = z.object({ id: idSchema, identifier: idSchema });
const relationTypeSchema = z.enum([
  "blocks",
  "duplicate",
  "related",
  "similar",
]);
const releasePipelineTypeSchema = z.enum(["continuous", "scheduled"]);
const sdkNullableLifecycleTimestampSchema = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .nullish()
  .transform((value) => value ?? null);
const teamIdentitySchema = z.object({
  id: idSchema,
  key: idSchema,
  name: idSchema,
});
const teamSchema = teamIdentitySchema.extend({
  archivedAt: sdkNullableLifecycleTimestampSchema,
  retiredAt: sdkNullableLifecycleTimestampSchema,
  updatedAt: z.union([z.date(), z.iso.datetime({ offset: true })]),
});
const stateSchema = z.object({
  id: idSchema,
  name: idSchema,
  type: z.enum([
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
    "duplicate",
  ]),
});
const WORD_SEGMENTER = new Intl.Segmenter("pt-BR", { granularity: "word" });
const NON_INFORMATIVE_WORDS = new Set([
  "and",
  "com",
  "das",
  "dos",
  "for",
  "from",
  "para",
  "sem",
  "the",
  "uma",
]);

function timestampMs(value) {
  const milliseconds =
    value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw linearNodeNormalizationError("timestamp_invalid");
  return milliseconds;
}

function capturedAtTimestampMs(value) {
  const milliseconds =
    value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw linearBoundaryError("workspace", "captured_at_invalid");
  }
  return milliseconds;
}

function fallbackCapturedAtMs(value) {
  try {
    const milliseconds =
      value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : 0;
  } catch {
    return 0;
  }
}

async function readSdkRelation(load, scope) {
  try {
    return await load();
  } catch (error) {
    throw linearBoundaryError(scope, "sdk_relation_read_failed", error);
  }
}

function requiredSdkReader(owner, method, scope) {
  let reader;
  try {
    reader = owner?.[method];
  } catch (error) {
    throw linearBoundaryError(scope, "sdk_reader_missing", error);
  }
  if (typeof reader !== "function") {
    throw linearBoundaryError(scope, "sdk_reader_missing");
  }
  return reader.bind(owner);
}

function captureCeilingMs(captureBoundary) {
  return typeof captureBoundary?.currentCeilingMs === "function"
    ? captureBoundary.currentCeilingMs()
    : captureBoundary;
}

function boundedTimestampMs(value, _label, captureBoundary) {
  const milliseconds = timestampMs(value);
  if (milliseconds < 0 || milliseconds > captureCeilingMs(captureBoundary))
    throw linearNodeNormalizationError("timestamp_outside_capture_window");
  return milliseconds;
}

function canonicalLinearCommentUpdatedAtMs(createdAtMs, reportedUpdatedAtMs) {
  return Math.max(createdAtMs, reportedUpdatedAtMs);
}

function normalizeStatus(type) {
  if (type === "completed") return "completed";
  if (type === "canceled" || type === "duplicate") return "canceled";
  return "active";
}

async function collectConnection(
  load,
  normalize,
  scope,
  { failures = null, diagnosticScope = scope } = {},
) {
  let connection;
  try {
    connection = await load();
  } catch (error) {
    throw linearBoundaryError(diagnosticScope, "connection_read_failed", error);
  }
  const output = [];
  const identities = new Set();
  const cursors = new Set();
  let page = 0;
  let start = 0;
  let ordinal = 0;
  for (;;) {
    page += 1;
    if (page > MAX_PAGES)
      throw linearBoundaryError(diagnosticScope, "pagination_limit_exceeded");
    if (!connection || !Array.isArray(connection.nodes))
      throw linearBoundaryError(diagnosticScope, "connection_nodes_missing");
    const pageInfo = connection.pageInfo;
    if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean")
      throw linearBoundaryError(
        diagnosticScope,
        "connection_page_info_invalid",
      );
    for (const node of connection.nodes.slice(start)) {
      const nodeScope = `${diagnosticScope}[${ordinal}]`;
      ordinal += 1;
      try {
        const normalized = await normalize(node, { nodeScope });
        const id = normalized?.id;
        if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
          throw new TypeError("Linear normalizer returned an invalid identity");
        }
        if (identities.has(id))
          throw linearNodeNormalizationError("identity_duplicate");
        identities.add(id);
        output.push(normalized);
      } catch (error) {
        if (error instanceof LinearBoundaryError || failures === null)
          throw error;
        const normalizedFailure = linearNodeFailure(nodeScope, error);
        if (normalizedFailure === null) throw error;
        failures.push(normalizedFailure);
      }
    }
    if (!pageInfo.hasNextPage) return Object.freeze(output);
    if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor === "")
      throw linearBoundaryError(diagnosticScope, "connection_cursor_missing");
    if (cursors.has(pageInfo.endCursor))
      throw linearBoundaryError(diagnosticScope, "connection_cursor_repeated");
    cursors.add(pageInfo.endCursor);
    if (typeof connection.fetchNext !== "function")
      throw linearBoundaryError(
        diagnosticScope,
        "connection_fetch_next_missing",
      );
    const previous = connection;
    const previousLength = connection.nodes.length;
    try {
      connection = await connection.fetchNext();
    } catch (error) {
      throw linearBoundaryError(
        diagnosticScope,
        "connection_fetch_next_failed",
        error,
      );
    }
    start = connection === previous ? previousLength : 0;
  }
}

function githubDiscriminator(value) {
  return typeof value === "string" && value.toLowerCase() === "github";
}

function exactGithubIntegrationTuple(value) {
  return value?.type === "integration" && value?.subType === "github";
}

function assertNoContradictoryGithubDiscriminator(value, _label) {
  if (
    [value?.type, value?.subType].some(githubDiscriminator) &&
    !exactGithubIntegrationTuple(value)
  ) {
    throw linearNodeNormalizationError("github_discriminator_conflict");
  }
}

function githubSyncedCounterpart(entity) {
  if (String(entity?.service ?? "").toLowerCase() !== "github") return null;
  const metadata = entity?.metadata;
  const resourceKey = buildGithubResourceKey({
    owner: metadata?.owner,
    repository: metadata?.repo,
    number: metadata?.number,
  });
  if (
    typeof entity?.id !== "string" ||
    entity.id.trim() !== entity.id ||
    entity.id.length === 0 ||
    resourceKey === null
  )
    throw linearNodeNormalizationError("github_sync_invalid");
  return {
    resourceKey,
    externalId: entity.id,
  };
}

function compareOpaque(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/gu, " ")
    .trim();
}

function informativeTokens(value) {
  return [
    ...new Set(
      [...WORD_SEGMENTER.segment(normalizedText(value))]
        .filter(
          (segment) =>
            segment.isWordLike &&
            segment.segment.length >= 3 &&
            !NON_INFORMATIVE_WORDS.has(segment.segment),
        )
        .map((segment) => segment.segment),
    ),
  ].sort();
}

function informativeTitle(value) {
  const normalized = normalizedText(value);
  const tokens = informativeTokens(normalized);
  return normalized.length >= 12 && tokens.length >= 2
    ? { normalized, tokens }
    : null;
}

function informativeDescription(value) {
  const normalized = normalizedText(value);
  return normalized.length >= 24 && informativeTokens(normalized).length >= 4
    ? normalized
    : null;
}

function hashedSignal(namespace, value) {
  const digest = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest("hex");
  return `${namespace}:${digest}`;
}

function exactDuplicateKey(title, description) {
  const titleEvidence = informativeTitle(title);
  if (!titleEvidence) return null;
  const descriptionEvidence = informativeDescription(description);
  return hashedSignal(
    "exact",
    descriptionEvidence
      ? `${titleEvidence.normalized}\0${descriptionEvidence}`
      : titleEvidence.normalized,
  );
}

function similaritySignals(title, description) {
  const signals = [];
  const descriptionEvidence = informativeDescription(description);
  if (descriptionEvidence) {
    signals.push(hashedSignal("description", descriptionEvidence));
  }
  const titleEvidence = informativeTitle(title);
  if (titleEvidence) {
    signals.push(hashedSignal("title-tokens", titleEvidence.tokens.join("\0")));
  }
  return signals.sort();
}

function githubThreadUrlObservation(externalThread) {
  if (externalThread == null || externalThread.url === null) {
    return { urlState: "absent", resource: null };
  }
  const resource = parseGithubResourceUrl(externalThread?.url, {
    role: "external-thread",
  });
  if (resource?.kind !== "issue" || !resource.secure) {
    return { urlState: "unparseable", resource: null };
  }
  return {
    urlState: "resource",
    resource,
  };
}

function isGithubThreadControl({
  botActor,
  externalThread,
  externalUserId,
  githubEntity,
  parentId,
  userId,
}) {
  return (
    githubEntity === null &&
    exactGithubIntegrationTuple(botActor) &&
    botActor.userDisplayName === null &&
    exactGithubIntegrationTuple(externalThread) &&
    parentId === null &&
    userId === null &&
    externalUserId === null
  );
}

async function normalizeIssue(
  issue,
  capturedAtMs,
  failures = null,
  issueScope = "issues[0]",
) {
  const base = z
    .object({
      id: idSchema,
      identifier: idSchema,
      title: idSchema,
      description: z.string().nullable().optional(),
      updatedAt: z.union([z.date(), z.string()]),
      syncedWith: z.array(z.unknown()).nullish(),
    })
    .parse(issue);
  const updatedAtMs = boundedTimestampMs(
    base.updatedAt,
    `${base.identifier}.updatedAt`,
    capturedAtMs,
  );
  const team = teamIdentitySchema.parse(
    await readSdkRelation(() => issue.team, issueScope),
  );
  const state = stateSchema.parse(
    await readSdkRelation(() => issue.state, issueScope),
  );
  const nativeGithubEntities = (base.syncedWith ?? []).filter(
    (entity) => String(entity?.service ?? "").toLowerCase() === "github",
  );
  const nativeCounterparts = nativeGithubEntities
    .map(githubSyncedCounterpart)
    .sort(
      (left, right) =>
        compareOpaque(left.resourceKey, right.resourceKey) ||
        compareOpaque(left.externalId, right.externalId),
    );
  const nativeCounterpartKeys = nativeCounterparts.map(
    (counterpart) => counterpart.resourceKey,
  );
  if (
    new Set(nativeCounterparts.map((counterpart) => counterpart.externalId))
      .size !== nativeCounterparts.length ||
    new Set(nativeCounterpartKeys).size !== nativeCounterpartKeys.length
  ) {
    throw linearNodeNormalizationError("github_sync_duplicate");
  }
  const duplicateOfValue = await readSdkRelation(
    () => issue.duplicateOf ?? null,
    issueScope,
  );
  const duplicateOf = duplicateOfValue
    ? issueReferenceSchema.parse(duplicateOfValue)
    : null;
  const issueReaders = new Map();
  for (const method of [
    "attachments",
    "comments",
    "relations",
    "inverseRelations",
  ]) {
    issueReaders.set(
      method,
      requiredSdkReader(issue, method, `${issueScope}.${method}`),
    );
  }
  const attachments = await collectConnection(
    () => issueReaders.get("attachments")({ first: 50 }),
    async (attachment) => {
      const parsed = z
        .object({
          id: idSchema,
          title: idSchema,
          url: z.url(),
        })
        .parse(attachment);
      const classification = classifyGithubAttachmentUrl(parsed.url);
      const resource = ["github-issue", "github-pull"].includes(
        classification.kind,
      )
        ? classification.resource
        : null;
      return { id: parsed.id, resource };
    },
    `${base.identifier}.attachments`,
    {
      failures,
      diagnosticScope: `${issueScope}.attachments`,
    },
  );
  const comments = await collectConnection(
    () => issueReaders.get("comments")({ first: 50, orderBy: "createdAt" }),
    async (comment, { nodeScope: commentScope }) => {
      const parsed = z
        .object({
          id: idSchema,
          body: z.string(),
          createdAt: z.union([z.date(), z.string()]),
          updatedAt: z.union([z.date(), z.string()]),
          syncedWith: z.array(z.unknown()).nullish(),
          externalThread: z.unknown().nullish(),
          botActor: z.unknown().nullish(),
          userId: idSchema.nullish().transform((value) => value ?? null),
          externalUserId: idSchema
            .nullish()
            .transform((value) => value ?? null),
          parentId: idSchema.nullish().transform((value) => value ?? null),
        })
        .parse(comment);
      const createdAtMs = boundedTimestampMs(
        parsed.createdAt,
        `${base.identifier}.comment.createdAt`,
        capturedAtMs,
      );
      const reportedUpdatedAtMs = boundedTimestampMs(
        parsed.updatedAt,
        `${base.identifier}.comment.updatedAt`,
        capturedAtMs,
      );
      const commentUpdatedAtMs = canonicalLinearCommentUpdatedAtMs(
        createdAtMs,
        reportedUpdatedAtMs,
      );
      const githubEntities = (parsed.syncedWith ?? []).filter(
        (entity) => String(entity?.service ?? "").toLowerCase() === "github",
      );
      if (githubEntities.length > 1)
        throw linearNodeNormalizationError("comment_github_sync_ambiguous");
      const githubEntity = githubEntities[0] ?? null;
      if (
        githubEntity &&
        (typeof githubEntity.id !== "string" ||
          githubEntity.id.trim() !== githubEntity.id ||
          githubEntity.id.length === 0)
      )
        throw linearNodeNormalizationError(
          "comment_github_external_id_invalid",
        );
      const externalThread = parsed.externalThread
        ? z
            .object({
              id: idSchema.nullish().transform((value) => value ?? null),
              type: idSchema,
              subType: idSchema.nullish().transform((value) => value ?? null),
              url: z
                .string()
                .nullish()
                .transform((value) => value ?? null),
              isConnected: z.boolean(),
              isPersonalIntegrationRequired: z.boolean(),
              isPersonalIntegrationConnected: z.boolean(),
            })
            .parse(
              await readSdkRelation(() => parsed.externalThread, commentScope),
            )
        : null;
      const botActor = parsed.botActor
        ? z
            .object({
              id: idSchema.nullish(),
              type: idSchema,
              subType: idSchema.nullish(),
              userDisplayName: z
                .string()
                .nullish()
                .transform((value) => value ?? null),
            })
            .parse(await readSdkRelation(() => parsed.botActor, commentScope))
        : null;
      assertNoContradictoryGithubDiscriminator(
        externalThread,
        `${base.identifier}.comment.externalThread`,
      );
      assertNoContradictoryGithubDiscriminator(
        botActor,
        `${base.identifier}.comment.botActor`,
      );
      const threadObservation = githubThreadUrlObservation(externalThread);
      if (
        isGithubThreadControl({
          botActor,
          externalThread,
          externalUserId: parsed.externalUserId,
          githubEntity,
          parentId: parsed.parentId,
          userId: parsed.userId,
        })
      ) {
        return {
          id: parsed.id,
          kind: "control",
          value: {
            linearCommentId: parsed.id,
            connected: externalThread.isConnected,
            observedResourceKey: threadObservation.resource?.key ?? null,
            urlState: threadObservation.urlState,
          },
        };
      }

      const githubProvenance = githubEntity !== null;
      let resourceKey = null;
      if (githubProvenance) {
        if (nativeCounterpartKeys.length !== 1) {
          throw linearNodeNormalizationError("comment_github_resource_missing");
        }
        resourceKey = nativeCounterpartKeys[0];
        if (externalThread !== null) {
          if (!exactGithubIntegrationTuple(externalThread)) {
            throw linearNodeNormalizationError(
              "comment_thread_integration_conflict",
            );
          }
          if (
            externalThread.url !== null &&
            (threadObservation.urlState !== "resource" ||
              threadObservation.resource?.key !== resourceKey)
          ) {
            throw linearNodeNormalizationError(
              "comment_thread_resource_conflict",
            );
          }
        }
      }

      return {
        id: parsed.id,
        kind: "comment",
        value: {
          id: parsed.id,
          provenance: githubProvenance ? "github" : "linear",
          resourceKey,
          externalId: githubEntity?.id ?? null,
          threadId: githubProvenance ? resourceKey : null,
          connected: githubProvenance
            ? externalThread == null || externalThread.isConnected
            : true,
          createdAtMs,
          updatedAtMs: commentUpdatedAtMs,
        },
      };
    },
    `${base.identifier}.comments`,
    {
      failures,
      diagnosticScope: `${issueScope}.comments`,
    },
  );
  const relationNodes = [];
  for (const method of ["relations", "inverseRelations"]) {
    relationNodes.push(
      ...(await collectConnection(
        () => issueReaders.get(method)({ first: 50 }),
        async (relation, { nodeScope: relationScope }) => {
          const parsed = z
            .object({ id: idSchema, type: relationTypeSchema })
            .parse(relation);
          const source = await readSdkRelation(
            () => relation.issue,
            relationScope,
          );
          const target = await readSdkRelation(
            () => relation.relatedIssue,
            relationScope,
          );
          const sourceRef = issueReferenceSchema.parse(source);
          const targetRef = issueReferenceSchema.parse(target);
          const sourceOwns =
            sourceRef.id === base.id &&
            sourceRef.identifier === base.identifier;
          const targetOwns =
            targetRef.id === base.id &&
            targetRef.identifier === base.identifier;
          if (sourceOwns === targetOwns)
            throw linearNodeNormalizationError("relation_ownership_invalid");
          const other = sourceOwns ? targetRef : sourceRef;
          return {
            id: parsed.id,
            type: parsed.type,
            outgoing: sourceOwns,
            other,
          };
        },
        `${base.identifier}.${method}`,
        {
          failures,
          diagnosticScope: `${issueScope}.${method}`,
        },
      )),
    );
  }
  const attachmentResources = attachments.flatMap((attachment) =>
    attachment.resource === null ? [] : [attachment.resource],
  );
  const relatedReferences = [
    ...new Map(
      relationNodes.map((item) => [
        `${item.other.id}\0${item.other.identifier}`,
        item.other,
      ]),
    ).values(),
  ];
  const relatedIdentifiers = [
    ...new Set(relatedReferences.map((reference) => reference.identifier)),
  ].sort();
  const duplicateTargets = [
    ...new Map(
      relationNodes
        .filter(
          (relation) => relation.type === "duplicate" && relation.outgoing,
        )
        .map((relation) => [
          `${relation.other.id}\0${relation.other.identifier}`,
          relation.other,
        ]),
    ).values(),
  ];
  if (duplicateTargets.length > 1)
    throw linearNodeNormalizationError("issue_duplicate_target_ambiguous");
  if (
    duplicateOf &&
    duplicateTargets.length === 1 &&
    (duplicateTargets[0].id !== duplicateOf.id ||
      duplicateTargets[0].identifier !== duplicateOf.identifier)
  )
    throw linearNodeNormalizationError("issue_duplicate_target_conflict");
  return {
    id: base.id,
    identifier: base.identifier,
    teamId: team.id,
    teamKey: team.key,
    updatedAtMs,
    status: normalizeStatus(state.type),
    nativeCounterparts,
    nativeCounterpartKeys,
    _nativeGithubExternalIds: nativeCounterparts.map(
      (counterpart) => counterpart.externalId,
    ),
    attachmentIssueKeys: [
      ...new Set(
        attachmentResources
          .filter((resource) => resource.secure && resource.kind === "issue")
          .map((resource) => resource.key),
      ),
    ].sort(),
    carrierPullKeys: [
      ...new Set(
        attachmentResources
          .filter((resource) => resource.secure && resource.kind === "pull")
          .map((resource) => resource.key),
      ),
    ].sort(),
    insecureGithubResourceKeys: [
      ...new Set(
        attachmentResources
          .filter((resource) => !resource.secure)
          .map((resource) => resource.key),
      ),
    ].sort(),
    comments: comments
      .filter((entry) => entry.kind === "comment")
      .map((entry) => entry.value),
    githubThreadControls: comments
      .filter((entry) => entry.kind === "control")
      .map((entry) => entry.value),
    _commentIds: comments.map((comment) => comment.id),
    releases: [],
    duplicateOf:
      duplicateOf?.identifier ?? duplicateTargets[0]?.identifier ?? null,
    relatedIdentifiers,
    duplicateKey: exactDuplicateKey(base.title, base.description),
    similarityKeys: similaritySignals(base.title, base.description),
    _duplicateOfReference: duplicateOf ?? duplicateTargets[0] ?? null,
    _relatedReferences: relatedReferences,
  };
}

function finalizeIssueReferences(issues) {
  const issueById = new Map();
  const issueByIdentifier = new Map();
  const githubCommentByExternalId = new Map();
  const githubIssueByExternalId = new Map();
  const linearCommentById = new Map();
  for (const issue of issues) {
    if (issueById.has(issue.id))
      throw linearBoundaryError("issues", "issue_identity_duplicate");
    if (issueByIdentifier.has(issue.identifier))
      throw linearBoundaryError("issues", "issue_identifier_duplicate");
    issueById.set(issue.id, issue);
    issueByIdentifier.set(issue.identifier, issue);
    for (const externalId of issue._nativeGithubExternalIds) {
      const previous = githubIssueByExternalId.get(externalId);
      if (previous)
        throw linearBoundaryError(
          "issues",
          "native_github_issue_identity_duplicate",
        );
      githubIssueByExternalId.set(externalId, issue.identifier);
    }
    for (const commentId of issue._commentIds) {
      const previous = linearCommentById.get(commentId);
      if (previous)
        throw linearBoundaryError(
          "issues",
          "linear_comment_identity_duplicate",
        );
      linearCommentById.set(commentId, issue.identifier);
    }
    for (const comment of issue.comments) {
      if (comment.externalId === null) continue;
      const previous = githubCommentByExternalId.get(comment.externalId);
      if (previous)
        throw linearBoundaryError(
          "issues",
          "github_comment_identity_duplicate",
        );
      githubCommentByExternalId.set(comment.externalId, issue.identifier);
    }
  }

  function resolve(reference, owner) {
    const byId = issueById.get(reference.id);
    const byIdentifier = issueByIdentifier.get(reference.identifier);
    if (!byId || byId !== byIdentifier) {
      throw linearBoundaryError("issues", "issue_reference_unresolved");
    }
    return byId;
  }

  return Object.freeze(
    issues.map((issue) => {
      for (const reference of issue._relatedReferences) {
        resolve(reference, issue.identifier);
      }
      if (issue._duplicateOfReference) {
        const duplicateTarget = resolve(
          issue._duplicateOfReference,
          issue.identifier,
        );
        if (duplicateTarget === issue)
          throw linearBoundaryError("issues", "issue_duplicate_self_reference");
      }
      const {
        _commentIds: _discardCommentIds,
        _duplicateOfReference: _discardDuplicateOfReference,
        _nativeGithubExternalIds: _discardNativeGithubExternalIds,
        _relatedReferences: _discardRelatedReferences,
        ...normalized
      } = issue;
      return Object.freeze(normalized);
    }),
  );
}

function boundedEntityTimes(entity, scope, capturedAtMs) {
  const parsed = z
    .object({
      createdAt: z.union([z.date(), z.string()]),
      updatedAt: z.union([z.date(), z.string()]),
    })
    .parse(entity);
  const createdAtMs = boundedTimestampMs(
    parsed.createdAt,
    `${scope}.createdAt`,
    capturedAtMs,
  );
  const updatedAtMs = boundedTimestampMs(
    parsed.updatedAt,
    `${scope}.updatedAt`,
    capturedAtMs,
  );
  if (createdAtMs > updatedAtMs)
    throw linearNodeNormalizationError("entity_chronology_invalid");
  return { createdAtMs, updatedAtMs };
}

async function normalizeReleaseGraph(client, capturedAtMs, issues, failures) {
  const readers = new Map();
  for (const method of ["releasePipelines", "releases", "issueToReleases"]) {
    readers.set(method, requiredSdkReader(client, method, method));
  }

  const releasePipelines = await collectConnection(
    () => readers.get("releasePipelines")({ first: 50 }),
    async (pipeline) => {
      const parsed = z
        .object({ id: uuidSchema, type: releasePipelineTypeSchema })
        .parse(pipeline);
      const times = boundedEntityTimes(
        pipeline,
        `releasePipelines.${parsed.id}`,
        capturedAtMs,
      );
      return { id: parsed.id, type: parsed.type, ...times };
    },
    "releasePipelines",
    { failures, diagnosticScope: "releasePipelines" },
  );

  const releases = await collectConnection(
    () => readers.get("releases")({ first: 50 }),
    async (release) => {
      const parsed = z
        .object({
          id: idSchema,
          pipelineId: uuidSchema,
          commitSha: z
            .string()
            .regex(/^[0-9a-f]{40}$/iu)
            .nullish(),
          completedAt: z.union([z.date(), z.string()]).nullish(),
        })
        .parse(release);
      const times = boundedEntityTimes(
        release,
        `releases.${parsed.id}`,
        capturedAtMs,
      );
      const completedAtMs =
        parsed.completedAt == null
          ? null
          : boundedTimestampMs(
              parsed.completedAt,
              `releases.${parsed.id}.completedAt`,
              capturedAtMs,
            );
      if (completedAtMs !== null && completedAtMs < times.createdAtMs)
        throw linearNodeNormalizationError(
          "release_completion_chronology_invalid",
        );
      return {
        id: parsed.id,
        pipelineId: parsed.pipelineId,
        commitSha: parsed.commitSha?.toLowerCase() ?? null,
        completedAtMs,
        ...times,
      };
    },
    "releases",
    { failures, diagnosticScope: "releases" },
  );

  const issueToReleases = await collectConnection(
    () => readers.get("issueToReleases")({ first: 50 }),
    async (association) => {
      const parsed = z
        .object({
          id: idSchema,
          issueId: idSchema,
          releaseId: idSchema,
        })
        .parse(association);
      return {
        id: parsed.id,
        issueId: parsed.issueId,
        releaseId: parsed.releaseId,
        ...boundedEntityTimes(
          association,
          `issueToReleases.${parsed.id}`,
          capturedAtMs,
        ),
      };
    },
    "issueToReleases",
    { failures, diagnosticScope: "issueToReleases" },
  );

  if (failures.length > 0) {
    return {
      issues: Object.freeze([]),
      releasePipelines: Object.freeze([]),
      releases: Object.freeze([]),
      issueToReleases: Object.freeze([]),
    };
  }

  const pipelineById = new Map(
    releasePipelines.map((pipeline) => [pipeline.id, pipeline]),
  );
  const releaseById = new Map(releases.map((release) => [release.id, release]));
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  for (const release of releases) {
    const pipeline = pipelineById.get(release.pipelineId);
    if (!pipeline)
      throw linearBoundaryError("releases", "release_pipeline_unresolved");
  }
  const associationPairs = new Set();
  for (const association of issueToReleases) {
    if (!issueById.has(association.issueId))
      throw linearBoundaryError(
        "issueToReleases",
        "issue_release_issue_unresolved",
      );
    const release = releaseById.get(association.releaseId);
    if (!release)
      throw linearBoundaryError(
        "issueToReleases",
        "issue_release_release_unresolved",
      );
    if (release.createdAtMs > association.createdAtMs)
      throw linearBoundaryError(
        "issueToReleases",
        "issue_release_precedes_release",
      );
    const pair = `${association.issueId}\0${association.releaseId}`;
    if (associationPairs.has(pair))
      throw linearBoundaryError(
        "issueToReleases",
        "issue_release_association_duplicate",
      );
    associationPairs.add(pair);
  }

  const associationsByIssueId = new Map();
  for (const association of issueToReleases) {
    const associations = associationsByIssueId.get(association.issueId) ?? [];
    associations.push(association);
    associationsByIssueId.set(association.issueId, associations);
  }
  const issuesWithReleases = Object.freeze(
    issues.map((issue) => {
      const issueReleases = (associationsByIssueId.get(issue.id) ?? [])
        .map((association) => {
          const release = releaseById.get(association.releaseId);
          if (release.commitSha === null) return null;
          const pipeline = pipelineById.get(release.pipelineId);
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
      return Object.freeze({
        ...issue,
        releases: Object.freeze(issueReleases),
      });
    }),
  );

  return {
    issues: issuesWithReleases,
    releasePipelines: Object.freeze(releasePipelines.map(Object.freeze)),
    releases: Object.freeze(releases.map(Object.freeze)),
    issueToReleases: Object.freeze(issueToReleases.map(Object.freeze)),
  };
}

async function normalizeTopology(
  client,
  method,
  scope,
  capturedAtMs,
  { teamRequired = false, failures = null } = {},
) {
  const reader = requiredSdkReader(client, method, scope);
  return collectConnection(
    () => reader({ first: 50, includeArchived: true }),
    async (entity, { nodeScope }) => {
      const parsed = z
        .object({
          id: idSchema,
          updatedAt: z.union([z.date(), z.string()]),
        })
        .parse(entity);
      const updatedAtMs = boundedTimestampMs(
        parsed.updatedAt,
        `${scope}.${parsed.id}.updatedAt`,
        capturedAtMs,
      );
      const team = await readSdkRelation(
        () => entity.team ?? entity.leadTeam ?? null,
        nodeScope,
      );
      if (team == null) {
        if (teamRequired)
          throw linearNodeNormalizationError("topology_team_missing");
        return {
          id: parsed.id,
          teamId: null,
          teamKey: null,
          updatedAtMs,
        };
      }
      const parsedTeam = teamIdentitySchema.parse(team);
      return {
        id: parsed.id,
        teamId: parsedTeam.id,
        teamKey: parsedTeam.key,
        updatedAtMs,
      };
    },
    scope,
    { failures, diagnosticScope: scope },
  ).then((entities) =>
    Object.freeze(entities.filter((entity) => entity.teamKey !== null)),
  );
}

async function normalizeProjects(client, capturedAtMs, failures) {
  const projectsReader = requiredSdkReader(client, "projects", "projects");
  const projects = await collectConnection(
    () => projectsReader({ first: 50, includeArchived: true }),
    async (project, { nodeScope }) => {
      const parsed = z
        .object({
          id: idSchema,
          updatedAt: z.union([z.date(), z.string()]),
        })
        .parse(project);
      const updatedAtMs = boundedTimestampMs(
        parsed.updatedAt,
        `projects.${parsed.id}.updatedAt`,
        capturedAtMs,
      );
      const teamsReader = requiredSdkReader(
        project,
        "teams",
        `${nodeScope}.teams`,
      );
      return { id: parsed.id, teamsReader, updatedAtMs, nodeScope };
    },
    "projects",
    { failures, diagnosticScope: "projects" },
  );
  const associations = [];
  for (const { id, teamsReader, updatedAtMs, nodeScope } of projects) {
    const teams = await collectConnection(
      () => teamsReader({ first: 50 }),
      async (team) => teamIdentitySchema.parse(team),
      `projects.${id}.teams`,
      { failures, diagnosticScope: `${nodeScope}.teams` },
    );
    for (const team of teams)
      associations.push({
        id,
        teamId: team.id,
        teamKey: team.key,
        updatedAtMs,
      });
  }
  return Object.freeze(associations.map(Object.freeze));
}

function assertTeamReferences(teams, issues, collections) {
  const teamById = new Map();
  const teamByKey = new Map();
  for (const team of teams) {
    if (teamById.has(team.id))
      throw linearBoundaryError("teams", "team_identity_duplicate");
    if (teamByKey.has(team.key))
      throw linearBoundaryError("teams", "team_key_duplicate");
    teamById.set(team.id, team);
    teamByKey.set(team.key, team);
  }

  function resolve(teamId, teamKey, owner) {
    const byId = teamById.get(teamId);
    const byKey = teamByKey.get(teamKey);
    if (!byId || byId !== byKey)
      throw linearBoundaryError("workspace", "team_reference_unresolved");
  }

  for (const issue of issues) {
    resolve(issue.teamId, issue.teamKey, issue.identifier);
  }
  for (const [scope, entities] of Object.entries(collections)) {
    for (const entity of entities) {
      resolve(entity.teamId, entity.teamKey, `${scope}.${entity.id}`);
    }
  }
}

function captureMetadata(
  captureWindow,
  { close = false, tolerateClockFailure = false } = {},
) {
  if (typeof captureWindow?.lastCeilingMs !== "function") {
    return {
      captureStartedAtMs: captureWindow,
      capturedAtMs: captureWindow,
    };
  }
  let capturedAtMs = captureWindow.lastCeilingMs();
  if (close) {
    try {
      capturedAtMs = captureWindow.closeMs();
    } catch (error) {
      if (!tolerateClockFailure) throw error;
    }
  }
  return {
    captureStartedAtMs: captureWindow.captureStartedAtMs,
    capturedAtMs,
  };
}

function incompleteSnapshot(captureWindow, failures, { close = false } = {}) {
  const stableFailures = [...failures].sort(
    (left, right) =>
      compareOpaque(left.scope, right.scope) ||
      compareOpaque(left.code, right.code) ||
      compareOpaque(
        JSON.stringify(left.reasonCodes ?? []),
        JSON.stringify(right.reasonCodes ?? []),
      ) ||
      compareOpaque(left.message, right.message),
  );
  return Object.freeze({
    complete: false,
    failures: Object.freeze(stableFailures.map(Object.freeze)),
    ...captureMetadata(captureWindow, {
      close,
      tolerateClockFailure: true,
    }),
    teams: Object.freeze([]),
    issues: Object.freeze([]),
    cycles: Object.freeze([]),
    projects: Object.freeze([]),
    initiatives: Object.freeze([]),
    documents: Object.freeze([]),
    releasePipelines: Object.freeze([]),
    releases: Object.freeze([]),
    issueToReleases: Object.freeze([]),
  });
}

/** @returns {{readWorkspaceSnapshot(options:{capturedAt:string}):Promise<import('../domain/model.mjs').NormalizedLinearSnapshot>}} */
export function createLinearAdapter({ apiKey, clientFactory, clock } = {}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "")
    throw new Error("apiKey Linear somente leitura obrigatoria");
  const client = clientFactory
    ? clientFactory({ apiKey })
    : new LinearClient({ apiKey });

  async function readWorkspaceSnapshot({ capturedAt }) {
    let captureWindow;
    try {
      captureWindow = createCaptureWindow({
        startedAt: capturedAtTimestampMs(capturedAt),
        clock,
      });
      const capturedAtMs = captureWindow;
      const normalizationFailures = [];
      const teamsDetailed = await collectConnection(
        () => client.teams({ first: 50, includeArchived: true }),
        async (team) => {
          const parsed = teamSchema.parse(team);
          const updatedAtMs = boundedTimestampMs(
            parsed.updatedAt,
            `team.${parsed.key}.updatedAt`,
            capturedAtMs,
          );
          for (const field of ["archivedAt", "retiredAt"]) {
            if (parsed[field] != null)
              boundedTimestampMs(
                parsed[field],
                `team.${parsed.key}.${field}`,
                capturedAtMs,
              );
          }
          return {
            ...parsed,
            active: parsed.archivedAt === null && parsed.retiredAt === null,
            updatedAtMs,
          };
        },
        "teams",
        { failures: normalizationFailures, diagnosticScope: "teams" },
      );
      const issuesRaw = await collectConnection(
        () => client.issues({ first: 50, includeArchived: true }),
        (issue, { nodeScope }) =>
          normalizeIssue(issue, capturedAtMs, normalizationFailures, nodeScope),
        "issues",
        { failures: normalizationFailures, diagnosticScope: "issues" },
      );
      const cycles = await normalizeTopology(
        client,
        "cycles",
        "cycles",
        capturedAtMs,
        {
          teamRequired: true,
          failures: normalizationFailures,
        },
      );
      const projects = await normalizeProjects(
        client,
        capturedAtMs,
        normalizationFailures,
      );
      const initiatives = await normalizeTopology(
        client,
        "initiatives",
        "initiatives",
        capturedAtMs,
        { failures: normalizationFailures },
      );
      const documents = await normalizeTopology(
        client,
        "documents",
        "documents",
        capturedAtMs,
        { failures: normalizationFailures },
      );
      if (normalizationFailures.length > 0) {
        return incompleteSnapshot(captureWindow, normalizationFailures, {
          close: true,
        });
      }

      const issuesWithoutReleases = finalizeIssueReferences(issuesRaw);
      const releaseGraph = await normalizeReleaseGraph(
        client,
        capturedAtMs,
        issuesWithoutReleases,
        normalizationFailures,
      );
      if (normalizationFailures.length > 0) {
        return incompleteSnapshot(captureWindow, normalizationFailures, {
          close: true,
        });
      }
      const issues = releaseGraph.issues;
      assertTeamReferences(teamsDetailed, issues, {
        cycles,
        projects,
        initiatives,
        documents,
      });
      return Object.freeze({
        complete: true,
        failures: Object.freeze([]),
        ...captureMetadata(captureWindow, { close: true }),
        teams: Object.freeze(
          teamsDetailed.map((team) =>
            Object.freeze({
              id: team.id,
              key: team.key,
              active: team.active,
              updatedAtMs: team.updatedAtMs,
            }),
          ),
        ),
        issues,
        cycles,
        projects,
        initiatives,
        documents,
        releasePipelines: releaseGraph.releasePipelines,
        releases: releaseGraph.releases,
        issueToReleases: releaseGraph.issueToReleases,
      });
    } catch (error) {
      const fallbackCapturedAt = fallbackCapturedAtMs(capturedAt);
      return incompleteSnapshot(
        captureWindow ?? fallbackCapturedAt,
        [linearBoundaryFailure(error) ?? linearAdapterInternalFailure()],
        { close: true },
      );
    }
  }

  return Object.freeze({ readWorkspaceSnapshot });
}

export async function readLinearSnapshot({
  token,
  capturedAt = new Date().toISOString(),
  clock,
} = {}) {
  return createLinearAdapter({ apiKey: token, clock }).readWorkspaceSnapshot({
    capturedAt,
  });
}
