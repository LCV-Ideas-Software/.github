import { appendFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_ORGANIZATION = "LCV-Ideas-Software";
const DEFAULT_UMBRELLA_TEAM_KEY = "LCV";
const DEFAULT_COMMENT_GRACE_MS = 30 * 60 * 1000;
const DEFAULT_RELEASE_REQUIRED_AFTER = new Date("2026-08-17T12:00:00.000Z");
const MAX_GITHUB_PAGES = 1_000;
const MAX_LINEAR_PAGES = 1_000;
const GITHUB_LINK =
  /https:\/\/github\.com\/LCV-Ideas-Software\/([^\s/#?]+)\/(issues|pull)\/(\d+)/giu;
const GITHUB_COMMENT_TIME_TOLERANCE_MS = 1_000;
const HUMAN_DATE_FORMATTER = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "Etc/GMT+3",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export const DEFAULT_TEAM_REPOSITORIES = Object.freeze({
  GITHORG: ".github",
  GITPRIV: ".github-private",
  MAESTRO: "maestro-app",
  CROSREV: "cross-review",
  ADMIAPP: "admin-app",
  MTASTS: "mtasts-motor",
  ULTRABR: "ultrabrain-mcp",
  ORAFINC: "oraculo-financeiro",
  MAISITE: "mainsite-app",
  ASTROLO: "astrologo-app",
  SPONSOR: "sponsor-motor",
  CALCULA: "calculadora-app",
});

function connectionNodes(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.nodes) ? value.nodes : [];
}

function nextLinearCursor(pageInfo, label, seenCursors) {
  if (!pageInfo?.hasNextPage) return null;
  const cursor = pageInfo.endCursor;
  if (typeof cursor !== "string" || !cursor)
    throw new Error(`${label}: cursor ausente`);
  if (seenCursors.has(cursor))
    throw new Error(`${label}: cursor repetido ${cursor}`);
  seenCursors.add(cursor);
  return cursor;
}

function normalizeBody(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatHumanDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "data inválida";
  const parts = Object.fromEntries(
    HUMAN_DATE_FORMATTER.formatToParts(date).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function githubCommentCreatedAt(comment) {
  return comment?.created_at ?? comment?.createdAt ?? "";
}

export function canonicalizeCommentBody(value) {
  return normalizeBody(value)
    .replace(/<(https?:\/\/[^>\s]+)>/gu, "$1")
    .replace(/^\s*[+*]\s+/gmu, "- ")
    .replace(/^\s*-\s+/gmu, "- ");
}

function normalizeTitle(value) {
  return normalizeBody(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const TITLE_BOILERPLATE_WORDS = new Set([
  "adicionar",
  "ajustar",
  "alterar",
  "atualizar",
  "correcao",
  "corrigir",
  "criar",
  "erro",
  "falha",
  "fazer",
  "implementar",
  "melhorar",
  "problema",
  "resolver",
]);

function wordSet(value) {
  const ignored = new Set([
    "com",
    "das",
    "dos",
    "para",
    "por",
    "que",
    "uma",
    "issues",
    "issue",
  ]);
  return new Set(
    normalizeTitle(value)
      .split(" ")
      .filter((word) => word.length > 2 && !ignored.has(word)),
  );
}

function titleWordSet(value) {
  const words = wordSet(value);
  for (const word of TITLE_BOILERPLATE_WORDS) words.delete(word);
  return words;
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function titleOverlap(left, right) {
  const leftWords = titleWordSet(left);
  const rightWords = titleWordSet(right);
  let intersection = 0;
  for (const word of leftWords) if (rightWords.has(word)) intersection += 1;
  return {
    intersection,
    jaccard: jaccard(leftWords, rightWords),
    overlap:
      Math.min(leftWords.size, rightWords.size) === 0
        ? 0
        : intersection / Math.min(leftWords.size, rightWords.size),
  };
}

function issueRelationIdentifiers(issue) {
  const identifiers = new Set();
  if (issue.duplicateOf?.identifier)
    identifiers.add(issue.duplicateOf.identifier);
  for (const relation of [
    ...connectionNodes(issue.relations),
    ...connectionNodes(issue.inverseRelations),
  ]) {
    const other =
      relation.issue?.identifier === issue.identifier
        ? relation.relatedIssue?.identifier
        : (relation.issue?.identifier ?? relation.relatedIssue?.identifier);
    if (other) identifiers.add(other);
  }
  return identifiers;
}

function issuesAreExplicitlyReconciled(left, right) {
  return (
    left.duplicateOf?.identifier === right.identifier ||
    right.duplicateOf?.identifier === left.identifier ||
    issueRelationIdentifiers(left).has(right.identifier) ||
    issueRelationIdentifiers(right).has(left.identifier)
  );
}

function linkedRepositories(issue) {
  return new Set(
    collectGithubLinks(issue).map((link) => githubUrlKey(link.repo)),
  );
}

function sharesRepository(left, right) {
  const leftRepos = linkedRepositories(left);
  const rightRepos = linkedRepositories(right);
  for (const repo of leftRepos) if (rightRepos.has(repo)) return true;
  return false;
}

function expectedPipelineForRepository(repo) {
  const canonical = githubUrlKey(repo);
  return canonical === ".github" ? ".github-org" : canonical;
}

function githubUrlKey(value) {
  return String(value ?? "").toLocaleLowerCase("en-US");
}

function sameGithubRepository(left, right) {
  return githubUrlKey(left) === githubUrlKey(right);
}

export function parseLinearOnlyTeamKeys(
  value,
  umbrellaTeamKey = DEFAULT_UMBRELLA_TEAM_KEY,
) {
  if (!String(value ?? "").trim()) return [];
  const raw = String(value).split(",");
  if (raw.some((key) => !key.trim()))
    throw new Error("LINEAR_ONLY_TEAM_KEYS contém entrada vazia");
  const keys = raw.map((key) => key.trim());
  if (keys.some((key) => !/^[A-Z][A-Z0-9]{0,19}$/u.test(key)))
    throw new Error("LINEAR_ONLY_TEAM_KEYS contém chave inválida");
  if (new Set(keys).size !== keys.length)
    throw new Error("LINEAR_ONLY_TEAM_KEYS contém chave duplicada");
  if (keys.includes(umbrellaTeamKey))
    throw new Error("o time guarda-chuva não pode ser Linear-only");
  return keys;
}

function releaseMatchesCommit(release, commit, repo) {
  if (
    githubUrlKey(release.pipeline?.name) !==
    githubUrlKey(expectedPipelineForRepository(repo))
  )
    return false;
  if (release.pipeline?.type !== "continuous" || !release.completedAt)
    return false;
  const exact = String(release.commitSha ?? "").toLowerCase();
  const version = String(release.version ?? release.name ?? "").toLowerCase();
  const candidate = commit.toLowerCase();
  return (
    exact === candidate ||
    (version.length >= 7 && candidate.startsWith(version))
  );
}

function githubIssueState(record) {
  if (record.state === "open") return "active";
  if (record.state_reason === "not_planned") return "canceled";
  return "completed";
}

function linearIssueState(issue) {
  if (["canceled", "duplicate"].includes(issue.state?.type)) return "canceled";
  if (issue.state?.type === "completed") return "completed";
  return "active";
}

function isGithubService(value) {
  return String(value ?? "").toLocaleLowerCase("en-US") === "github";
}

function hasNativeGithubSync(issue) {
  return (issue.syncedWith ?? []).some((entity) =>
    isGithubService(entity.service),
  );
}

function hasGithubExternalThread(issue) {
  return connectionNodes(issue.comments).some((comment) => {
    const thread = comment.externalThread;
    return (
      thread &&
      (isGithubService(thread.subType) || isGithubService(thread.name))
    );
  });
}

function hasConnectedGithubExternalThread(issue) {
  return connectionNodes(issue.comments).some((comment) => {
    const thread = comment.externalThread;
    return (
      thread?.isConnected !== false &&
      (isGithubService(thread?.subType) || isGithubService(thread?.name))
    );
  });
}

export function isGithubSyncedComment(linearComment, githubComment) {
  const githubNodeId = githubComment.node_id ?? githubComment.nodeId;
  if (
    githubNodeId &&
    (linearComment.syncedWith ?? []).some(
      (entity) => isGithubService(entity.service) && entity.id === githubNodeId,
    )
  ) {
    return true;
  }
  const linearTime = Date.parse(
    linearComment.createdAt ?? linearComment.created_at ?? "",
  );
  const githubTime = Date.parse(
    githubComment.created_at ?? githubComment.createdAt ?? "",
  );
  return (
    Number.isFinite(linearTime) &&
    Number.isFinite(githubTime) &&
    Math.abs(linearTime - githubTime) <= GITHUB_COMMENT_TIME_TOLERANCE_MS &&
    canonicalizeCommentBody(linearComment.body) ===
      canonicalizeCommentBody(githubComment.body)
  );
}

function commentsShareGithubNodeId(linearComment, githubComment) {
  const githubNodeId = githubComment.node_id ?? githubComment.nodeId;
  return Boolean(
    githubNodeId &&
    (linearComment.syncedWith ?? []).some(
      (entity) => isGithubService(entity.service) && entity.id === githubNodeId,
    ),
  );
}

function hasConnectedGithubExternalThreadComment(linearComment) {
  const thread = linearComment?.externalThread;
  return Boolean(
    thread?.isConnected !== false &&
    (isGithubService(thread?.subType) || isGithubService(thread?.name)),
  );
}

function pairSyncedComments(linearComments, githubComments) {
  const pairs = new Map();
  const usedLinear = new Set();
  const pairPass = (predicate) => {
    for (
      let githubIndex = 0;
      githubIndex < githubComments.length;
      githubIndex += 1
    ) {
      if (pairs.has(githubIndex)) continue;
      const linearIndex = linearComments.findIndex(
        (linearComment, candidateIndex) =>
          !usedLinear.has(candidateIndex) &&
          predicate(linearComment, githubComments[githubIndex]),
      );
      if (linearIndex >= 0) {
        pairs.set(githubIndex, linearIndex);
        usedLinear.add(linearIndex);
      }
    }
  };
  pairPass(commentsShareGithubNodeId);
  pairPass(
    (linearComment, githubComment) =>
      hasConnectedGithubExternalThreadComment(linearComment) &&
      isGithubSyncedComment(linearComment, githubComment),
  );
  return { pairs, usedLinear };
}

export function assertReadOnlyGraphql(query) {
  const withoutComments = String(query)
    .replace(/#[^\n]*/g, "")
    .trim();
  if (/\bmutation\b/i.test(withoutComments)) {
    throw new Error(
      "O reconciliador aceita somente consultas GraphQL; mutation foi recusada.",
    );
  }
  if (!(withoutComments.startsWith("{") || /^query\b/i.test(withoutComments))) {
    throw new Error(
      "O reconciliador aceita somente consultas GraphQL nomeadas ou abreviadas.",
    );
  }
}

function githubLinkFromSyncedEntity(entity, organization) {
  if (!isGithubService(entity?.service)) return null;
  const metadata = entity.metadata;
  if (
    !metadata?.repo ||
    metadata.number === null ||
    metadata.number === undefined ||
    !Number.isInteger(Number(metadata.number)) ||
    Number(metadata.number) <= 0
  ) {
    return null;
  }
  const owner = metadata.owner || organization;
  if (
    owner.toLocaleLowerCase("en-US") !== organization.toLocaleLowerCase("en-US")
  )
    return null;
  const number = Number(metadata.number);
  return {
    kind: "issue",
    number,
    owner: organization,
    repo: metadata.repo,
    url: `https://github.com/${organization}/${metadata.repo}/issues/${number}`,
  };
}

export function collectGithubLinks(issue, organization = DEFAULT_ORGANIZATION) {
  const links = new Map();
  for (const entity of issue.syncedWith ?? []) {
    const link = githubLinkFromSyncedEntity(entity, organization);
    if (link) links.set(link.url.toLocaleLowerCase("en-US"), link);
  }
  const sources = [
    issue.description,
    ...connectionNodes(issue.attachments).map((attachment) => attachment.url),
    ...connectionNodes(issue.comments).map((comment) => comment.body),
  ];
  for (const source of sources) {
    if (!source) continue;
    GITHUB_LINK.lastIndex = 0;
    for (const match of String(source).matchAll(GITHUB_LINK)) {
      const [raw, repo, resource, numberText] = match;
      const owner = raw.split("/")[3];
      if (
        owner.toLocaleLowerCase("en-US") !==
        organization.toLocaleLowerCase("en-US")
      )
        continue;
      const kind =
        resource.toLocaleLowerCase("en-US") === "pull" ? "pull" : "issue";
      const number = Number(numberText);
      const normalizedResource = kind === "pull" ? "pull" : "issues";
      const url = `https://github.com/${organization}/${repo}/${normalizedResource}/${number}`;
      links.set(url.toLocaleLowerCase("en-US"), {
        kind,
        number,
        owner: organization,
        repo,
        url,
      });
    }
  }
  return [...links.values()].sort((left, right) =>
    left.url.localeCompare(right.url),
  );
}

function collectAttachmentIssueLinks(issue, organization) {
  return collectGithubLinks(
    {
      description: "",
      attachments: issue.attachments,
      comments: { nodes: [] },
      syncedWith: [],
    },
    organization,
  ).filter((link) => link.kind === "issue");
}

function collectAttachmentPullLinks(issue, organization) {
  return collectGithubLinks(
    {
      description: "",
      attachments: issue.attachments,
      comments: { nodes: [] },
      syncedWith: [],
    },
    organization,
  ).filter((link) => link.kind === "pull");
}

function collectNativeGithubIssueLinks(issue, organization) {
  return (issue.syncedWith ?? [])
    .map((entity) => githubLinkFromSyncedEntity(entity, organization))
    .filter(Boolean);
}

function findStrongDuplicateCandidates(linearIssues) {
  const findings = [];
  for (let leftIndex = 0; leftIndex < linearIssues.length; leftIndex += 1) {
    const left = linearIssues[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < linearIssues.length;
      rightIndex += 1
    ) {
      const right = linearIssues[rightIndex];
      if (issuesAreExplicitlyReconciled(left, right)) continue;
      const titlesMatch =
        normalizeTitle(left.title) === normalizeTitle(right.title);
      const leftDescriptionWords = wordSet(left.description);
      const rightDescriptionWords = wordSet(right.description);
      const descriptionSimilarity = jaccard(
        leftDescriptionWords,
        rightDescriptionWords,
      );
      const sameRepository = sharesRepository(left, right);
      if (titlesMatch && descriptionSimilarity >= 0.85 && sameRepository) {
        findings.push({
          severity: "error",
          code: "duplicate_candidate",
          issue: `${left.identifier}, ${right.identifier}`,
          message:
            `título, escopo e repositório coincidem (${Math.round(descriptionSimilarity * 100)}%); ` +
            "registre duplicateOf ou uma relação explícita",
        });
      } else if (titlesMatch) {
        findings.push({
          severity: "warning",
          code: "similar_issue_unlinked",
          issue: `${left.identifier}, ${right.identifier}`,
          message:
            `título idêntico entre issues ainda não relacionados ` +
            `(${Math.round(descriptionSimilarity * 100)}% de similaridade textual), sem relação explícita`,
        });
      } else {
        const titleSimilarity = titleOverlap(left.title, right.title);
        const descriptionsAreInformative =
          leftDescriptionWords.size >= 5 && rightDescriptionWords.size >= 5;
        if (
          sameRepository &&
          descriptionsAreInformative &&
          descriptionSimilarity >= 0.85 &&
          titleSimilarity.intersection >= 2 &&
          titleSimilarity.overlap >= 2 / 3 &&
          titleSimilarity.jaccard >= 0.5
        ) {
          findings.push({
            severity: "warning",
            code: "similar_issue_unlinked",
            issue: `${left.identifier}, ${right.identifier}`,
            message:
              `títulos possivelmente parafraseados (${Math.round(titleSimilarity.overlap * 100)}% de cobertura), ` +
              `descrições equivalentes (${Math.round(descriptionSimilarity * 100)}%) e mesmo repositório; ` +
              "revise e registre duplicateOf ou uma relação explícita",
          });
        }
      }
    }
  }
  return findings;
}

function githubFailureFinding(issue, link, record, repositoryInventory) {
  const inventoryFailure = Object.entries(
    repositoryInventory?.issueAuditFailures ?? {},
  ).find(([repo]) => sameGithubRepository(repo, link.repo))?.[1];
  const inventoryComplete =
    link.kind === "issue" &&
    !repositoryInventory?.auditFailure &&
    Array.isArray(repositoryInventory?.issues) &&
    (repositoryInventory.active ?? []).some((repo) =>
      sameGithubRepository(repo, link.repo),
    ) &&
    !inventoryFailure;
  const absentFromInventory =
    inventoryComplete &&
    !repositoryInventory.issues.some(
      (candidate) => githubUrlKey(candidate.url) === githubUrlKey(link.url),
    );
  if (record?.status === 404 && absentFromInventory) {
    return {
      severity: "error",
      code: "github_link_missing",
      issue: issue.identifier,
      message: `${link.url} não existe no inventário completo do repositório`,
    };
  }
  return {
    severity: "incomplete",
    code: "github_link_unreadable",
    issue: issue.identifier,
    message: `${link.url} não pôde ser lido (HTTP ${record?.status ?? "desconhecido"})`,
  };
}

export function reconcileSnapshots({
  linearIssues,
  githubByUrl,
  linearTopology,
  repositoryInventory,
  now = new Date(),
  organization = DEFAULT_ORGANIZATION,
  umbrellaTeamKey = DEFAULT_UMBRELLA_TEAM_KEY,
  commentGraceMs = DEFAULT_COMMENT_GRACE_MS,
  releaseRequiredAfter = DEFAULT_RELEASE_REQUIRED_AFTER,
  requireGithubIssueAttachment = true,
  teamRepositories = DEFAULT_TEAM_REPOSITORIES,
  linearOnlyTeamKeys = [],
}) {
  if (!Number.isFinite(now?.getTime?.()))
    throw new Error("now deve ser uma data válida");
  if (!Number.isFinite(commentGraceMs) || commentGraceMs < 0)
    throw new Error("commentGraceMs deve ser finito e não negativo");
  if (!Number.isFinite(releaseRequiredAfter?.getTime?.()))
    throw new Error("releaseRequiredAfter deve ser uma data válida");
  const findings = [];
  const linearOnlyTeams = new Set(linearOnlyTeamKeys);
  if (linearOnlyTeams.size !== linearOnlyTeamKeys.length)
    throw new Error("linearOnlyTeamKeys contém duplicata");
  if (linearOnlyTeams.has(umbrellaTeamKey))
    throw new Error("o time guarda-chuva não pode ser Linear-only");
  let auditedGithubLinks = 0;
  const canonicalGithubTwins = new Map();
  const activeRepositories = new Map(
    (repositoryInventory?.active ?? []).map((repo) => [
      githubUrlKey(repo),
      repo,
    ]),
  );
  const effectiveTeamRepositories = { ...teamRepositories };
  for (const key of linearOnlyTeams) delete effectiveTeamRepositories[key];
  for (const team of linearTopology?.teams ?? []) {
    if (linearOnlyTeams.has(team.key)) continue;
    const candidateRepository =
      team.name === ".github-org" ? ".github" : team.name;
    if (activeRepositories.has(githubUrlKey(candidateRepository))) {
      effectiveTeamRepositories[team.key] = activeRepositories.get(
        githubUrlKey(candidateRepository),
      );
    }
  }
  for (const issue of linearIssues) {
    if (linearOnlyTeams.has(issue.team?.key)) continue;
    if (activeRepositories.has(githubUrlKey(issue.team?.name))) {
      effectiveTeamRepositories[issue.team.key] = activeRepositories.get(
        githubUrlKey(issue.team.name),
      );
    }
  }
  if (linearTopology?.auditFailure) {
    findings.push({
      severity: "incomplete",
      code: "umbrella_topology_incomplete",
      issue: umbrellaTeamKey,
      message:
        linearTopology.message ||
        "não foi possível inventariar o time guarda-chuva",
    });
  } else if (linearTopology) {
    for (const [collection, code, label] of [
      ["cycles", "umbrella_cycle_present", "cycle(s)"],
      ["projects", "umbrella_project_present", "project(s)"],
      ["initiatives", "umbrella_initiative_present", "initiative(s)"],
      ["documents", "umbrella_document_present", "document(s)"],
    ]) {
      const entities = linearTopology[collection] ?? [];
      if (entities.length > 0) {
        findings.push({
          severity: "error",
          code,
          issue: umbrellaTeamKey,
          message: `${entities.length} ${label} ainda vinculados ao LCV: ${entities
            .slice(0, 10)
            .map(
              (entity) =>
                entity.name ?? entity.title ?? entity.key ?? entity.id,
            )
            .join(", ")}`,
        });
      }
    }
  }
  if (repositoryInventory) {
    if (repositoryInventory.auditFailure) {
      findings.push({
        severity: "incomplete",
        code: "repository_inventory_incomplete",
        issue: "organização",
        message: `inventário GitHub falhou (HTTP ${repositoryInventory.status ?? "desconhecido"})`,
      });
    } else {
      const active = new Set(repositoryInventory.active ?? []);
      const activeKeys = new Set([...active].map(githubUrlKey));
      const topologyTeams = linearTopology?.teams ?? [];
      const linearTeamNames = new Set(
        (topologyTeams.length > 0
          ? topologyTeams.filter((team) => !team.archivedAt && !team.retiredAt)
          : linearIssues.map((issue) => issue.team)
        )
          .map((team) => githubUrlKey(team?.name))
          .filter(Boolean),
      );
      for (const repo of active) {
        const expectedTeamName = repo === ".github" ? ".github-org" : repo;
        if (!linearTeamNames.has(githubUrlKey(expectedTeamName))) {
          findings.push({
            severity: "error",
            code: "missing_linear_team",
            issue: repo,
            message: `repositório ativo sem time Linear individual ${expectedTeamName}`,
          });
        }
      }
      for (const team of topologyTeams.filter(
        (candidate) =>
          !candidate.archivedAt &&
          !candidate.retiredAt &&
          candidate.key !== umbrellaTeamKey,
      )) {
        const expectedRepository =
          team.name === ".github-org" ? ".github" : team.name;
        if (linearOnlyTeams.has(team.key)) {
          if (activeKeys.has(githubUrlKey(expectedRepository))) {
            findings.push({
              severity: "error",
              code: "linear_only_team_repository_collision",
              issue: team.key,
              message: `time Linear-only ${team.name} colide com repositório ativo`,
            });
          }
          continue;
        }
        if (!activeKeys.has(githubUrlKey(expectedRepository))) {
          findings.push({
            severity: "error",
            code: "linear_team_without_active_repository",
            issue: team.key,
            message: `time Linear ${team.name} não corresponde a repositório ativo`,
          });
        }
      }
      for (const key of linearOnlyTeams) {
        if (
          !topologyTeams.some(
            (team) => team.key === key && !team.archivedAt && !team.retiredAt,
          )
        ) {
          findings.push({
            severity: "error",
            code: "linear_only_team_unknown",
            issue: key,
            message: "exceção Linear-only não corresponde a time ativo",
          });
        }
      }
    }
  }

  for (const issue of linearIssues) {
    const isLinearOnly = linearOnlyTeams.has(issue.team?.key);
    const links = collectGithubLinks(issue, organization);
    const mappedRepository = effectiveTeamRepositories[issue.team?.key];
    const attachmentIssueLinks = collectAttachmentIssueLinks(
      issue,
      organization,
    );
    const attachmentPullUrls = new Set(
      collectAttachmentPullLinks(issue, organization).map((link) =>
        githubUrlKey(link.url),
      ),
    );
    const mappedAttachmentIssueLinks = mappedRepository
      ? attachmentIssueLinks.filter((link) =>
          sameGithubRepository(link.repo, mappedRepository),
        )
      : [];
    const nativeIssueLinks = collectNativeGithubIssueLinks(issue, organization);
    const mappedNativeIssueLinks = mappedRepository
      ? nativeIssueLinks.filter((link) =>
          sameGithubRepository(link.repo, mappedRepository),
        )
      : [];
    const hasCanonicalIssueAttachment =
      mappedNativeIssueLinks.length === 1
        ? mappedAttachmentIssueLinks.some(
            (link) =>
              githubUrlKey(link.url) ===
              githubUrlKey(mappedNativeIssueLinks[0].url),
          )
        : mappedNativeIssueLinks.length === 0
          ? mappedAttachmentIssueLinks.length > 0
          : mappedAttachmentIssueLinks.some((attachment) =>
              mappedNativeIssueLinks.some(
                (native) =>
                  githubUrlKey(native.url) === githubUrlKey(attachment.url),
              ),
            );
    const canonicalCandidates = new Map(
      (mappedNativeIssueLinks.length > 0
        ? mappedNativeIssueLinks
        : mappedAttachmentIssueLinks
      ).map((link) => [githubUrlKey(link.url), link]),
    );
    const canonicalIssueUrls = new Set(
      canonicalCandidates.size === 1 ? canonicalCandidates.keys() : [],
    );
    for (const key of canonicalIssueUrls) {
      const url = canonicalCandidates.get(key).url;
      const twin = canonicalGithubTwins.get(key) ?? { url, owners: [] };
      twin.owners.push(issue.identifier);
      canonicalGithubTwins.set(key, twin);
    }
    if (
      mappedRepository &&
      nativeIssueLinks.some(
        (link) => !sameGithubRepository(link.repo, mappedRepository),
      )
    ) {
      findings.push({
        severity: "error",
        code: "team_repository_mismatch",
        issue: issue.identifier,
        message: `gêmeo nativo aponta para outro repositório; esperado ${mappedRepository}`,
      });
    }
    if (canonicalCandidates.size > 1) {
      findings.push({
        severity: "incomplete",
        code: "canonical_issue_ambiguous",
        issue: issue.identifier,
        message: `${canonicalCandidates.size} candidatos canônicos no repositório ${mappedRepository}`,
      });
    }
    if (issue.team?.key === umbrellaTeamKey) {
      const destinations = [...issueRelationIdentifiers(issue)].filter(
        (identifier) =>
          linearIssues.some(
            (candidate) =>
              candidate.identifier === identifier &&
              candidate.team?.key !== umbrellaTeamKey,
          ),
      );
      findings.push({
        severity: "error",
        code: "umbrella_issue_present",
        issue: issue.identifier,
        message:
          destinations.length > 0
            ? `migração relacionada a ${destinations.join(", ")} ainda não moveu a entidade para o time individual`
            : "issue deve ser movida para o time individual apropriado; o time LCV deve permanecer vazio",
      });
    }
    if (
      isLinearOnly &&
      (hasNativeGithubSync(issue) || hasConnectedGithubExternalThread(issue))
    ) {
      findings.push({
        severity: "error",
        code: "linear_only_team_github_sync",
        issue: issue.identifier,
        message:
          "issue de time Linear-only ainda possui sincronização GitHub conectada",
      });
    }
    if (
      requireGithubIssueAttachment &&
      mappedRepository &&
      issue.team?.key !== umbrellaTeamKey &&
      !hasCanonicalIssueAttachment
    ) {
      findings.push({
        severity: "error",
        code: "missing_github_issue_attachment",
        issue: issue.identifier,
        message:
          "issue de time específico sem gêmeo GitHub explicitamente anexado",
      });
    }

    const disconnectedThreads = connectionNodes(issue.comments).filter(
      (comment) => {
        const thread = comment.externalThread;
        return (
          thread?.isConnected === false &&
          (isGithubService(thread.subType) || isGithubService(thread.name))
        );
      },
    );
    if (disconnectedThreads.length > 0) {
      findings.push({
        severity: "error",
        code: "comment_sync_disconnected",
        issue: issue.identifier,
        message: `${disconnectedThreads.length} thread(s) GitHub estão desconectadas no Linear`,
      });
    }

    for (const link of links) {
      auditedGithubLinks += 1;
      const github = githubByUrl.get(link.url);
      if (isLinearOnly) {
        if (github && !github.auditFailure) {
          findings.push({
            severity: "error",
            code: "linear_only_team_live_github_link",
            issue: issue.identifier,
            message: `time Linear-only referencia recurso GitHub vivo ${link.url}`,
          });
        } else if (github?.status !== 410) {
          const failure = githubFailureFinding(
            issue,
            link,
            github,
            repositoryInventory,
          );
          if (failure.code !== "github_link_missing") findings.push(failure);
        }
        continue;
      }
      if (!github || github.auditFailure) {
        findings.push(
          githubFailureFinding(issue, link, github, repositoryInventory),
        );
        continue;
      }
      if (
        link.kind === "issue" &&
        canonicalIssueUrls.has(githubUrlKey(link.url))
      ) {
        const linearState = linearIssueState(issue);
        const githubState = githubIssueState(github);
        if (linearState !== githubState) {
          findings.push({
            severity: "error",
            code: "status_divergence",
            issue: issue.identifier,
            message: `Linear=${linearState}; GitHub=${githubState} em ${link.url}`,
          });
        }
        if (hasNativeGithubSync(issue) || hasGithubExternalThread(issue)) {
          const linearComments = connectionNodes(issue.comments);
          const githubComments = github.comments ?? [];
          const { pairs: commentPairs, usedLinear } = pairSyncedComments(
            linearComments,
            githubComments,
          );
          const cutoff = now.getTime() - commentGraceMs;
          const missingComments = [];
          let staleComments = 0;
          for (
            let githubIndex = 0;
            githubIndex < githubComments.length;
            githubIndex += 1
          ) {
            const githubComment = githubComments[githubIndex];
            const createdAt = Date.parse(
              githubComment.created_at ?? githubComment.createdAt ?? "",
            );
            if (
              !Number.isFinite(createdAt) ||
              createdAt > cutoff ||
              !normalizeBody(githubComment.body)
            )
              continue;
            const linearIndex = commentPairs.get(githubIndex);
            const linearComment =
              linearIndex === undefined
                ? undefined
                : linearComments[linearIndex];
            if (!linearComment) {
              missingComments.push(githubComment);
              continue;
            }
            const githubUpdated = Date.parse(
              githubComment.updated_at ??
                githubComment.updatedAt ??
                githubComment.created_at ??
                "",
            );
            const linearUpdated = Date.parse(
              linearComment.updatedAt ??
                linearComment.updated_at ??
                linearComment.createdAt ??
                "",
            );
            if (
              Number.isFinite(githubUpdated) &&
              githubUpdated <= cutoff &&
              ((Number.isFinite(linearUpdated) &&
                githubUpdated - linearUpdated > commentGraceMs) ||
                canonicalizeCommentBody(githubComment.body) !==
                  canonicalizeCommentBody(linearComment.body))
            ) {
              staleComments += 1;
            }
          }
          if (missingComments.length > 0) {
            const newest = missingComments.sort(
              (left, right) =>
                Date.parse(githubCommentCreatedAt(right)) -
                Date.parse(githubCommentCreatedAt(left)),
            )[0];
            findings.push({
              severity: "error",
              code: "comment_sync_gap",
              issue: issue.identifier,
              message:
                `${missingComments.length} comentário(s) GitHub com mais de ` +
                `${Math.round(commentGraceMs / 60_000)} min não aparecem no Linear; ` +
                `mais recente em ${formatHumanDate(githubCommentCreatedAt(newest))}`,
            });
          }
          if (staleComments > 0) {
            findings.push({
              severity: "error",
              code: "comment_sync_stale",
              issue: issue.identifier,
              message: `${staleComments} comentário(s) sincronizados estão desatualizados no Linear`,
            });
          }
          const missingOnGithub = linearComments.filter(
            (linearComment, index) => {
              const thread = linearComment.externalThread;
              const isGithubThread =
                thread &&
                (isGithubService(thread.subType) ||
                  isGithubService(thread.name));
              const createdAt = Date.parse(linearComment.createdAt ?? "");
              return (
                isGithubThread &&
                thread.isConnected !== false &&
                Number.isFinite(createdAt) &&
                createdAt <= cutoff &&
                normalizeBody(linearComment.body) &&
                !usedLinear.has(index)
              );
            },
          );
          if (missingOnGithub.length > 0) {
            findings.push({
              severity: "error",
              code: "comment_sync_gap_to_github",
              issue: issue.identifier,
              message:
                `${missingOnGithub.length} comentário(s) do thread GitHub no Linear com mais de ` +
                `${Math.round(commentGraceMs / 60_000)} min não aparecem no GitHub`,
            });
          }
        }
      }
      if (
        link.kind === "pull" &&
        attachmentPullUrls.has(githubUrlKey(link.url)) &&
        github.merged === true &&
        github.merge_commit_sha &&
        Date.parse(github.merged_at) >= releaseRequiredAfter.getTime()
      ) {
        const releases = connectionNodes(issue.releases);
        if (
          !releases.some((release) =>
            releaseMatchesCommit(release, github.merge_commit_sha, link.repo),
          )
        ) {
          findings.push({
            severity: "error",
            code: "missing_release",
            issue: issue.identifier,
            message:
              `PR mergeado ${link.url} não possui release da pipeline ` +
              `${expectedPipelineForRepository(link.repo)} associada ao commit ` +
              github.merge_commit_sha.slice(0, 7),
          });
        }
      }
    }

    for (const connection of [
      "attachments",
      "comments",
      "relations",
      "inverseRelations",
      "releases",
    ]) {
      if (issue[connection]?.pageInfo?.hasNextPage) {
        findings.push({
          severity: "incomplete",
          code: "linear_nested_pagination_truncated",
          issue: issue.identifier,
          message: `${connection} ainda possui página não lida; a auditoria se recusa a concluir parcialmente`,
        });
      }
    }
  }
  for (const { url, owners } of canonicalGithubTwins.values()) {
    if (owners.length > 1) {
      findings.push({
        severity: "error",
        code: "github_issue_multiple_linear_twins",
        issue: owners.join(", "),
        message: `${url} é reivindicado como gêmeo canônico por ${owners.length} issues Linear`,
      });
    }
  }
  for (const githubIssue of repositoryInventory?.issues ?? []) {
    if (!canonicalGithubTwins.has(githubUrlKey(githubIssue.url))) {
      findings.push({
        severity: "error",
        code: "github_issue_without_linear_twin",
        issue: `${githubIssue.repo}#${githubIssue.number}`,
        message: `${githubIssue.url} não possui gêmeo canônico no Linear`,
      });
    }
  }
  for (const [repo, failure] of Object.entries(
    repositoryInventory?.issueAuditFailures ?? {},
  )) {
    findings.push({
      severity: "incomplete",
      code: "github_issue_inventory_incomplete",
      issue: repo,
      message: `Issues do repositório não puderam ser inventariados (HTTP ${failure.status ?? "desconhecido"})`,
    });
  }
  findings.push(...findStrongDuplicateCandidates(linearIssues));
  findings.sort((left, right) =>
    `${left.severity}:${left.code}:${left.issue}`.localeCompare(
      `${right.severity}:${right.code}:${right.issue}`,
    ),
  );
  return {
    auditedIssues: linearIssues.length,
    auditedGithubLinks,
    linearOnlyTeamKeys: [...linearOnlyTeams].sort(),
    findings,
  };
}

export function determineExitCode(result, { strictWarnings = false } = {}) {
  if (result.findings.some((finding) => finding.severity === "incomplete"))
    return 2;
  if (result.findings.some((finding) => finding.severity === "error")) return 1;
  if (
    strictWarnings &&
    result.findings.some((finding) => finding.severity === "warning")
  )
    return 1;
  return 0;
}

export function renderMarkdown(result) {
  const counts = Object.fromEntries(
    ["error", "warning", "incomplete"].map((severity) => [
      severity,
      result.findings.filter((finding) => finding.severity === severity).length,
    ]),
  );
  const lines = [
    "## Reconciliação GitHub ↔ Linear (somente leitura)",
    "",
    `- ${result.auditedIssues} issues Linear auditadas`,
    `- ${result.auditedGithubLinks} links GitHub verificados`,
    `- Times Linear-only declarados: ${result.linearOnlyTeamKeys?.length ? result.linearOnlyTeamKeys.join(", ") : "nenhum"}`,
    `- ${counts.error} erros; ${counts.warning} avisos; ${counts.incomplete} inconclusivos`,
    "",
  ];
  if (result.findings.length === 0) {
    lines.push("Nenhuma divergência encontrada.");
  } else {
    lines.push(
      "| Severidade | Código | Issue | Evidência |",
      "| --- | --- | --- | --- |",
    );
    for (const finding of result.findings) {
      lines.push(
        `| ${finding.severity} | \`${finding.code}\` | ${finding.issue} | ${finding.message.replaceAll("|", "\\|")} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function graphqlQuery({
  token,
  query,
  variables = {},
  fetchImpl = fetch,
}) {
  assertReadOnlyGraphql(query);
  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Linear API HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(
      `Linear API: ${payload.errors.map((error) => error.message).join("; ")}`,
    );
  }
  if (!payload.data)
    throw new Error("Linear API retornou resposta parcial sem data");
  return payload.data;
}

const ISSUE_FIELDS = `
  id identifier title description url updatedAt completedAt canceledAt
  team { id key name }
  state { id name type }
  syncedWith {
    id service
    metadata {
      __typename
      ... on ExternalEntityInfoGithubMetadata { owner repo number }
    }
  }
  attachments(first: 10) {
    nodes { id title url }
    pageInfo { hasNextPage endCursor }
  }
  relations(first: 10) {
    nodes { id type issue { id identifier } relatedIssue { id identifier } }
    pageInfo { hasNextPage endCursor }
  }
  inverseRelations(first: 10) {
    nodes { id type issue { id identifier } relatedIssue { id identifier } }
    pageInfo { hasNextPage endCursor }
  }
  releases(first: 10) {
    nodes { id name version commitSha completedAt pipeline { id name type } }
    pageInfo { hasNextPage endCursor }
  }
`;

const RECONCILIATION_QUERY = `
  query GitHubLinearReconciliation($after: String) {
    issues(first: 50, after: $after, includeArchived: true, orderBy: updatedAt) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const COMMENTS_QUERY = `
  query GitHubLinearComments($id: String!, $after: String) {
    issue(id: $id) {
      comments(first: 50, after: $after, orderBy: createdAt) {
        nodes {
          id body createdAt updatedAt
          syncedWith { id service }
          externalThread { id isConnected name subType type url }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const TEAMS_QUERY = `
  query GitHubLinearTeams($after: String) {
    teams(first: 50, after: $after, includeArchived: true, orderBy: updatedAt) {
      nodes { id key name archivedAt retiredAt parent { id key name } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const TEAM_CYCLES_QUERY = `
  query GitHubLinearUmbrellaCycles($id: String!, $after: String) {
    team(id: $id) {
      cycles(first: 50, after: $after, includeArchived: true, orderBy: updatedAt) {
        nodes { id name number archivedAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const TEAM_PROJECTS_QUERY = `
  query GitHubLinearUmbrellaProjects($id: String!, $after: String) {
    team(id: $id) {
      projects(first: 50, after: $after, includeArchived: true, orderBy: updatedAt) {
        nodes { id name archivedAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const TEAM_INITIATIVES_QUERY = `
  query GitHubLinearUmbrellaInitiatives($teamId: ID!, $after: String) {
    initiatives(
      first: 50
      after: $after
      includeArchived: true
      orderBy: updatedAt
      filter: { leadTeam: { id: { eq: $teamId } } }
    ) {
      nodes { id name archivedAt leadTeam { id key name } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const TEAM_DOCUMENTS_QUERY = `
  query GitHubLinearUmbrellaDocuments($teamId: ID!, $after: String) {
    documents(
      first: 50
      after: $after
      includeArchived: true
      orderBy: updatedAt
      filter: { team: { id: { eq: $teamId } } }
    ) {
      nodes { id title slugId archivedAt team { id key name } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const LINEAR_CONNECTION_FIELDS = Object.freeze({
  attachments: "id title url",
  relations: "id type issue { id identifier } relatedIssue { id identifier }",
  inverseRelations:
    "id type issue { id identifier } relatedIssue { id identifier }",
  releases: "id name version commitSha completedAt pipeline { id name type }",
});

function linearConnectionQuery(connection, fields) {
  return `
    query GitHubLinearConnection($id: String!, $after: String) {
      issue(id: $id) {
        ${connection}(first: 50, after: $after) {
          nodes { ${fields} }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
}

async function completeLinearConnection({
  issue,
  connection,
  token,
  fetchImpl,
}) {
  const fields = LINEAR_CONNECTION_FIELDS[connection];
  if (!fields) throw new Error(`Conexão Linear não permitida: ${connection}`);
  const nodes = [...connectionNodes(issue[connection])];
  const seenCursors = new Set();
  let pageCount = 0;
  let pageInfo = issue[connection]?.pageInfo ?? {
    hasNextPage: false,
    endCursor: null,
  };
  while (pageInfo.hasNextPage) {
    pageCount += 1;
    if (pageCount > MAX_LINEAR_PAGES)
      throw new Error(
        `Linear ${issue.identifier}.${connection}: paginação excedeu o limite`,
      );
    const after = nextLinearCursor(
      pageInfo,
      `Linear ${issue.identifier}.${connection}`,
      seenCursors,
    );
    const data = await graphqlQuery({
      token,
      query: linearConnectionQuery(connection, fields),
      variables: { id: issue.id, after },
      fetchImpl,
    });
    if (!data.issue)
      throw new Error(`Linear issue ${issue.id} não pôde ser relida`);
    const next = data.issue[connection];
    nodes.push(...next.nodes);
    pageInfo = next.pageInfo;
  }
  issue[connection] = {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

async function readLinearComments({ issueId, token, fetchImpl }) {
  const comments = [];
  let after = null;
  const seenCursors = new Set();
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > MAX_LINEAR_PAGES)
      throw new Error(`Linear comments ${issueId}: paginação excedeu o limite`);
    const data = await graphqlQuery({
      token,
      query: COMMENTS_QUERY,
      variables: { id: issueId, after },
      fetchImpl,
    });
    if (!data.issue)
      throw new Error(`Linear issue ${issueId} não pôde ser relida`);
    comments.push(...data.issue.comments.nodes);
    after = nextLinearCursor(
      data.issue.comments.pageInfo,
      `Linear comments ${issueId}`,
      seenCursors,
    );
  } while (after);
  return { nodes: comments, pageInfo: { hasNextPage: false, endCursor: null } };
}

export async function readLinearIssues({
  token,
  linearOnlyTeamKeys = [],
  fetchImpl = fetch,
}) {
  const issues = [];
  let after = null;
  const seenCursors = new Set();
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > MAX_LINEAR_PAGES)
      throw new Error("Linear issues: paginação excedeu o limite");
    const data = await graphqlQuery({
      token,
      query: RECONCILIATION_QUERY,
      variables: { after },
      fetchImpl,
    });
    issues.push(...data.issues.nodes);
    after = nextLinearCursor(
      data.issues.pageInfo,
      "Linear issues",
      seenCursors,
    );
  } while (after);

  const connectionQueue = [];
  for (const issue of issues) {
    for (const connection of Object.keys(LINEAR_CONNECTION_FIELDS)) {
      if (issue[connection]?.pageInfo?.hasNextPage)
        connectionQueue.push({ issue, connection });
    }
  }
  const connectionWorkers = Array.from(
    { length: Math.min(4, connectionQueue.length) },
    async () => {
      for (;;) {
        const work = connectionQueue.shift();
        if (!work) return;
        await completeLinearConnection({ ...work, token, fetchImpl });
      }
    },
  );
  await Promise.all(connectionWorkers);

  const linearOnlyTeams = new Set(linearOnlyTeamKeys);
  const queue = issues.filter(
    (issue) =>
      hasNativeGithubSync(issue) || linearOnlyTeams.has(issue.team?.key),
  );
  const workers = Array.from(
    { length: Math.min(4, queue.length) },
    async () => {
      for (;;) {
        const issue = queue.shift();
        if (!issue) return;
        issue.comments = await readLinearComments({
          issueId: issue.id,
          token,
          fetchImpl,
        });
      }
    },
  );
  await Promise.all(workers);
  for (const issue of issues)
    issue.comments ??= { nodes: [], pageInfo: { hasNextPage: false } };
  return issues;
}

async function readLinearConnectionPages({
  token,
  query,
  root,
  variables = {},
  fetchImpl,
}) {
  const nodes = [];
  let after = null;
  const seenCursors = new Set();
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > MAX_LINEAR_PAGES)
      throw new Error("Linear topology: paginação excedeu o limite");
    const data = await graphqlQuery({
      token,
      query,
      variables: { ...variables, after },
      fetchImpl,
    });
    const connection = root(data);
    if (!connection)
      throw new Error("Linear topology retornou conexão ausente");
    nodes.push(...connection.nodes);
    after = nextLinearCursor(
      connection.pageInfo,
      "Linear topology",
      seenCursors,
    );
  } while (after);
  return nodes;
}

export async function readLinearTopology({
  token,
  umbrellaTeamKey = DEFAULT_UMBRELLA_TEAM_KEY,
  fetchImpl = fetch,
}) {
  const teams = await readLinearConnectionPages({
    token,
    query: TEAMS_QUERY,
    root: (data) => data.teams,
    fetchImpl,
  });
  const matches = teams.filter((team) => team.key === umbrellaTeamKey);
  if (matches.length === 0)
    return {
      teams,
      auditFailure: "umbrella_team_missing",
      message: `o time guarda-chuva ${umbrellaTeamKey} não existe ou não pôde ser lido`,
    };
  if (matches.length !== 1) {
    return {
      teams,
      auditFailure: "ambiguous_umbrella_team",
      message: `${matches.length} times usam a chave ${umbrellaTeamKey}`,
    };
  }
  const team = matches[0];
  if (team.archivedAt || team.retiredAt) {
    return {
      team,
      teams,
      auditFailure: "umbrella_team_inactive",
      message: `o time guarda-chuva ${umbrellaTeamKey} deve permanecer ativo`,
    };
  }
  const [cycles, projects, initiatives, documents] = await Promise.all([
    readLinearConnectionPages({
      token,
      query: TEAM_CYCLES_QUERY,
      root: (data) => data.team?.cycles,
      variables: { id: team.id },
      fetchImpl,
    }),
    readLinearConnectionPages({
      token,
      query: TEAM_PROJECTS_QUERY,
      root: (data) => data.team?.projects,
      variables: { id: team.id },
      fetchImpl,
    }),
    readLinearConnectionPages({
      token,
      query: TEAM_INITIATIVES_QUERY,
      root: (data) => data.initiatives,
      variables: { teamId: team.id },
      fetchImpl,
    }),
    readLinearConnectionPages({
      token,
      query: TEAM_DOCUMENTS_QUERY,
      root: (data) => data.documents,
      variables: { teamId: team.id },
      fetchImpl,
    }),
  ]);
  const subteams = teams.filter(
    (candidate) => candidate.parent?.id === team.id,
  );
  return { team, teams, cycles, projects, initiatives, documents, subteams };
}

class GithubRequestError extends Error {
  constructor(path, status, kind) {
    super(`GitHub API ${path}: HTTP ${status}`);
    this.status = status;
    this.kind = kind;
  }
}

export async function githubGet(path, token, fetchImpl = fetch, options = {}) {
  const method = options.method ?? "GET";
  if (method !== "GET")
    throw new Error("O cliente GitHub do reconciliador aceita somente GET.");
  const response = await fetchImpl(`https://api.github.com${path}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const kind =
      response.status === 404
        ? "not_found"
        : response.status === 403 && remaining === "0"
          ? "rate_limited"
          : response.status === 403
            ? "forbidden"
            : "http_error";
    throw new GithubRequestError(path, response.status, kind);
  }
  return response.json();
}

async function readAllGithubComments({
  owner,
  repo,
  number,
  token,
  fetchImpl = fetch,
}) {
  const comments = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
    const batch = await githubGet(
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
      token,
      fetchImpl,
    );
    for (const comment of batch) {
      const key = comment.node_id ?? comment.id;
      if (key !== undefined && seen.has(String(key)))
        throw new Error(`${repo}#${number}: comentário GitHub repetido ${key}`);
      if (key !== undefined) seen.add(String(key));
      comments.push(comment);
    }
    if (batch.length < 100) return comments;
    if (page === MAX_GITHUB_PAGES)
      throw new Error(
        `${repo}#${number}: comentários excederam o limite de paginação`,
      );
  }
}

export async function readGithubRecords({
  issues,
  organization,
  token,
  fetchImpl = fetch,
}) {
  const links = new Map();
  for (const issue of issues) {
    for (const link of collectGithubLinks(issue, organization))
      links.set(link.url, link);
  }
  const records = new Map();
  const queue = [...links.values()];
  const workers = Array.from(
    { length: Math.min(6, queue.length) },
    async () => {
      for (;;) {
        const link = queue.shift();
        if (!link) return;
        try {
          const path =
            link.kind === "pull"
              ? `/repos/${link.owner}/${link.repo}/pulls/${link.number}`
              : `/repos/${link.owner}/${link.repo}/issues/${link.number}`;
          const record = await githubGet(path, token, fetchImpl);
          const comments =
            link.kind === "issue"
              ? await readAllGithubComments({ ...link, token, fetchImpl })
              : [];
          records.set(link.url, {
            ...record,
            kind: link.kind,
            url: link.url,
            comments,
          });
        } catch (error) {
          if (!(error instanceof GithubRequestError)) throw error;
          records.set(link.url, {
            auditFailure: error.kind,
            status: error.status,
          });
        }
      }
    },
  );
  await Promise.all(workers);
  return records;
}

export async function readGithubRepositoryInventory({
  organization,
  token,
  fetchImpl = fetch,
}) {
  const active = [];
  const repositories = [];
  try {
    for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
      const batch = await githubGet(
        `/orgs/${organization}/repos?type=all&per_page=100&page=${page}`,
        token,
        fetchImpl,
      );
      for (const repo of batch.filter((candidate) => !candidate.archived)) {
        if (active.includes(repo.name))
          throw new Error(`GitHub repetiu o repositório ${repo.name}`);
        active.push(repo.name);
        repositories.push(repo);
      }
      if (batch.length < 100) break;
      if (page === MAX_GITHUB_PAGES)
        throw new Error("Inventário GitHub excedeu o limite de paginação");
    }
  } catch (error) {
    if (!(error instanceof GithubRequestError)) throw error;
    return {
      auditFailure: error.kind,
      status: error.status,
      active,
      issues: [],
      issueAuditFailures: {},
    };
  }
  const issues = [];
  const issueAuditFailures = {};
  const queue = repositories.filter((repo) => repo.has_issues !== false);
  const workers = Array.from(
    { length: Math.min(4, queue.length) },
    async () => {
      for (;;) {
        const repo = queue.shift();
        if (!repo) return;
        const seen = new Set();
        try {
          for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
            const batch = await githubGet(
              `/repos/${organization}/${repo.name}/issues?state=all&per_page=100&page=${page}`,
              token,
              fetchImpl,
            );
            for (const issue of batch) {
              if (issue.pull_request) continue;
              const url = `https://github.com/${organization}/${repo.name}/issues/${issue.number}`;
              if (seen.has(url))
                throw new Error(`${repo.name}: GitHub repetiu ${url}`);
              seen.add(url);
              issues.push({
                number: issue.number,
                repo: repo.name,
                state: issue.state,
                state_reason: issue.state_reason,
                url,
              });
            }
            if (batch.length < 100) break;
            if (page === MAX_GITHUB_PAGES)
              throw new Error(
                `${repo.name}: inventário de Issues excedeu o limite de paginação`,
              );
          }
        } catch (error) {
          if (!(error instanceof GithubRequestError)) throw error;
          issueAuditFailures[repo.name] = {
            kind: error.kind,
            status: error.status,
          };
        }
      }
    },
  );
  await Promise.all(workers);
  issues.sort((left, right) => left.url.localeCompare(right.url));
  return { active, issues, issueAuditFailures };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} é obrigatório`);
  return value;
}

async function main() {
  const linearToken = requiredEnvironment("LINEAR_READ_KEY");
  const githubToken = requiredEnvironment("GH_TOKEN");
  const commentGraceMinutes = Number(
    process.env.COMMENT_SYNC_GRACE_MINUTES || 30,
  );
  if (!Number.isFinite(commentGraceMinutes) || commentGraceMinutes < 0)
    throw new Error(
      "COMMENT_SYNC_GRACE_MINUTES deve ser finito e não negativo",
    );
  const releaseRequiredAfter = new Date(
    process.env.RELEASE_REQUIRED_AFTER || DEFAULT_RELEASE_REQUIRED_AFTER,
  );
  if (!Number.isFinite(releaseRequiredAfter.getTime()))
    throw new Error("RELEASE_REQUIRED_AFTER deve ser uma data válida");
  const organization =
    process.env.GITHUB_ORGANIZATION?.trim() || DEFAULT_ORGANIZATION;
  const umbrellaTeamKey =
    process.env.LINEAR_UMBRELLA_TEAM_KEY || DEFAULT_UMBRELLA_TEAM_KEY;
  const linearOnlyTeamKeys = parseLinearOnlyTeamKeys(
    process.env.LINEAR_ONLY_TEAM_KEYS,
    umbrellaTeamKey,
  );
  const [issues, linearTopology] = await Promise.all([
    readLinearIssues({ token: linearToken, linearOnlyTeamKeys }),
    readLinearTopology({
      token: linearToken,
      umbrellaTeamKey,
    }),
  ]);
  const [githubByUrl, repositoryInventory] = await Promise.all([
    readGithubRecords({ issues, organization, token: githubToken }),
    readGithubRepositoryInventory({ organization, token: githubToken }),
  ]);
  const result = reconcileSnapshots({
    linearIssues: issues,
    githubByUrl,
    linearTopology,
    repositoryInventory,
    organization,
    umbrellaTeamKey,
    linearOnlyTeamKeys,
    commentGraceMs: commentGraceMinutes * 60_000,
    releaseRequiredAfter,
  });
  const markdown = renderMarkdown(result);
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  if (process.env.RECONCILIATION_JSON) {
    await writeFile(
      process.env.RECONCILIATION_JSON,
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
  }
  process.exitCode = determineExitCode(result, {
    strictWarnings: process.env.STRICT_WARNINGS === "true",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  });
}
