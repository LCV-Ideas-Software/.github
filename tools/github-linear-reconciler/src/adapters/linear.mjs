import { createHash } from "node:crypto";

import { LinearClient } from "@linear/sdk";
import { z } from "zod";

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
const teamIdentitySchema = z.object({
  id: idSchema,
  key: idSchema,
  name: idSchema,
});
const teamSchema = teamIdentitySchema.extend({
  archivedAt: z.union([z.date(), z.iso.datetime({ offset: true })]).nullable(),
  retiredAt: z.union([z.date(), z.iso.datetime({ offset: true })]).nullable(),
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

function failure(error, scope = "workspace") {
  return {
    source: "linear",
    code: "boundary_invalid",
    scope,
    message: error instanceof Error ? error.message : String(error),
  };
}

function timestampMs(value, label) {
  const milliseconds =
    value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Error(`${label}: timestamp invalido`);
  return milliseconds;
}

function boundedTimestampMs(value, label, capturedAtMs) {
  const milliseconds = timestampMs(value, label);
  if (milliseconds < 0 || milliseconds > capturedAtMs)
    throw new Error(`${label}: fora da janela capturedAt`);
  return milliseconds;
}

function normalizeStatus(type) {
  if (type === "completed") return "completed";
  if (type === "canceled" || type === "duplicate") return "canceled";
  return "active";
}

async function collectConnection(load, normalize, scope) {
  let connection = await load();
  const output = [];
  const identities = new Set();
  const cursors = new Set();
  let page = 0;
  let start = 0;
  for (;;) {
    page += 1;
    if (page > MAX_PAGES)
      throw new Error(`${scope}: paginacao excedeu o limite`);
    if (!connection || !Array.isArray(connection.nodes))
      throw new Error(`${scope}: nodes ausentes`);
    const pageInfo = connection.pageInfo;
    if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean")
      throw new Error(`${scope}: pageInfo invalido`);
    for (const node of connection.nodes.slice(start)) {
      const normalized = await normalize(node);
      const id = idSchema.parse(normalized.id);
      if (identities.has(id))
        throw new Error(`${scope}: identidade duplicada ${id}`);
      identities.add(id);
      output.push(normalized);
    }
    if (!pageInfo.hasNextPage) return Object.freeze(output);
    if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor === "")
      throw new Error(`${scope}: cursor ausente`);
    if (cursors.has(pageInfo.endCursor))
      throw new Error(`${scope}: cursor repetido`);
    cursors.add(pageInfo.endCursor);
    if (typeof connection.fetchNext !== "function")
      throw new Error(`${scope}: fetchNext ausente`);
    const previous = connection;
    const previousLength = connection.nodes.length;
    connection = await connection.fetchNext();
    start = connection === previous ? previousLength : 0;
  }
}

function parseGithubResource(raw) {
  if (typeof raw !== "string") return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.hostname.toLowerCase() !== "github.com"
  )
    return null;
  const match =
    /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/(issues|pull)\/([1-9]\d*)\/?$/u.exec(
      url.pathname,
    );
  if (!match) return null;
  return {
    kind: match[3] === "pull" ? "pull" : "issue",
    key: `${match[1]}/${match[2]}#${match[4]}`.toLowerCase(),
    secure:
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "",
  };
}

function githubDiscriminator(value) {
  return typeof value === "string" && value.toLowerCase() === "github";
}

function exactGithubIntegrationTuple(value) {
  return value?.type === "integration" && value?.subType === "github";
}

function assertNoContradictoryGithubDiscriminator(value, label) {
  if (
    [value?.type, value?.subType].some(githubDiscriminator) &&
    !exactGithubIntegrationTuple(value)
  ) {
    throw new Error(`${label}: discriminadores GitHub contraditorios`);
  }
}

function hasGithubHostname(raw) {
  if (typeof raw !== "string") return false;
  try {
    return new URL(raw).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

function structuredCommentClaimsGithub(
  externalThread,
  threadResource,
  botActor,
) {
  return Boolean(
    threadResource ||
    hasGithubHostname(externalThread?.url) ||
    [externalThread?.type, externalThread?.subType].some(githubDiscriminator) ||
    [botActor?.type, botActor?.subType].some(githubDiscriminator),
  );
}

function isStructuredGithubAnchor({
  githubEntity,
  botActor,
  externalThread,
  externalUser,
  expectedCounterpartKey,
  parentId,
  threadResource,
}) {
  return Boolean(
    githubEntity == null &&
    exactGithubIntegrationTuple(botActor) &&
    externalThread &&
    typeof externalThread.id === "string" &&
    externalThread.id.trim() === externalThread.id &&
    externalThread.id.length > 0 &&
    exactGithubIntegrationTuple(externalThread) &&
    externalThread.isConnected === true &&
    threadResource?.kind === "issue" &&
    threadResource.secure === true &&
    threadResource.key === expectedCounterpartKey &&
    externalUser === null &&
    parentId === null,
  );
}

function canonicalExternalNumber(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return value;
  }
  return null;
}

function githubSyncedKey(entity) {
  if (String(entity?.service ?? "").toLowerCase() !== "github") return null;
  const metadata = entity?.metadata;
  const number = canonicalExternalNumber(metadata?.number);
  if (
    typeof entity?.id !== "string" ||
    entity.id.trim() !== entity.id ||
    entity.id.length === 0 ||
    typeof metadata?.owner !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(metadata.owner) ||
    typeof metadata?.repo !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(metadata.repo) ||
    number === null
  )
    throw new Error("syncedWith GitHub invalido");
  return `${metadata.owner}/${metadata.repo}#${number}`.toLowerCase();
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

async function normalizeIssue(issue, capturedAtMs) {
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
  const team = teamIdentitySchema.parse(await Promise.resolve(issue.team));
  const state = stateSchema.parse(await Promise.resolve(issue.state));
  const nativeGithubEntities = (base.syncedWith ?? []).filter(
    (entity) => String(entity?.service ?? "").toLowerCase() === "github",
  );
  const nativeCounterparts = nativeGithubEntities.map(githubSyncedKey);
  if (
    new Set(nativeGithubEntities.map((entity) => entity.id)).size !==
      nativeGithubEntities.length ||
    new Set(nativeCounterparts).size !== nativeCounterparts.length
  ) {
    throw new Error(`${base.identifier}: sync GitHub nativo duplicado`);
  }
  const duplicateOfValue = await Promise.resolve(issue.duplicateOf ?? null);
  const duplicateOf = duplicateOfValue
    ? issueReferenceSchema.parse(duplicateOfValue)
    : null;
  for (const method of [
    "attachments",
    "comments",
    "relations",
    "inverseRelations",
    "releases",
  ]) {
    if (typeof issue[method] !== "function")
      throw new Error(`${base.identifier}.${method}: SDK reader ausente`);
  }
  const attachments = await collectConnection(
    () => issue.attachments({ first: 50 }),
    async (attachment) => {
      const parsed = z
        .object({ id: idSchema, title: idSchema, url: z.url() })
        .parse(attachment);
      return parsed;
    },
    `${base.identifier}.attachments`,
  );
  const comments = await collectConnection(
    () => issue.comments({ first: 50, orderBy: "createdAt" }),
    async (comment) => {
      const parsed = z
        .object({
          id: idSchema,
          body: z.string(),
          createdAt: z.union([z.date(), z.string()]),
          updatedAt: z.union([z.date(), z.string()]),
          syncedWith: z.array(z.unknown()).nullish(),
          externalThread: z.unknown().nullish(),
          botActor: z.unknown().nullish(),
          externalUser: z.unknown().nullish(),
          parentId: idSchema.nullable().optional(),
        })
        .parse(comment);
      const createdAtMs = boundedTimestampMs(
        parsed.createdAt,
        `${base.identifier}.comment.createdAt`,
        capturedAtMs,
      );
      const commentUpdatedAtMs = boundedTimestampMs(
        parsed.updatedAt,
        `${base.identifier}.comment.updatedAt`,
        capturedAtMs,
      );
      if (createdAtMs > commentUpdatedAtMs)
        throw new Error(
          `${base.identifier}.comment: createdAt posterior a updatedAt`,
        );
      const githubEntities = (parsed.syncedWith ?? []).filter(
        (entity) => String(entity?.service ?? "").toLowerCase() === "github",
      );
      if (githubEntities.length > 1)
        throw new Error(`${base.identifier}.comment: sync GitHub ambiguo`);
      const githubEntity = githubEntities[0] ?? null;
      if (
        githubEntity &&
        (typeof githubEntity.id !== "string" ||
          githubEntity.id.trim() !== githubEntity.id ||
          githubEntity.id.length === 0)
      )
        throw new Error(
          `${base.identifier}.comment: externalId GitHub invalido`,
        );
      const externalThread = parsed.externalThread
        ? z
            .object({
              id: idSchema.nullish(),
              type: idSchema.optional(),
              subType: idSchema.nullish(),
              url: z.string().nullish(),
              isConnected: z.boolean().optional(),
            })
            .parse(await Promise.resolve(parsed.externalThread))
        : null;
      const botActor = parsed.botActor
        ? z
            .object({
              id: idSchema.nullish(),
              type: idSchema,
              subType: idSchema.nullish(),
            })
            .parse(await Promise.resolve(parsed.botActor))
        : null;
      const externalUser =
        parsed.externalUser === undefined
          ? undefined
          : await Promise.resolve(parsed.externalUser);
      const threadResource = parseGithubResource(externalThread?.url);
      assertNoContradictoryGithubDiscriminator(
        externalThread,
        `${base.identifier}.comment.externalThread`,
      );
      assertNoContradictoryGithubDiscriminator(
        botActor,
        `${base.identifier}.comment.botActor`,
      );
      if (
        structuredCommentClaimsGithub(
          externalThread,
          threadResource,
          botActor,
        ) &&
        (!threadResource || !threadResource.secure)
      )
        throw new Error(
          `${base.identifier}.comment.externalThread: URL GitHub nao canonica`,
        );
      const integrationAnchor = isStructuredGithubAnchor({
        githubEntity,
        botActor,
        externalThread,
        externalUser,
        expectedCounterpartKey:
          nativeCounterparts.length === 1 ? nativeCounterparts[0] : null,
        parentId: parsed.parentId,
        threadResource,
      });
      if (integrationAnchor) return { id: parsed.id, ignored: true };
      const resourceKey =
        threadResource?.kind === "issue"
          ? threadResource.key
          : githubEntity && nativeCounterparts.length === 1
            ? nativeCounterparts[0]
            : null;
      const githubProvenance = Boolean(githubEntity || threadResource);
      if (githubProvenance && resourceKey === null)
        throw new Error(`${base.identifier}.comment: recurso GitHub ausente`);
      return {
        id: parsed.id,
        provenance: githubProvenance ? "github" : "linear",
        resourceKey,
        externalId: githubEntity?.id ?? null,
        threadId: githubProvenance ? resourceKey : null,
        connected: githubProvenance
          ? externalThread == null || externalThread.isConnected === true
          : true,
        createdAtMs,
        updatedAtMs: commentUpdatedAtMs,
      };
    },
    `${base.identifier}.comments`,
  );
  const relationNodes = [];
  for (const method of ["relations", "inverseRelations"]) {
    relationNodes.push(
      ...(await collectConnection(
        () => issue[method]({ first: 50 }),
        async (relation) => {
          const parsed = z
            .object({ id: idSchema, type: relationTypeSchema })
            .parse(relation);
          const source = await Promise.resolve(relation.issue);
          const target = await Promise.resolve(relation.relatedIssue);
          const sourceRef = issueReferenceSchema.parse(source);
          const targetRef = issueReferenceSchema.parse(target);
          const sourceOwns =
            sourceRef.id === base.id &&
            sourceRef.identifier === base.identifier;
          const targetOwns =
            targetRef.id === base.id &&
            targetRef.identifier === base.identifier;
          if (sourceOwns === targetOwns)
            throw new Error(`${base.identifier}.${method}: ownership invalido`);
          const other = sourceOwns ? targetRef : sourceRef;
          return {
            id: parsed.id,
            type: parsed.type,
            outgoing: sourceOwns,
            other,
          };
        },
        `${base.identifier}.${method}`,
      )),
    );
  }
  const releases = await collectConnection(
    () => issue.releases({ first: 50 }),
    async (release) => {
      const parsed = z
        .object({
          id: idSchema,
          commitSha: z
            .string()
            .regex(/^[0-9a-f]{40}$/iu)
            .nullish(),
          completedAt: z.union([z.date(), z.string()]).nullish(),
        })
        .parse(release);
      if (!parsed.commitSha) return { id: parsed.id, ignored: true };
      const pipelineValue = await Promise.resolve(release.pipeline);
      if (pipelineValue == null) return { id: parsed.id, ignored: true };
      const pipeline = z
        .object({
          id: uuidSchema,
          type: releasePipelineTypeSchema,
        })
        .parse(pipelineValue);
      return {
        id: parsed.id,
        pipelineId: pipeline.id,
        pipelineType: pipeline.type,
        commitSha: parsed.commitSha.toLowerCase(),
        completedAtMs:
          parsed.completedAt == null
            ? null
            : boundedTimestampMs(
                parsed.completedAt,
                `${base.identifier}.release.completedAt`,
                capturedAtMs,
              ),
      };
    },
    `${base.identifier}.releases`,
  );
  const attachmentResources = attachments
    .map((attachment) => parseGithubResource(attachment.url))
    .filter(Boolean);
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
    throw new Error(`${base.identifier}: duplicateOf ambiguo`);
  if (
    duplicateOf &&
    duplicateTargets.length === 1 &&
    (duplicateTargets[0].id !== duplicateOf.id ||
      duplicateTargets[0].identifier !== duplicateOf.identifier)
  )
    throw new Error(`${base.identifier}: duplicateOf contraditorio`);
  return {
    id: base.id,
    identifier: base.identifier,
    teamId: team.id,
    teamKey: team.key,
    updatedAtMs,
    status: normalizeStatus(state.type),
    nativeCounterpartKeys: [...new Set(nativeCounterparts)].sort(),
    _nativeGithubExternalIds: nativeGithubEntities.map((entity) => entity.id),
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
    comments: comments.filter((comment) => !comment.ignored),
    _commentIds: comments.map((comment) => comment.id),
    releases: releases.filter((release) => !release.ignored),
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
      throw new Error(`issues: identidade duplicada ${issue.id}`);
    if (issueByIdentifier.has(issue.identifier))
      throw new Error(`issues: identifier duplicado ${issue.identifier}`);
    issueById.set(issue.id, issue);
    issueByIdentifier.set(issue.identifier, issue);
    for (const externalId of issue._nativeGithubExternalIds) {
      const previous = githubIssueByExternalId.get(externalId);
      if (previous)
        throw new Error(
          `${issue.identifier}: externalId GitHub nativo duplicado ${externalId} (tambem em ${previous})`,
        );
      githubIssueByExternalId.set(externalId, issue.identifier);
    }
    for (const commentId of issue._commentIds) {
      const previous = linearCommentById.get(commentId);
      if (previous)
        throw new Error(
          `${issue.identifier}.comment: id Linear duplicado ${commentId} (tambem em ${previous})`,
        );
      linearCommentById.set(commentId, issue.identifier);
    }
    for (const comment of issue.comments) {
      if (comment.externalId === null) continue;
      const previous = githubCommentByExternalId.get(comment.externalId);
      if (previous)
        throw new Error(
          `${issue.identifier}.comment: externalId GitHub duplicado ${comment.externalId} (tambem em ${previous})`,
        );
      githubCommentByExternalId.set(comment.externalId, issue.identifier);
    }
  }

  function resolve(reference, owner) {
    const byId = issueById.get(reference.id);
    const byIdentifier = issueByIdentifier.get(reference.identifier);
    if (!byId || byId !== byIdentifier) {
      throw new Error(
        `${owner}: referencia nao resolve ${reference.id}/${reference.identifier}`,
      );
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
          throw new Error(`${issue.identifier}: duplicateOf autorreferente`);
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

async function normalizeTopology(client, method, scope) {
  if (typeof client[method] !== "function")
    throw new Error(`${scope}: SDK reader ausente`);
  return collectConnection(
    () => client[method]({ first: 50, includeArchived: true }),
    async (entity) => {
      const parsed = z.object({ id: idSchema }).parse(entity);
      let team = entity.team ?? entity.leadTeam;
      if (team) team = await Promise.resolve(team);
      if (team == null) return { id: parsed.id, teamId: null, teamKey: null };
      const parsedTeam = teamIdentitySchema.parse(team);
      return {
        id: parsed.id,
        teamId: parsedTeam.id,
        teamKey: parsedTeam.key,
      };
    },
    scope,
  ).then((entities) =>
    Object.freeze(entities.filter((entity) => entity.teamKey !== null)),
  );
}

async function normalizeProjects(client) {
  if (typeof client.projects !== "function")
    throw new Error("projects: SDK reader ausente");
  const projects = await collectConnection(
    () => client.projects({ first: 50, includeArchived: true }),
    async (project) => {
      const parsed = z.object({ id: idSchema }).parse(project);
      if (typeof project.teams !== "function")
        throw new Error(`projects.${parsed.id}: teams reader ausente`);
      return { id: parsed.id, project };
    },
    "projects",
  );
  const associations = [];
  for (const { id, project } of projects) {
    const teams = await collectConnection(
      () => project.teams({ first: 50 }),
      async (team) => teamIdentitySchema.parse(team),
      `projects.${id}.teams`,
    );
    for (const team of teams)
      associations.push({ id, teamId: team.id, teamKey: team.key });
  }
  return Object.freeze(associations.map(Object.freeze));
}

function assertTeamReferences(teams, issues, collections) {
  const teamById = new Map();
  const teamByKey = new Map();
  for (const team of teams) {
    if (teamById.has(team.id))
      throw new Error(`teams: identidade duplicada ${team.id}`);
    if (teamByKey.has(team.key))
      throw new Error(`teams: key duplicada ${team.key}`);
    teamById.set(team.id, team);
    teamByKey.set(team.key, team);
  }

  function resolve(teamId, teamKey, owner) {
    const byId = teamById.get(teamId);
    const byKey = teamByKey.get(teamKey);
    if (!byId || byId !== byKey)
      throw new Error(`${owner}: time nao resolve ${teamId}/${teamKey}`);
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

/** @returns {{readWorkspaceSnapshot(options:{capturedAt:string}):Promise<import('../domain/model.mjs').NormalizedLinearSnapshot>}} */
export function createLinearAdapter({ apiKey, clientFactory } = {}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "")
    throw new Error("apiKey Linear somente leitura obrigatoria");
  const client = clientFactory
    ? clientFactory({ apiKey })
    : new LinearClient({ apiKey });

  async function readWorkspaceSnapshot({ capturedAt }) {
    try {
      const capturedAtMs = timestampMs(capturedAt, "capturedAt");
      const teamsDetailed = await collectConnection(
        () => client.teams({ first: 50, includeArchived: true }),
        async (team) => {
          const parsed = teamSchema.parse(team);
          for (const field of ["archivedAt", "retiredAt"]) {
            if (
              parsed[field] != null &&
              timestampMs(parsed[field], `team.${parsed.key}.${field}`) >
                capturedAtMs
            )
              throw new Error(`team.${parsed.key}.${field}: timestamp futuro`);
          }
          return {
            ...parsed,
            active: parsed.archivedAt === null && parsed.retiredAt === null,
          };
        },
        "teams",
      );
      const issuesRaw = await collectConnection(
        () => client.issues({ first: 50, includeArchived: true }),
        (issue) => normalizeIssue(issue, capturedAtMs),
        "issues",
      );
      const issues = finalizeIssueReferences(issuesRaw);
      const [cycles, projects, initiatives, documents] = await Promise.all([
        normalizeTopology(client, "cycles", "cycles"),
        normalizeProjects(client),
        normalizeTopology(client, "initiatives", "initiatives"),
        normalizeTopology(client, "documents", "documents"),
      ]);
      assertTeamReferences(teamsDetailed, issues, {
        cycles,
        projects,
        initiatives,
        documents,
      });
      return Object.freeze({
        complete: true,
        failures: Object.freeze([]),
        capturedAtMs,
        teams: Object.freeze(
          teamsDetailed.map((team) =>
            Object.freeze({
              id: team.id,
              key: team.key,
              active: team.active,
            }),
          ),
        ),
        issues,
        cycles,
        projects,
        initiatives,
        documents,
      });
    } catch (error) {
      return Object.freeze({
        complete: false,
        failures: Object.freeze([Object.freeze(failure(error))]),
        capturedAtMs: Number.isFinite(Date.parse(capturedAt))
          ? Date.parse(capturedAt)
          : 0,
        teams: Object.freeze([]),
        issues: Object.freeze([]),
        cycles: Object.freeze([]),
        projects: Object.freeze([]),
        initiatives: Object.freeze([]),
        documents: Object.freeze([]),
      });
    }
  }

  return Object.freeze({ readWorkspaceSnapshot });
}

export async function readLinearSnapshot({
  token,
  capturedAt = new Date().toISOString(),
} = {}) {
  return createLinearAdapter({ apiKey: token }).readWorkspaceSnapshot({
    capturedAt,
  });
}
