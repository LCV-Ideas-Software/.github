import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_ORGANIZATION = "LCV-Ideas-Software";
const DEFAULT_UMBRELLA_TEAM_KEY = "LCV";
const DEFAULT_COMMENT_GRACE_MS = 30 * 60 * 1000;
const DEFAULT_RELEASE_REQUIRED_AFTER = new Date("2026-08-17T12:00:00.000Z");
const MAX_GITHUB_PAGES = 1_000;
const MAX_LINEAR_PAGES = 1_000;
const GITHUB_URL_CANDIDATE = /https:\/\/github\.com\/[^\s<>"']+/giu;
const GITHUB_COMMENT_TIME_TOLERANCE_MS = 1_000;
const MIN_INFORMATIVE_DESCRIPTION_WORDS = 5;
const MAX_DUPLICATE_COMPARISONS = 50_000;
const MAX_MARKDOWN_FINDING_DETAILS = 500;
const MAX_MARKDOWN_BYTES = 900 * 1024;
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
  if (!pageInfo || typeof pageInfo !== "object" || Array.isArray(pageInfo))
    throw new Error(`${label}: pageInfo ausente ou inválido`);
  if (typeof pageInfo.hasNextPage !== "boolean")
    throw new Error(`${label}: hasNextPage ausente ou inválido`);
  if (!Object.hasOwn(pageInfo, "endCursor"))
    throw new Error(`${label}: endCursor ausente`);
  if (
    pageInfo.endCursor !== null &&
    (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor)
  )
    throw new Error(`${label}: endCursor inválido`);
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

function canonicalCrossReference(owner, repo, number, context) {
  const full = `${owner}/${repo}#${number}`;
  if (
    context?.organization &&
    context?.repository &&
    githubUrlKey(owner) === githubUrlKey(context.organization) &&
    githubUrlKey(repo) === githubUrlKey(context.repository)
  ) {
    return `#${number}`;
  }
  return full;
}

function canonicalizeCrossReferenceLinks(value, context) {
  return String(value ?? "").replace(
    /\[([^\]\n]+)\]\(\s*<?(https?:\/\/[^)\s>]+)>?\s*\)/giu,
    (markdown, label, target) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return markdown;
      }
      if (parsed.protocol !== "https:" || parsed.port !== "") return markdown;
      const fullLabel = /^([\p{L}\p{N}_.-]+)\/([\p{L}\p{N}_.-]+)#(\d+)$/u.exec(
        label,
      );
      if (
        parsed.hostname.toLocaleLowerCase("en-US") === "linear.app" &&
        /\/review(?:\/|$)/u.test(parsed.pathname) &&
        fullLabel
      ) {
        return canonicalCrossReference(
          fullLabel[1],
          fullLabel[2],
          fullLabel[3],
          context,
        );
      }
      if (parsed.hostname.toLocaleLowerCase("en-US") !== "github.com")
        return markdown;
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (
        parts.length !== 4 ||
        !["issues", "pull"].includes(parts[2]) ||
        !/^\d+$/u.test(parts[3])
      ) {
        return markdown;
      }
      const [owner, repo, , number] = parts;
      const shortLabel = /^#(\d+)$/u.exec(label);
      const labelMatches =
        (shortLabel && shortLabel[1] === number) ||
        (fullLabel &&
          githubUrlKey(fullLabel[1]) === githubUrlKey(owner) &&
          githubUrlKey(fullLabel[2]) === githubUrlKey(repo) &&
          fullLabel[3] === number);
      return labelMatches
        ? canonicalCrossReference(owner, repo, number, context)
        : markdown;
    },
  );
}

function transformMarkdownProse(value, transform) {
  const protectedCode = [];
  const protect = (match) => {
    const index = protectedCode.push(match) - 1;
    return `\uE000${index}\uE001`;
  };
  let source = String(value ?? "").replace(/\r\n/g, "\n");
  source = source.replace(
    /(^|\n)([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2\3[ \t]*(?=\n|$)/gu,
    protect,
  );
  source = source.replace(
    /^(?: {4}|\t)[^\n]*(?:\n(?:[ \t]*\n)*(?: {4}|\t)[^\n]*)*/gmu,
    protect,
  );
  source = source.replace(/(`+)([^`\n]*?)\1/gu, protect);
  return transform(source).replace(
    /\uE000(\d+)\uE001/gu,
    (_match, index) => protectedCode[Number(index)],
  );
}

export function canonicalizeCommentBody(value, context) {
  return transformMarkdownProse(value, (prose) =>
    normalizeBody(canonicalizeCrossReferenceLinks(prose, context))
      .replace(/<(https?:\/\/[^>\s]+)>/gu, "$1")
      .replace(/^\s*[+*]\s+/gmu, "- ")
      .replace(/^\s*-\s+/gmu, "- "),
  );
}

function foldLatinDiacritics(value) {
  let output = "";
  let latinBase = false;
  for (const character of String(value).normalize("NFD")) {
    if (/\p{M}/u.test(character)) {
      if (!latinBase) output += character;
      continue;
    }
    latinBase = /\p{Script=Latin}/u.test(character);
    output += character;
  }
  return output.normalize("NFC");
}

function normalizeTitle(value) {
  const raw = normalizeBody(value).normalize("NFKC").toLocaleLowerCase("pt-BR");
  const normalized = foldLatinDiacritics(raw)
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
  return normalized || (raw ? `símbolo:${raw}` : "");
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

function wordSetOverlap(leftWords, rightWords) {
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

function duplicateRelationIdentifiers(issue) {
  const identifiers = new Set();
  if (issue.duplicateOf?.identifier)
    identifiers.add(issue.duplicateOf.identifier);
  for (const relation of [
    ...connectionNodes(issue.relations),
    ...connectionNodes(issue.inverseRelations),
  ]) {
    if (String(relation.type).toLocaleLowerCase("en-US") !== "duplicate")
      continue;
    const other =
      relation.issue?.identifier === issue.identifier
        ? relation.relatedIssue?.identifier
        : (relation.issue?.identifier ?? relation.relatedIssue?.identifier);
    if (other) identifiers.add(other);
  }
  return identifiers;
}

function linkedRepositories(issue, organization = DEFAULT_ORGANIZATION) {
  return new Set(
    collectGithubLinks(issue, organization).map((link) =>
      githubUrlKey(link.repo),
    ),
  );
}

function setsIntersect(leftRepos, rightRepos) {
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

function releaseTargetsCommit(release, commit, repo) {
  if (
    githubUrlKey(release.pipeline?.name) !==
    githubUrlKey(expectedPipelineForRepository(repo))
  )
    return false;
  if (release.pipeline?.type !== "continuous") return false;
  const exact = String(release.commitSha ?? "").toLowerCase();
  const version = String(release.version ?? release.name ?? "").toLowerCase();
  const candidate = commit.toLowerCase();
  if (!Object.hasOwn(release, "commitSha")) return false;
  if (release.commitSha !== null) return exact === candidate;
  return version.length >= 7 && candidate.startsWith(version);
}

function releaseCommitEvidenceConflicts(release, commit, repo) {
  if (
    githubUrlKey(release.pipeline?.name) !==
      githubUrlKey(expectedPipelineForRepository(repo)) ||
    release.pipeline?.type !== "continuous" ||
    !Object.hasOwn(release, "commitSha") ||
    release.commitSha === null
  )
    return false;
  const exact = String(release.commitSha).toLowerCase();
  const version = String(release.version ?? release.name ?? "").toLowerCase();
  const candidate = commit.toLowerCase();
  return (
    exact !== candidate && version.length >= 7 && candidate.startsWith(version)
  );
}

function releaseMatchesCommit(release, commit, repo) {
  return (
    releaseTargetsCommit(release, commit, repo) &&
    timestampIsValid(release.completedAt)
  );
}

function githubIssueState(record) {
  if (record.state === "open") return "active";
  if (record.state_reason === "not_planned") return "canceled";
  return "completed";
}

function githubIssueMetadataIsValid(record) {
  if (record?.state === "open")
    return [null, "reopened"].includes(record.state_reason);
  if (record?.state === "closed")
    return ["completed", "not_planned"].includes(record.state_reason);
  return false;
}

function timestampIsValid(value) {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function timestampsAreChronological(createdAt, updatedAt) {
  return (
    timestampIsValid(createdAt) &&
    timestampIsValid(updatedAt) &&
    Date.parse(updatedAt) >= Date.parse(createdAt)
  );
}

function timestampIsNotAfter(value, upperBound) {
  return timestampIsValid(value) && Date.parse(value) <= upperBound.getTime();
}

function githubPullMetadataIsValid(record, now) {
  if (typeof record?.merged !== "boolean") return false;
  if (!record.merged) return true;
  return (
    timestampIsNotAfter(record.merged_at, now) &&
    typeof record.merge_commit_sha === "string" &&
    /^[0-9a-f]{40}$/iu.test(record.merge_commit_sha)
  );
}

function githubCommentMetadataIsValid(comment, now) {
  const createdAt = comment?.created_at ?? comment?.createdAt;
  const updatedAt = comment?.updated_at ?? comment?.updatedAt;
  return (
    githubCommentStableIdentity(comment) !== null &&
    typeof comment?.body === "string" &&
    normalizeBody(comment.body).length > 0 &&
    timestampsAreChronological(createdAt, updatedAt) &&
    timestampIsNotAfter(updatedAt, now)
  );
}

function githubCommentStableIdentity(comment) {
  if (isNonemptyTrimmedString(comment?.node_id)) return comment.node_id;
  if (Number.isSafeInteger(comment?.id) && comment.id > 0)
    return String(comment.id);
  return null;
}

function linearCommentStableIdentity(comment) {
  return isNonemptyTrimmedString(comment?.id) ? comment.id : null;
}

function linearIssueStableIdentity(issue) {
  return isNonemptyTrimmedString(issue?.id) ? issue.id : null;
}

function assertUniqueLinearIssueIdentities(issues, label, seen = new Set()) {
  for (const issue of issues) {
    const id = linearIssueStableIdentity(issue);
    if (id === null) throw new Error(`${label}: id ausente ou inválido`);
    if (seen.has(id)) throw new Error(`${label}: id duplicado ${id}`);
    seen.add(id);
  }
  return seen;
}

function assertUniqueLinearCommentIdentities(
  comments,
  label,
  seen = new Set(),
) {
  for (const comment of comments) {
    const id = linearCommentStableIdentity(comment);
    if (id === null) throw new Error(`${label}: id ausente ou inválido`);
    if (seen.has(id)) throw new Error(`${label}: id duplicado ${id}`);
    seen.add(id);
  }
  return seen;
}

function linearCommentMetadataIsValid(comment, now) {
  const createdAt = comment?.createdAt ?? comment?.created_at;
  const updatedAt = comment?.updatedAt ?? comment?.updated_at;
  return (
    linearCommentStableIdentity(comment) !== null &&
    typeof comment?.body === "string" &&
    normalizeBody(comment.body).length > 0 &&
    Array.isArray(comment.syncedWith) &&
    comment.syncedWith.every(
      (entity) =>
        entity &&
        typeof entity === "object" &&
        !Array.isArray(entity) &&
        isNonemptyTrimmedString(entity.id) &&
        isNonemptyTrimmedString(entity.service),
    ) &&
    Object.hasOwn(comment, "externalThread") &&
    linearExternalThreadMetadataIsValid(comment.externalThread) &&
    timestampsAreChronological(createdAt, updatedAt) &&
    timestampIsNotAfter(updatedAt, now)
  );
}

function linearIssueState(issue) {
  if (["canceled", "duplicate"].includes(issue.state?.type)) return "canceled";
  if (issue.state?.type === "completed") return "completed";
  return "active";
}

function isNonemptyTrimmedString(value) {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function nullableLinearTimestampFieldIsValid(record, field) {
  return (
    Object.hasOwn(record, field) &&
    (record[field] === null || timestampIsValid(record[field]))
  );
}

function linearTeamMetadataIsValid(team) {
  return (
    team &&
    typeof team === "object" &&
    !Array.isArray(team) &&
    isNonemptyTrimmedString(team.id) &&
    isNonemptyTrimmedString(team.key) &&
    isNonemptyTrimmedString(team.name) &&
    nullableLinearTimestampFieldIsValid(team, "archivedAt") &&
    nullableLinearTimestampFieldIsValid(team, "retiredAt")
  );
}

function linearTeamIdentityIsValid(team) {
  return (
    team &&
    typeof team === "object" &&
    !Array.isArray(team) &&
    isNonemptyTrimmedString(team.id) &&
    isNonemptyTrimmedString(team.key) &&
    isNonemptyTrimmedString(team.name)
  );
}

function linearCycleMetadataIsValid(cycle) {
  return (
    cycle &&
    typeof cycle === "object" &&
    !Array.isArray(cycle) &&
    isNonemptyTrimmedString(cycle.id) &&
    Object.hasOwn(cycle, "name") &&
    (cycle.name === null || isNonemptyTrimmedString(cycle.name)) &&
    Number.isSafeInteger(cycle.number) &&
    cycle.number > 0 &&
    nullableLinearTimestampFieldIsValid(cycle, "archivedAt")
  );
}

function linearProjectMetadataIsValid(project) {
  return (
    project &&
    typeof project === "object" &&
    !Array.isArray(project) &&
    isNonemptyTrimmedString(project.id) &&
    isNonemptyTrimmedString(project.name) &&
    nullableLinearTimestampFieldIsValid(project, "archivedAt")
  );
}

function linearInitiativeMetadataIsValid(initiative, teamId) {
  return (
    initiative &&
    typeof initiative === "object" &&
    !Array.isArray(initiative) &&
    isNonemptyTrimmedString(initiative.id) &&
    isNonemptyTrimmedString(initiative.name) &&
    nullableLinearTimestampFieldIsValid(initiative, "archivedAt") &&
    linearTeamIdentityIsValid(initiative.leadTeam) &&
    initiative.leadTeam.id === teamId
  );
}

function linearDocumentMetadataIsValid(document, teamId) {
  return (
    document &&
    typeof document === "object" &&
    !Array.isArray(document) &&
    isNonemptyTrimmedString(document.id) &&
    isNonemptyTrimmedString(document.title) &&
    isNonemptyTrimmedString(document.slugId) &&
    nullableLinearTimestampFieldIsValid(document, "archivedAt") &&
    linearTeamIdentityIsValid(document.team) &&
    document.team.id === teamId
  );
}

function linearExternalThreadMetadataIsValid(thread) {
  if (thread === null) return true;
  return (
    thread &&
    typeof thread === "object" &&
    !Array.isArray(thread) &&
    isNonemptyTrimmedString(thread.id) &&
    typeof thread.isConnected === "boolean" &&
    Object.hasOwn(thread, "name") &&
    (thread.name === null || typeof thread.name === "string") &&
    Object.hasOwn(thread, "subType") &&
    (thread.subType === null || typeof thread.subType === "string") &&
    Object.hasOwn(thread, "type") &&
    (thread.type === null || isNonemptyTrimmedString(thread.type)) &&
    Object.hasOwn(thread, "url") &&
    (thread.url === null || isNonemptyTrimmedString(thread.url))
  );
}

function linearAttachmentMetadataIsValid(attachment) {
  return (
    attachment &&
    typeof attachment === "object" &&
    !Array.isArray(attachment) &&
    isNonemptyTrimmedString(attachment.id) &&
    isNonemptyTrimmedString(attachment.title) &&
    isNonemptyTrimmedString(attachment.url)
  );
}

function linearIssueReferenceMetadataIsValid(reference) {
  return (
    reference &&
    typeof reference === "object" &&
    !Array.isArray(reference) &&
    isNonemptyTrimmedString(reference.id) &&
    isNonemptyTrimmedString(reference.identifier)
  );
}

function linearRelationMetadataIsValid(relation) {
  return (
    relation &&
    typeof relation === "object" &&
    !Array.isArray(relation) &&
    isNonemptyTrimmedString(relation.id) &&
    ["blocks", "duplicate", "related", "similar"].includes(relation.type) &&
    linearIssueReferenceMetadataIsValid(relation.issue) &&
    linearIssueReferenceMetadataIsValid(relation.relatedIssue)
  );
}

function linearConnectionNodeIdentitiesAreUnique(nodes) {
  const ids = nodes.map((node) =>
    isNonemptyTrimmedString(node?.id) ? node.id : null,
  );
  return ids.every(Boolean) && new Set(ids).size === ids.length;
}

function linearIssueMetadataIsValid(issue, now) {
  const connectionNames = [
    "attachments",
    "relations",
    "inverseRelations",
    "releases",
    "comments",
  ];
  const nodeValidators = {
    attachments: linearAttachmentMetadataIsValid,
    relations: linearRelationMetadataIsValid,
    inverseRelations: linearRelationMetadataIsValid,
    releases: (release) => linearReleaseMetadataIsValid(release, now),
    comments: (comment) => linearCommentMetadataIsValid(comment, now),
  };
  return (
    issue &&
    isNonemptyTrimmedString(issue.id) &&
    isNonemptyTrimmedString(issue.identifier) &&
    isNonemptyTrimmedString(issue.title) &&
    isNonemptyTrimmedString(issue.url) &&
    timestampIsValid(issue.updatedAt) &&
    isNonemptyTrimmedString(issue.team?.id) &&
    isNonemptyTrimmedString(issue.team?.key) &&
    isNonemptyTrimmedString(issue.team?.name) &&
    isNonemptyTrimmedString(issue.state?.id) &&
    isNonemptyTrimmedString(issue.state?.name) &&
    [
      "triage",
      "backlog",
      "unstarted",
      "started",
      "completed",
      "canceled",
      "duplicate",
    ].includes(issue.state.type) &&
    Array.isArray(issue.syncedWith) &&
    connectionNames.every(
      (name) =>
        issue[name] &&
        typeof issue[name] === "object" &&
        !Array.isArray(issue[name]) &&
        Array.isArray(issue[name].nodes) &&
        issue[name].pageInfo &&
        typeof issue[name].pageInfo === "object" &&
        issue[name].pageInfo.hasNextPage === false &&
        Object.hasOwn(issue[name].pageInfo, "endCursor") &&
        (issue[name].pageInfo.endCursor === null ||
          isNonemptyTrimmedString(issue[name].pageInfo.endCursor)) &&
        linearConnectionNodeIdentitiesAreUnique(issue[name].nodes) &&
        issue[name].nodes.every(nodeValidators[name]),
    )
  );
}

function linearReleaseMetadataIsValid(release, now) {
  return (
    release &&
    typeof release.id === "string" &&
    release.id.trim() === release.id &&
    release.id.length > 0 &&
    typeof release.name === "string" &&
    release.name.trim() === release.name &&
    release.name.length > 0 &&
    release.pipeline &&
    typeof release.pipeline.id === "string" &&
    release.pipeline.id.trim() === release.pipeline.id &&
    release.pipeline.id.length > 0 &&
    typeof release.pipeline.name === "string" &&
    release.pipeline.name.trim() === release.pipeline.name &&
    release.pipeline.name.length > 0 &&
    ["continuous", "scheduled"].includes(release.pipeline.type) &&
    Object.hasOwn(release, "version") &&
    (release.version === null || isNonemptyTrimmedString(release.version)) &&
    Object.hasOwn(release, "commitSha") &&
    (release.commitSha === null ||
      (isNonemptyTrimmedString(release.commitSha) &&
        /^[0-9a-f]{40}$/iu.test(release.commitSha))) &&
    Object.hasOwn(release, "completedAt") &&
    (release.completedAt === null ||
      timestampIsNotAfter(release.completedAt, now))
  );
}

function isGithubService(value) {
  return String(value ?? "").toLocaleLowerCase("en-US") === "github";
}

function hasNativeGithubSync(issue) {
  return (issue.syncedWith ?? []).some((entity) =>
    isGithubService(entity.service),
  );
}

function hasGithubHostUrl(value) {
  try {
    return new URL(value).hostname.toLocaleLowerCase("en-US") === "github.com";
  } catch {
    return false;
  }
}

function isGithubExternalThread(thread) {
  return Boolean(
    thread &&
    (isGithubService(thread.subType) ||
      isGithubService(thread.name) ||
      hasGithubHostUrl(thread.url)),
  );
}

function hasGithubSyncedEntity(comment) {
  return (comment?.syncedWith ?? []).some((entity) =>
    isGithubService(entity.service),
  );
}

function hasGithubSyncedComment(issue) {
  return connectionNodes(issue.comments).some(hasGithubSyncedEntity);
}

function hasConnectedGithubExternalThread(issue) {
  return connectionNodes(issue.comments).some((comment) => {
    const thread = comment.externalThread;
    return thread?.isConnected !== false && isGithubExternalThread(thread);
  });
}

export function isGithubSyncedComment(linearComment, githubComment) {
  const githubExternalIds = new Set(
    [githubComment.node_id, githubComment.nodeId, githubComment.id]
      .filter((value) => value !== undefined && value !== null)
      .map(String),
  );
  if (
    githubExternalIds.size > 0 &&
    (linearComment.syncedWith ?? []).some(
      (entity) =>
        isGithubService(entity.service) &&
        entity.id !== undefined &&
        entity.id !== null &&
        githubExternalIds.has(String(entity.id)),
    )
  ) {
    return true;
  }
  if (hasGithubSyncedEntity(linearComment)) return false;
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
  const githubExternalIds = new Set(
    [githubComment.node_id, githubComment.nodeId, githubComment.id]
      .filter((value) => value !== undefined && value !== null)
      .map(String),
  );
  return Boolean(
    githubExternalIds.size > 0 &&
    (linearComment.syncedWith ?? []).some(
      (entity) =>
        isGithubService(entity.service) &&
        entity.id !== undefined &&
        entity.id !== null &&
        githubExternalIds.has(String(entity.id)),
    ),
  );
}

function hasConnectedGithubExternalThreadComment(linearComment) {
  const thread = linearComment?.externalThread;
  return Boolean(
    thread?.isConnected !== false && isGithubExternalThread(thread),
  );
}

function commentsShareCreatedAt(linearComment, githubComment) {
  const linearTime = Date.parse(
    linearComment.createdAt ?? linearComment.created_at ?? "",
  );
  const githubTime = Date.parse(
    githubComment.created_at ?? githubComment.createdAt ?? "",
  );
  return (
    Number.isFinite(linearTime) &&
    Number.isFinite(githubTime) &&
    Math.abs(linearTime - githubTime) <= GITHUB_COMMENT_TIME_TOLERANCE_MS
  );
}

function integrationAnchorPairStatus(
  linearComment,
  githubComment,
  { organization, githubIssueUrl, linearIssueUrl, linearIdentifier },
) {
  const linearBody = normalizeBody(linearComment?.body);
  const githubBody = String(githubComment?.body ?? "");
  const linearAnchor =
    /^This comment thread is synced to a corresponding \[GitHub issue\]\((https:\/\/github\.com\/[^)\s]+)\)\. All replies are displayed in both locations\.$/iu.exec(
      linearBody,
    );
  const githubLinkback =
    /^\s*<!--\s*linear-linkback\s*-->\s*<p>\s*<a\s+href=["']([^"']+)["']\s*>([^<]+)<\/a>\s*<\/p>\s*$/iu.exec(
      githubBody,
    );
  const isPair =
    /This comment thread is synced to a corresponding \[GitHub (?:issue|pull request)\]/iu.test(
      linearBody,
    ) && /<!--\s*linear-linkback\s*-->/iu.test(githubBody);
  if (!isPair) return null;
  const anchorTarget = linearAnchor?.[1];
  const anchorLink = githubLinkFromUrl(anchorTarget ?? "", organization);
  let linearTargetMatches = false;
  if (githubLinkback) {
    try {
      const parsed = new URL(githubLinkback[1]);
      const expected = new URL(linearIssueUrl);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const expectedSegments = expected.pathname.split("/").filter(Boolean);
      const issueIndex = segments.findIndex(
        (segment) => segment.toLocaleLowerCase("en-US") === "issue",
      );
      const expectedIssueIndex = expectedSegments.findIndex(
        (segment) => segment.toLocaleLowerCase("en-US") === "issue",
      );
      const sameWorkspace =
        issueIndex >= 0 &&
        expectedIssueIndex >= 0 &&
        issueIndex === expectedIssueIndex &&
        segments.slice(0, issueIndex).map(githubUrlKey).join("/") ===
          expectedSegments
            .slice(0, expectedIssueIndex)
            .map(githubUrlKey)
            .join("/");
      linearTargetMatches =
        parsed.protocol === "https:" &&
        parsed.port === "" &&
        parsed.hostname.toLocaleLowerCase("en-US") === "linear.app" &&
        expected.protocol === "https:" &&
        expected.port === "" &&
        expected.hostname.toLocaleLowerCase("en-US") === "linear.app" &&
        sameWorkspace &&
        segments[issueIndex + 1]?.toLocaleLowerCase("en-US") ===
          linearIdentifier.toLocaleLowerCase("en-US") &&
        normalizeBody(githubLinkback[2]).toLocaleLowerCase("en-US") ===
          linearIdentifier.toLocaleLowerCase("en-US");
    } catch {
      linearTargetMatches = false;
    }
  }
  return {
    valid:
      Boolean(linearAnchor) &&
      Boolean(githubLinkback) &&
      anchorLink?.kind === "issue" &&
      githubUrlKey(anchorLink.url) === githubUrlKey(githubIssueUrl) &&
      linearTargetMatches,
  };
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
      !hasGithubSyncedEntity(linearComment) &&
      hasConnectedGithubExternalThreadComment(linearComment) &&
      isGithubSyncedComment(linearComment, githubComment),
  );
  pairPass(
    (linearComment, githubComment) =>
      !hasGithubSyncedEntity(linearComment) &&
      hasConnectedGithubExternalThreadComment(linearComment) &&
      commentsShareCreatedAt(linearComment, githubComment),
  );
  return { pairs, usedLinear };
}

function graphqlTokens(document) {
  const source = String(document);
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/[,\s\uFEFF]/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "#") {
      while (index < source.length && !/[\r\n]/u.test(source[index]))
        index += 1;
      continue;
    }
    if (source.startsWith('"""', index)) {
      index += 3;
      let closed = false;
      while (index < source.length) {
        if (source.startsWith('\\"""', index)) {
          index += 4;
          continue;
        }
        if (source.startsWith('"""', index)) {
          index += 3;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed)
        throw new Error("String de bloco GraphQL não foi encerrada.");
      continue;
    }
    if (character === '"') {
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error("String GraphQL não foi encerrada.");
      continue;
    }
    const name = source.slice(index).match(/^[_A-Za-z][_0-9A-Za-z]*/u)?.[0];
    if (name) {
      tokens.push({ kind: "name", value: name.toLocaleLowerCase("en-US") });
      index += name.length;
      continue;
    }
    if (source.startsWith("...", index)) {
      tokens.push({ kind: "punctuator", value: "..." });
      index += 3;
      continue;
    }
    tokens.push({ kind: "punctuator", value: character });
    index += 1;
  }
  return tokens;
}

function selectionEnd(tokens, selectionStart) {
  let depth = 0;
  for (let index = selectionStart; index < tokens.length; index += 1) {
    if (tokens[index].value === "{") depth += 1;
    if (tokens[index].value === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) break;
    }
  }
  throw new Error("Seleção GraphQL não foi encerrada.");
}

function definitionSelectionStart(tokens, definitionStart) {
  let parentheses = 0;
  let brackets = 0;
  for (let index = definitionStart; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "(") parentheses += 1;
    else if (value === ")") parentheses -= 1;
    else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    else if (value === "{" && parentheses === 0 && brackets === 0) return index;
    if (parentheses < 0 || brackets < 0)
      throw new Error("Preâmbulo GraphQL tem delimitadores inválidos.");
  }
  throw new Error("Definição GraphQL não contém seleção.");
}

export function assertReadOnlyGraphql(query) {
  if (typeof query !== "string") {
    throw new TypeError("A consulta GraphQL deve ser fornecida como string.");
  }
  const tokens = graphqlTokens(query);
  let index = 0;
  let queryDefinitions = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === "{") {
      queryDefinitions += 1;
      index = selectionEnd(tokens, index);
      continue;
    }
    if (token.kind !== "name") {
      throw new Error("Documento GraphQL contém uma definição inválida.");
    }
    if (token.value === "mutation" || token.value === "subscription") {
      throw new Error(
        `O reconciliador aceita somente consultas GraphQL; ${token.value} foi recusada.`,
      );
    }
    if (token.value !== "query" && token.value !== "fragment") {
      throw new Error(
        "Documento GraphQL contém uma definição não reconhecida.",
      );
    }
    if (token.value === "query") queryDefinitions += 1;
    const selectionStart = definitionSelectionStart(tokens, index + 1);
    index = selectionEnd(tokens, selectionStart);
  }
  if (queryDefinitions === 0) {
    throw new Error(
      "O reconciliador aceita somente documentos GraphQL que contenham uma consulta.",
    );
  }
}

function githubLinkFromSyncedEntity(entity, organization) {
  if (!isGithubService(entity?.service)) return null;
  const metadata = entity.metadata;
  const canonicalNumber =
    typeof metadata?.number === "number"
      ? Number.isSafeInteger(metadata.number) && metadata.number > 0
        ? metadata.number
        : null
      : typeof metadata?.number === "string" &&
          /^[1-9]\d*$/u.test(metadata.number) &&
          Number.isSafeInteger(Number(metadata.number))
        ? Number(metadata.number)
        : null;
  if (
    typeof metadata?.owner !== "string" ||
    metadata.owner.trim() === "" ||
    metadata.owner !== metadata.owner.trim() ||
    typeof metadata?.repo !== "string" ||
    metadata.repo.trim() === "" ||
    metadata.repo !== metadata.repo.trim() ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(metadata.repo) ||
    metadata.repo === "." ||
    metadata.repo === ".." ||
    canonicalNumber === null
  ) {
    return null;
  }
  const owner = metadata.owner.trim();
  if (
    owner.toLocaleLowerCase("en-US") !== organization.toLocaleLowerCase("en-US")
  )
    return null;
  const number = canonicalNumber;
  const repo = metadata.repo;
  return {
    kind: "issue",
    number,
    owner: organization,
    repo,
    url: `https://github.com/${organization}/${repo}/issues/${number}`,
  };
}

function parseGithubResourceUrl(raw) {
  const candidate = String(raw).replace(/[),.;:!?}\]`]+$/u, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.hostname.toLocaleLowerCase("en-US") !== "github.com"
  ) {
    return null;
  }
  const path = parsed.pathname.match(
    /^\/([a-z0-9-]+)\/([a-z0-9_.-]+)\/(issues|pull)\/([1-9]\d*)(?:\/.*)?$/iu,
  );
  if (!path) return null;
  const [, owner, repo, resource, numberText] = path;
  const kind =
    resource.toLocaleLowerCase("en-US") === "pull" ? "pull" : "issue";
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) return null;
  const normalizedResource = kind === "pull" ? "pull" : "issues";
  return {
    kind,
    number,
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}/${normalizedResource}/${number}`,
  };
}

function githubLinkFromUrl(raw, organization) {
  const link = parseGithubResourceUrl(raw);
  if (
    !link ||
    link.owner.toLocaleLowerCase("en-US") !==
      organization.toLocaleLowerCase("en-US")
  )
    return null;
  return {
    ...link,
    owner: organization,
    url: `https://github.com/${organization}/${link.repo}/${link.kind === "pull" ? "pull" : "issues"}/${link.number}`,
  };
}

function collectExternalOrganizationGithubLinks(issue, organization) {
  const links = new Map();
  const sources = [
    issue.description,
    ...connectionNodes(issue.attachments).map((attachment) => attachment.url),
    ...connectionNodes(issue.comments).map((comment) => comment.body),
  ];
  for (const source of sources) {
    if (!source) continue;
    GITHUB_URL_CANDIDATE.lastIndex = 0;
    for (const [raw] of String(source).matchAll(GITHUB_URL_CANDIDATE)) {
      const link = parseGithubResourceUrl(raw);
      if (
        link &&
        link.owner.toLocaleLowerCase("en-US") !==
          organization.toLocaleLowerCase("en-US")
      ) {
        links.set(githubUrlKey(link.url), link);
      }
    }
  }
  return [...links.values()].sort((left, right) =>
    left.url.localeCompare(right.url),
  );
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
    ...connectionNodes(issue.comments).map(
      (comment) => comment.externalThread?.url,
    ),
  ];
  for (const source of sources) {
    if (!source) continue;
    GITHUB_URL_CANDIDATE.lastIndex = 0;
    for (const [raw] of String(source).matchAll(GITHUB_URL_CANDIDATE)) {
      const link = githubLinkFromUrl(raw, organization);
      if (link) links.set(link.url.toLocaleLowerCase("en-US"), link);
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

function collectInvalidNativeGithubSyncs(issue, organization) {
  return (issue.syncedWith ?? []).filter(
    (entity) =>
      isGithubService(entity?.service) &&
      !githubLinkFromSyncedEntity(entity, organization),
  );
}

function collectExternalThreadIssueLinks(issue, organization) {
  const links = new Map();
  for (const comment of connectionNodes(issue.comments)) {
    const raw = comment.externalThread?.url;
    if (!raw) continue;
    const link = githubLinkFromUrl(raw, organization);
    if (link?.kind === "issue") links.set(githubUrlKey(link.url), link);
  }
  return [...links.values()];
}

function mappedRepositoryForIssue(
  issue,
  teamRepositories = DEFAULT_TEAM_REPOSITORIES,
) {
  return (
    teamRepositories[issue.team?.key] ??
    (issue.team?.name === ".github-org" ? ".github" : issue.team?.name)
  );
}

function resolveEffectiveTeamRepositories({
  teamRepositories = DEFAULT_TEAM_REPOSITORIES,
  linearTopology,
  linearIssues = [],
  repositoryInventory,
  linearOnlyTeamKeys = [],
}) {
  const linearOnlyTeams =
    linearOnlyTeamKeys instanceof Set
      ? linearOnlyTeamKeys
      : new Set(linearOnlyTeamKeys);
  const activeRepositories = new Map(
    (repositoryInventory?.active ?? []).map((repo) => [
      githubUrlKey(repo),
      repo,
    ]),
  );
  const effective = { ...teamRepositories };
  for (const key of linearOnlyTeams) delete effective[key];
  for (const team of linearTopology?.teams ?? []) {
    if (linearOnlyTeams.has(team.key)) continue;
    const candidateRepository =
      team.name === ".github-org" ? ".github" : team.name;
    if (activeRepositories.has(githubUrlKey(candidateRepository))) {
      effective[team.key] = activeRepositories.get(
        githubUrlKey(candidateRepository),
      );
    }
  }
  for (const issue of linearIssues) {
    if (linearOnlyTeams.has(issue.team?.key)) continue;
    if (activeRepositories.has(githubUrlKey(issue.team?.name))) {
      effective[issue.team.key] = activeRepositories.get(
        githubUrlKey(issue.team.name),
      );
    }
  }
  return effective;
}

function collectGithubCommentAuditUrls(
  issue,
  organization,
  {
    teamRepositories = DEFAULT_TEAM_REPOSITORIES,
    linearOnlyTeamKeys = [],
  } = {},
) {
  if (new Set(linearOnlyTeamKeys).has(issue.team?.key)) return new Set();
  const urls = new Set(
    collectExternalThreadIssueLinks(issue, organization).map((link) =>
      githubUrlKey(link.url),
    ),
  );
  const mappedRepository = mappedRepositoryForIssue(issue, teamRepositories);
  if (!mappedRepository) return urls;
  const mappedNativeIssueLinks = collectNativeGithubIssueLinks(
    issue,
    organization,
  ).filter((link) => sameGithubRepository(link.repo, mappedRepository));
  const mappedAttachmentIssueLinks = collectAttachmentIssueLinks(
    issue,
    organization,
  ).filter((link) => sameGithubRepository(link.repo, mappedRepository));
  const canonicalCandidates = new Map(
    (mappedNativeIssueLinks.length > 0
      ? mappedNativeIssueLinks
      : mappedAttachmentIssueLinks
    ).map((link) => [githubUrlKey(link.url), link]),
  );
  if (canonicalCandidates.size === 1) {
    urls.add(canonicalCandidates.keys().next().value);
  }
  return urls;
}

function commentsForGithubLink(issue, link, organization, isCanonical) {
  const comments = connectionNodes(issue.comments);
  const target = githubUrlKey(link.url);
  return comments.filter((comment) => {
    const rawThreadUrl = comment.externalThread?.url;
    const threadLink = githubLinkFromUrl(rawThreadUrl ?? "", organization);
    if (threadLink) return githubUrlKey(threadLink.url) === target;
    return (
      isCanonical &&
      !rawThreadUrl &&
      ((comment.syncedWith ?? []).some((entity) =>
        isGithubService(entity.service),
      ) ||
        isGithubService(comment.externalThread?.subType) ||
        isGithubService(comment.externalThread?.name))
    );
  });
}

function addBucketIndex(buckets, key, feature) {
  const components = buckets.get(key) ?? new Map();
  const existing = components.get(feature.reconciliationComponent) ?? [];
  existing.push(feature.index);
  components.set(feature.reconciliationComponent, existing);
  buckets.set(key, components);
}

function collectBucketIndexes(buckets, key, right, candidateIndexes) {
  for (const [component, indexes] of buckets.get(key) ?? []) {
    if (component === right.reconciliationComponent) continue;
    for (const index of indexes) candidateIndexes.add(index);
  }
}

function duplicateIssueFeatures(issue, index, organization, linearOnlyTeams) {
  const repositories = linkedRepositories(issue, organization);
  if (repositories.size === 0 && linearOnlyTeams.has(issue.team?.key)) {
    repositories.add(`linear-only-team:${githubUrlKey(issue.team.key)}`);
  }
  return {
    index,
    issue,
    normalizedTitle: normalizeTitle(issue.title),
    titleWords: titleWordSet(issue.title),
    descriptionWords: wordSet(issue.description),
    repositories,
    relatedIdentifiers: issueRelationIdentifiers(issue),
    duplicateIdentifiers: duplicateRelationIdentifiers(issue),
  };
}

function assignExplicitRelationComponents(features) {
  const parent = features.map((_, index) => index);
  const identifierIndexes = new Map(
    features.map((feature) => [feature.issue.identifier, feature.index]),
  );
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  for (const feature of features) {
    for (const relatedIdentifier of feature.duplicateIdentifiers) {
      const relatedIndex = identifierIndexes.get(relatedIdentifier);
      if (relatedIndex !== undefined) union(feature.index, relatedIndex);
    }
  }
  for (const feature of features) {
    feature.reconciliationComponent = find(feature.index);
  }
}

function featuresAreExplicitlyReconciled(left, right) {
  return (
    left.reconciliationComponent === right.reconciliationComponent ||
    left.relatedIdentifiers.has(right.issue.identifier) ||
    right.relatedIdentifiers.has(left.issue.identifier)
  );
}

function repositoryTitleTokenPairKeys(feature) {
  const keys = [];
  const titleWords = [...feature.titleWords].sort();
  if (titleWords.length < 2) return keys;
  for (const repository of feature.repositories) {
    for (let left = 0; left < titleWords.length - 1; left += 1) {
      for (let right = left + 1; right < titleWords.length; right += 1) {
        keys.push(
          `${repository}\u0000${titleWords[left]}\u0000${titleWords[right]}`,
        );
      }
    }
  }
  return keys;
}

function duplicateFinding(left, right) {
  if (featuresAreExplicitlyReconciled(left, right)) return null;
  const titlesMatch = left.normalizedTitle === right.normalizedTitle;
  const descriptionSimilarity = jaccard(
    left.descriptionWords,
    right.descriptionWords,
  );
  const descriptionsAreInformative =
    left.descriptionWords.size >= MIN_INFORMATIVE_DESCRIPTION_WORDS &&
    right.descriptionWords.size >= MIN_INFORMATIVE_DESCRIPTION_WORDS;
  const sameRepository = setsIntersect(left.repositories, right.repositories);
  if (
    titlesMatch &&
    descriptionsAreInformative &&
    descriptionSimilarity >= 0.85 &&
    sameRepository
  ) {
    return {
      severity: "error",
      code: "duplicate_candidate",
      issue: `${left.issue.identifier}, ${right.issue.identifier}`,
      message:
        `título, escopo e repositório coincidem (${Math.round(descriptionSimilarity * 100)}%); ` +
        "registre duplicateOf ou uma relação explícita",
    };
  }
  if (titlesMatch) {
    if (!descriptionsAreInformative) return null;
    return {
      severity: "warning",
      code: "similar_issue_unlinked",
      issue: `${left.issue.identifier}, ${right.issue.identifier}`,
      message:
        `título idêntico entre issues ainda não relacionados ` +
        `(${Math.round(descriptionSimilarity * 100)}% de similaridade textual), sem relação explícita`,
    };
  }
  const titleSimilarity = wordSetOverlap(left.titleWords, right.titleWords);
  if (
    sameRepository &&
    descriptionsAreInformative &&
    descriptionSimilarity >= 0.85 &&
    titleSimilarity.intersection >= 2 &&
    titleSimilarity.overlap >= 2 / 3 &&
    titleSimilarity.jaccard >= 0.5
  ) {
    return {
      severity: "warning",
      code: "similar_issue_unlinked",
      issue: `${left.issue.identifier}, ${right.issue.identifier}`,
      message:
        `títulos possivelmente parafraseados (${Math.round(titleSimilarity.overlap * 100)}% de cobertura), ` +
        `descrições equivalentes (${Math.round(descriptionSimilarity * 100)}%) e mesmo repositório; ` +
        "revise e registre duplicateOf ou uma relação explícita",
    };
  }
  return null;
}

function findStrongDuplicateCandidates(
  linearIssues,
  organization = DEFAULT_ORGANIZATION,
  linearOnlyTeams = new Set(),
) {
  const findings = [];
  const features = linearIssues.map((issue, index) =>
    duplicateIssueFeatures(issue, index, organization, linearOnlyTeams),
  );
  assignExplicitRelationComponents(features);
  const exactTitleBuckets = new Map();
  const repositoryTokenPairBuckets = new Map();
  let comparisons = 0;
  scan: for (const right of features) {
    // Every duplicate/similarity branch requires informative descriptions.
    // Do not spend the bounded comparison budget on pairs that cannot produce
    // a finding.
    if (right.descriptionWords.size < MIN_INFORMATIVE_DESCRIPTION_WORDS)
      continue;
    const candidateIndexes = new Set();
    if (right.normalizedTitle) {
      collectBucketIndexes(
        exactTitleBuckets,
        right.normalizedTitle,
        right,
        candidateIndexes,
      );
    }
    const tokenPairKeys = repositoryTitleTokenPairKeys(right);
    for (const key of tokenPairKeys) {
      collectBucketIndexes(
        repositoryTokenPairBuckets,
        key,
        right,
        candidateIndexes,
      );
    }
    for (const leftIndex of candidateIndexes) {
      if (comparisons >= MAX_DUPLICATE_COMPARISONS) {
        findings.push({
          severity: "incomplete",
          code: "duplicate_scan_incomplete",
          issue: "Linear",
          message:
            `varredura interrompida após ${MAX_DUPLICATE_COMPARISONS} comparações candidatas; ` +
            "o snapshot não pode ser considerado limpo",
        });
        break scan;
      }
      comparisons += 1;
      const finding = duplicateFinding(features[leftIndex], right);
      if (finding) findings.push(finding);
    }
    if (right.normalizedTitle) {
      addBucketIndex(exactTitleBuckets, right.normalizedTitle, right);
    }
    for (const key of tokenPairKeys) {
      addBucketIndex(repositoryTokenPairBuckets, key, right);
    }
  }
  return findings;
}

function githubIssueInventoryComplete(link, repositoryInventory) {
  const inventoryFailure = Object.entries(
    repositoryInventory?.issueAuditFailures ?? {},
  ).find(([repo]) => sameGithubRepository(repo, link.repo))?.[1];
  return Boolean(
    link.kind === "issue" &&
    !repositoryInventory?.auditFailure &&
    Array.isArray(repositoryInventory?.issues) &&
    (repositoryInventory.active ?? []).some((repo) =>
      sameGithubRepository(repo, link.repo),
    ) &&
    (repositoryInventory.issuesEnabled ?? []).some((repo) =>
      sameGithubRepository(repo, link.repo),
    ) &&
    !inventoryFailure,
  );
}

function githubIssueInventoryContains(link, repositoryInventory) {
  return Boolean(
    githubIssueInventoryComplete(link, repositoryInventory) &&
    repositoryInventory.issues.some(
      (candidate) => githubUrlKey(candidate.url) === githubUrlKey(link.url),
    ),
  );
}

function githubFailureFinding(issue, link, record, repositoryInventory) {
  if (record?.auditFailure === "resource_kind_mismatch") {
    return {
      severity: "error",
      code: "github_resource_kind_mismatch",
      issue: issue.identifier,
      message: `${link.url} foi declarado como Issue, mas a API o identificou como Pull Request`,
    };
  }
  const inventoryComplete = githubIssueInventoryComplete(
    link,
    repositoryInventory,
  );
  const absentFromInventory =
    inventoryComplete &&
    !githubIssueInventoryContains(link, repositoryInventory);
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
  linearOnlyNoGithubSyncAttestedTeamKeys = [],
  linearGithubIntegrationAttestation = "",
}) {
  if (!Number.isFinite(now?.getTime?.()))
    throw new Error("now deve ser uma data válida");
  if (!Number.isFinite(commentGraceMs) || commentGraceMs < 0)
    throw new Error("commentGraceMs deve ser finito e não negativo");
  if (!Number.isFinite(releaseRequiredAfter?.getTime?.()))
    throw new Error("releaseRequiredAfter deve ser uma data válida");
  const findings = [];
  const linearOnlyTeams = new Set(linearOnlyTeamKeys);
  const noGithubSyncAttestedTeams = new Set(
    linearOnlyNoGithubSyncAttestedTeamKeys,
  );
  if (linearOnlyTeams.size !== linearOnlyTeamKeys.length)
    throw new Error("linearOnlyTeamKeys contém duplicata");
  if (
    noGithubSyncAttestedTeams.size !==
    linearOnlyNoGithubSyncAttestedTeamKeys.length
  )
    throw new Error("linearOnlyNoGithubSyncAttestedTeamKeys contém duplicata");
  if (linearOnlyTeams.has(umbrellaTeamKey))
    throw new Error("o time guarda-chuva não pode ser Linear-only");
  if (typeof linearGithubIntegrationAttestation !== "string")
    throw new Error("linearGithubIntegrationAttestation deve ser string");
  let linearGithubIntegrationObservedAnchor = "";
  if (linearOnlyTeams.size > 0) {
    const integrations = linearTopology?.integrations;
    if (!Array.isArray(integrations)) {
      findings.push({
        severity: "incomplete",
        code: "linear_github_integration_inventory_incomplete",
        issue: "GitHub Issues Sync",
        message:
          "a integração GitHub do Linear não foi inventariada; a atestação humana não pode ser validada",
      });
    } else if (
      new Set(integrations.map((integration) => integration?.id)).size !==
        integrations.length ||
      integrations.some(
        (integration) =>
          typeof integration?.id !== "string" ||
          !integration.id.trim() ||
          integration.id !== integration.id.trim() ||
          typeof integration?.service !== "string" ||
          !integration.service.trim() ||
          integration.service !== integration.service.trim(),
      ) ||
      integrations
        .filter((integration) => isGithubService(integration.service))
        .some(
          (integration) =>
            !Object.hasOwn(integration, "archivedAt") ||
            !timestampsAreChronological(
              integration.createdAt,
              integration.updatedAt,
            ) ||
            !timestampIsNotAfter(integration.updatedAt, now) ||
            (integration.archivedAt !== null &&
              (!timestampIsNotAfter(integration.archivedAt, now) ||
                Date.parse(integration.archivedAt) <
                  Date.parse(integration.createdAt))),
        )
    ) {
      findings.push({
        severity: "incomplete",
        code: "linear_github_integration_metadata_invalid",
        issue: "GitHub Issues Sync",
        message:
          "o inventário de integrações retornou id/service/lifecycle ausente, inválido ou cronologicamente impossível",
      });
    } else {
      const activeGithubIntegrations = integrations.filter(
        (integration) =>
          integration.archivedAt === null &&
          isGithubService(integration.service),
      );
      if (activeGithubIntegrations.length !== 1) {
        findings.push({
          severity: "incomplete",
          code: "linear_github_integration_inventory_ambiguous",
          issue: "GitHub Issues Sync",
          message:
            `${activeGithubIntegrations.length} integrações GitHub ativas foram encontradas no Linear; ` +
            "é necessário exatamente um controle observável para validar a atestação",
        });
      } else {
        const integration = activeGithubIntegrations[0];
        linearGithubIntegrationObservedAnchor = `${integration.id.trim()}@${integration.updatedAt}`;
        if (
          linearGithubIntegrationAttestation.trim() !==
          linearGithubIntegrationObservedAnchor
        ) {
          findings.push({
            severity: "incomplete",
            code: "linear_github_integration_attestation_stale",
            issue: "GitHub Issues Sync",
            message:
              "a integração GitHub do Linear mudou ou ainda não possui atestação id@updatedAt correspondente; " +
              `âncora observada: ${linearGithubIntegrationObservedAnchor}`,
          });
        }
      }
    }
  }
  for (const key of linearOnlyTeams) {
    if (!noGithubSyncAttestedTeams.has(key)) {
      findings.push({
        severity: "incomplete",
        code: "linear_only_github_sync_configuration_unattested",
        issue: key,
        message:
          "a API pública do Linear não expõe a configuração GitHub Issues Sync; " +
          "falta a atestação humana versionada de que ela está desabilitada",
      });
    }
  }
  for (const key of noGithubSyncAttestedTeams) {
    if (!linearOnlyTeams.has(key)) {
      findings.push({
        severity: "incomplete",
        code: "linear_only_github_sync_attestation_unknown",
        issue: key,
        message:
          "atestação de GitHub Issues Sync desabilitado não corresponde a um time Linear-only declarado",
      });
    }
  }
  let auditedGithubLinks = 0;
  const canonicalGithubTwins = new Map();
  const effectiveTeamRepositories = resolveEffectiveTeamRepositories({
    teamRepositories,
    linearTopology,
    linearIssues,
    repositoryInventory,
    linearOnlyTeamKeys: linearOnlyTeams,
  });
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
    const invalidReleaseNodes = Array.isArray(issue?.releases?.nodes)
      ? issue.releases.nodes.filter(
          (release) => !linearReleaseMetadataIsValid(release, now),
        )
      : [];
    if (invalidReleaseNodes.length > 0) {
      findings.push({
        severity: "incomplete",
        code: "linear_release_metadata_invalid",
        issue:
          (isNonemptyTrimmedString(issue?.identifier) && issue.identifier) ||
          (isNonemptyTrimmedString(issue?.id) && issue.id) ||
          "issue Linear sem identificador",
        message:
          `${invalidReleaseNodes.length} release(s) Linear possuem identidade, pipeline, ` +
          "commitSha, version ou completedAt ausente/inválido",
      });
      continue;
    }
    const invalidCommentNodes = Array.isArray(issue?.comments?.nodes)
      ? issue.comments.nodes.filter(
          (comment) => !linearCommentMetadataIsValid(comment, now),
        )
      : [];
    if (invalidCommentNodes.length > 0) {
      findings.push({
        severity: "incomplete",
        code: "linear_comment_metadata_invalid",
        issue:
          (isNonemptyTrimmedString(issue?.identifier) && issue.identifier) ||
          (isNonemptyTrimmedString(issue?.id) && issue.id) ||
          "issue Linear sem identificador",
        message:
          `${invalidCommentNodes.length} comentário(s) Linear possuem identidade, corpo, ` +
          "proveniência, externalThread ou timestamps ausentes/inválidos",
      });
      continue;
    }
    if (!linearIssueMetadataIsValid(issue, now)) {
      findings.push({
        severity: "incomplete",
        code: "linear_issue_metadata_invalid",
        issue:
          (isNonemptyTrimmedString(issue?.identifier) && issue.identifier) ||
          (isNonemptyTrimmedString(issue?.id) && issue.id) ||
          "issue Linear sem identificador",
        message:
          "a Issue Linear retornou identidade, time, estado ou conexão obrigatória ausente/inválida; " +
          "o snapshot parcial não pode ser reconciliado com segurança",
      });
      continue;
    }
    const isLinearOnly = linearOnlyTeams.has(issue.team?.key);
    const links = collectGithubLinks(issue, organization);
    const externalOrganizationGithubLinks = isLinearOnly
      ? collectExternalOrganizationGithubLinks(issue, organization)
      : [];
    const externalThreadIssueUrls = new Set(
      collectExternalThreadIssueLinks(issue, organization).map((link) =>
        githubUrlKey(link.url),
      ),
    );
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
    const invalidNativeGithubSyncs = collectInvalidNativeGithubSyncs(
      issue,
      organization,
    );
    for (const entity of invalidNativeGithubSyncs) {
      findings.push({
        severity: "incomplete",
        code: "native_github_sync_metadata_invalid",
        issue: issue.identifier,
        message:
          `syncedWith GitHub ${entity?.id || "sem id"} não identifica ` +
          "owner, repositório e número positivos dentro da organização auditada",
      });
    }
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
      (hasNativeGithubSync(issue) ||
        hasGithubSyncedComment(issue) ||
        hasConnectedGithubExternalThread(issue))
    ) {
      findings.push({
        severity: "error",
        code: "linear_only_team_github_sync",
        issue: issue.identifier,
        message:
          "issue de time Linear-only ainda possui sincronização GitHub conectada",
      });
    }
    for (const link of externalOrganizationGithubLinks) {
      findings.push({
        severity: "error",
        code: "linear_only_team_external_github_link",
        issue: issue.identifier,
        message: `issue de time Linear-only referencia recurso GitHub fora da organização auditada: ${link.url}`,
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
        return thread?.isConnected === false && isGithubExternalThread(thread);
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

    const invalidExternalThreadUrls = connectionNodes(issue.comments).filter(
      (comment) => {
        const thread = comment.externalThread;
        if (!thread?.url || !isGithubExternalThread(thread)) return false;
        const link = githubLinkFromUrl(thread.url, organization);
        return link?.kind !== "issue";
      },
    );
    if (invalidExternalThreadUrls.length > 0) {
      findings.push({
        severity: "error",
        code: "external_thread_url_invalid_or_out_of_scope",
        issue: issue.identifier,
        message:
          `${invalidExternalThreadUrls.length} thread(s) GitHub possuem URL inválida, ` +
          "fora da organização configurada ou sem vínculo de Issue suportado",
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
        } else if (
          github?.status === 410 &&
          githubIssueInventoryContains(link, repositoryInventory)
        ) {
          findings.push({
            severity: "incomplete",
            code: "linear_only_tombstone_inventory_conflict",
            issue: issue.identifier,
            message:
              `${link.url} retornou HTTP 410, mas ainda consta no inventário completo ` +
              "do repositório; a auditoria se recusa a aceitar o tombstone contraditório",
          });
        } else if (
          github?.status !== 410 ||
          !githubIssueInventoryComplete(link, repositoryInventory)
        ) {
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
      const linkUrlKey = githubUrlKey(link.url);
      const isCanonicalIssue =
        link.kind === "issue" && canonicalIssueUrls.has(linkUrlKey);
      if (isCanonicalIssue) {
        const githubMetadataIsValid = githubIssueMetadataIsValid(github);
        if (!githubMetadataIsValid) {
          findings.push({
            severity: "incomplete",
            code: "github_issue_metadata_invalid",
            issue: issue.identifier,
            message:
              `${link.url} retornou state/state_reason ausente ou fora do contrato ` +
              "da API; o estado não pode ser reconciliado com segurança",
          });
        }
        if (githubMetadataIsValid) {
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
        }
      }
      if (
        link.kind === "issue" &&
        (isCanonicalIssue || externalThreadIssueUrls.has(linkUrlKey))
      ) {
        const linearComments = commentsForGithubLink(
          issue,
          link,
          organization,
          isCanonicalIssue,
        );
        const githubComments = github.comments ?? [];
        const invalidGithubComments = githubComments.filter(
          (comment) => !githubCommentMetadataIsValid(comment, now),
        );
        const invalidLinearComments = linearComments.filter(
          (comment) => !linearCommentMetadataIsValid(comment, now),
        );
        if (invalidGithubComments.length > 0) {
          findings.push({
            severity: "incomplete",
            code: "github_comment_metadata_invalid",
            issue: issue.identifier,
            message:
              `${invalidGithubComments.length} comentário(s) GitHub em ${link.url} ` +
              "possuem corpo ou timestamps obrigatórios ausentes/inválidos",
          });
        }
        if (invalidLinearComments.length > 0) {
          findings.push({
            severity: "incomplete",
            code: "linear_comment_metadata_invalid",
            issue: issue.identifier,
            message:
              `${invalidLinearComments.length} comentário(s) Linear do thread ${link.url} ` +
              "possuem corpo ou timestamps obrigatórios ausentes/inválidos",
          });
        }
        if (
          invalidGithubComments.length > 0 ||
          invalidLinearComments.length > 0
        ) {
          continue;
        }
        const { pairs: commentPairs, usedLinear } = pairSyncedComments(
          linearComments,
          githubComments,
        );
        const cutoff = now.getTime() - commentGraceMs;
        const missingComments = [];
        let staleComments = 0;
        let staleOnGithub = 0;
        let divergentComments = 0;
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
            linearIndex === undefined ? undefined : linearComments[linearIndex];
          if (!linearComment) {
            missingComments.push(githubComment);
            continue;
          }
          const anchorStatus = integrationAnchorPairStatus(
            linearComment,
            githubComment,
            {
              organization,
              githubIssueUrl: link.url,
              linearIssueUrl: issue.url,
              linearIdentifier: issue.identifier,
            },
          );
          if (anchorStatus) {
            if (!anchorStatus.valid) {
              findings.push({
                severity: "error",
                code: "integration_linkback_mismatch",
                issue: issue.identifier,
                message:
                  "âncora Linear e linkback GitHub não apontam para os gêmeos canônicos",
              });
            }
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
          const bodiesDiffer =
            canonicalizeCommentBody(githubComment.body, {
              organization,
              repository: link.repo,
            }) !==
            canonicalizeCommentBody(linearComment.body, {
              organization,
              repository: link.repo,
            });
          if (
            bodiesDiffer &&
            Number.isFinite(githubUpdated) &&
            Number.isFinite(linearUpdated) &&
            githubUpdated <= cutoff &&
            githubUpdated - linearUpdated > commentGraceMs
          ) {
            staleComments += 1;
          } else if (
            bodiesDiffer &&
            Number.isFinite(githubUpdated) &&
            Number.isFinite(linearUpdated) &&
            linearUpdated <= cutoff &&
            linearUpdated - githubUpdated > commentGraceMs
          ) {
            staleOnGithub += 1;
          } else if (
            bodiesDiffer &&
            Number.isFinite(githubUpdated) &&
            Number.isFinite(linearUpdated) &&
            githubUpdated <= cutoff &&
            linearUpdated <= cutoff
          ) {
            divergentComments += 1;
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
        if (staleOnGithub > 0) {
          findings.push({
            severity: "error",
            code: "comment_sync_stale_to_github",
            issue: issue.identifier,
            message: `${staleOnGithub} comentário(s) sincronizados estão desatualizados no GitHub`,
          });
        }
        if (divergentComments > 0) {
          findings.push({
            severity: "error",
            code: "comment_sync_content_divergence",
            issue: issue.identifier,
            message: `${divergentComments} comentário(s) pareados possuem conteúdo semanticamente divergente`,
          });
        }
        const missingOnGithub = linearComments.filter(
          (linearComment, index) => {
            const thread = linearComment.externalThread;
            const hasGithubProvenance =
              hasGithubSyncedEntity(linearComment) ||
              (thread?.isConnected !== false && isGithubExternalThread(thread));
            const createdAt = Date.parse(linearComment.createdAt ?? "");
            return (
              hasGithubProvenance &&
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
      if (
        link.kind === "pull" &&
        attachmentPullUrls.has(githubUrlKey(link.url))
      ) {
        if (!githubPullMetadataIsValid(github, now)) {
          findings.push({
            severity: "incomplete",
            code: "github_pull_metadata_invalid",
            issue: issue.identifier,
            message:
              `${link.url} retornou metadata merged/merged_at/merge_commit_sha ` +
              "ausente ou inválida; o carrier não pode ser reconciliado com segurança",
          });
        } else if (
          github.merged &&
          Date.parse(github.merged_at) >= releaseRequiredAfter.getTime()
        ) {
          const releases = connectionNodes(issue.releases);
          const invalidReleases = releases.filter(
            (release) => !linearReleaseMetadataIsValid(release, now),
          );
          const mergedAt = Date.parse(github.merged_at);
          const chronologicallyInvalidReleases = releases.filter(
            (release) =>
              releaseTargetsCommit(
                release,
                github.merge_commit_sha,
                link.repo,
              ) &&
              timestampIsValid(release.completedAt) &&
              Date.parse(release.completedAt) < mergedAt,
          );
          const conflictingReleases = releases.filter((release) =>
            releaseCommitEvidenceConflicts(
              release,
              github.merge_commit_sha,
              link.repo,
            ),
          );
          if (invalidReleases.length > 0) {
            findings.push({
              severity: "incomplete",
              code: "linear_release_metadata_invalid",
              issue: issue.identifier,
              message:
                `${invalidReleases.length} release(s) Linear possuem completedAt ` +
                "ausente ou inválido; a prova do carrier é inconclusiva",
            });
          } else if (conflictingReleases.length > 0) {
            findings.push({
              severity: "incomplete",
              code: "linear_release_commit_conflict",
              issue: issue.identifier,
              message:
                `${conflictingReleases.length} release(s) Linear possuem commitSha explícito ` +
                "incompatível com a versão curta do carrier; a prova é contraditória",
            });
          } else if (chronologicallyInvalidReleases.length > 0) {
            findings.push({
              severity: "incomplete",
              code: "linear_release_metadata_invalid",
              issue: issue.identifier,
              message:
                `${chronologicallyInvalidReleases.length} release(s) Linear associadas ao carrier ` +
                "foram concluídas antes do merge; a cronologia é inconclusiva",
            });
          } else if (
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
  findings.push(
    ...findStrongDuplicateCandidates(
      linearIssues,
      organization,
      linearOnlyTeams,
    ),
  );
  findings.sort((left, right) =>
    `${left.severity}:${left.code}:${left.issue}`.localeCompare(
      `${right.severity}:${right.code}:${right.issue}`,
    ),
  );
  return {
    auditedIssues: linearIssues.length,
    auditedGithubLinks,
    linearOnlyTeamKeys: [...linearOnlyTeams].sort(),
    linearOnlyNoGithubSyncAttestedTeamKeys: [
      ...noGithubSyncAttestedTeams,
    ].sort(),
    linearGithubIntegrationObservedAnchor,
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
    `- GitHub Issues Sync manualmente atestado como desabilitado: ${result.linearOnlyNoGithubSyncAttestedTeamKeys?.length ? result.linearOnlyNoGithubSyncAttestedTeamKeys.join(", ") : "nenhum"}`,
    `- Âncora observada da integração GitHub no Linear: ${result.linearGithubIntegrationObservedAnchor || "não aplicável"}`,
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
    const markdownCell = (value, maxLength) => {
      const normalized = normalizeBody(value)
        .replaceAll("|", "\\|")
        .replaceAll("\n", " ");
      return normalized.length <= maxLength
        ? normalized
        : `${normalized.slice(0, maxLength - 1)}…`;
    };
    let shown = 0;
    for (const finding of result.findings.slice(
      0,
      MAX_MARKDOWN_FINDING_DETAILS,
    )) {
      const row =
        `| ${markdownCell(finding.severity, 20)} | ` +
        `\`${markdownCell(finding.code, 120)}\` | ` +
        `${markdownCell(finding.issue, 160)} | ` +
        `${markdownCell(finding.message, 1_200)} |`;
      const candidate = `${[...lines, row].join("\n")}\n`;
      if (Buffer.byteLength(candidate, "utf8") > MAX_MARKDOWN_BYTES - 512)
        break;
      lines.push(row);
      shown += 1;
    }
    if (shown < result.findings.length) {
      lines.push(
        "",
        `Detalhes truncados: exibindo ${shown} de ${result.findings.length}; ` +
          "o artifact JSON preserva o resultado completo.",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export async function publishTerminalResult(
  result,
  {
    summaryPath = process.env.GITHUB_STEP_SUMMARY,
    jsonStdout = process.env.RECONCILIATION_JSON_STDOUT === "true",
    bestEffortSummary = false,
    appendFileImpl = appendFile,
    writeOutputImpl = (content) => process.stdout.write(content),
  } = {},
) {
  const markdown = renderMarkdown(result);
  if (summaryPath && !bestEffortSummary)
    await appendFileImpl(summaryPath, markdown, "utf8");
  writeOutputImpl(jsonStdout ? renderJson(result) : markdown);
  let summaryError = null;
  if (summaryPath && bestEffortSummary) {
    try {
      await appendFileImpl(summaryPath, markdown, "utf8");
    } catch (error) {
      summaryError = error;
    }
  }
  return { markdown, summaryError };
}

export async function writeIncompleteSummary(
  error,
  {
    summaryPath = process.env.GITHUB_STEP_SUMMARY,
    appendFileImpl = appendFile,
  } = {},
) {
  const message = error instanceof Error ? error.message : String(error);
  const result = {
    auditedIssues: 0,
    auditedGithubLinks: 0,
    linearOnlyTeamKeys: [],
    findings: [
      {
        severity: "incomplete",
        code: "reconciliation_aborted",
        issue: "execução",
        message: `snapshot não concluído: ${message}`,
      },
    ],
  };
  const markdown = renderMarkdown(result);
  if (summaryPath) await appendFileImpl(summaryPath, markdown, "utf8");
  return { result, markdown };
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
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A resposta HTTP ainda é autoritativa mesmo sem um corpo JSON legível.
  }
  const hasGraphqlErrors =
    payload !== null &&
    typeof payload === "object" &&
    Object.hasOwn(payload, "errors");
  if (hasGraphqlErrors && !Array.isArray(payload.errors))
    throw new Error("Linear API retornou campo errors inválido");
  const graphqlErrors = hasGraphqlErrors ? payload.errors : [];
  const errorSummary = graphqlErrors
    .slice(0, 3)
    .map((error) => {
      const code = normalizeBody(error?.extensions?.code).slice(0, 80);
      const message = normalizeBody(error?.message).slice(0, 300);
      return `${code ? `[${code}] ` : ""}${message || "erro GraphQL sem mensagem"}`;
    })
    .join("; ");
  if (!response.ok) {
    throw new Error(
      `Linear API HTTP ${response.status}${errorSummary ? `: ${errorSummary}` : ""}`,
    );
  }
  if (graphqlErrors.length) {
    throw new Error(
      `Linear API: ${errorSummary || "erro GraphQL sem mensagem"}`,
    );
  }
  if (!payload?.data)
    throw new Error(
      "Linear API retornou JSON inválido ou resposta parcial sem data",
    );
  return payload.data;
}

const ISSUE_FIELDS = `
  id identifier title description url updatedAt completedAt canceledAt
  duplicateOf { id identifier }
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
  comments(first: 10, orderBy: createdAt) {
    nodes {
      id body createdAt updatedAt
      syncedWith { id service }
      externalThread { id isConnected name subType type url }
    }
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

const TEAMS_QUERY = `
  query GitHubLinearTeams($after: String) {
    teams(first: 50, after: $after, includeArchived: true, orderBy: updatedAt) {
      nodes { id key name archivedAt retiredAt parent { id key name } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const INTEGRATIONS_QUERY = `
  query GitHubLinearIntegrations($after: String) {
    integrations(
      first: 50
      after: $after
      includeArchived: true
      orderBy: updatedAt
    ) {
      nodes { id service createdAt updatedAt archivedAt team { id key name } }
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
  comments:
    "id body createdAt updatedAt syncedWith { id service } externalThread { id isConnected name subType type url }",
});

function linearConnectionQuery(connection, fields) {
  const orderBy = connection === "comments" ? ", orderBy: createdAt" : "";
  return `
    query GitHubLinearConnection($id: String!, $after: String) {
      issue(id: $id) {
        ${connection}(first: 50, after: $after${orderBy}) {
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
  if (!issue[connection] || !Array.isArray(issue[connection].nodes))
    throw new Error(
      `Linear ${issue.identifier}.${connection}: nodes ausente ou inválido`,
    );
  const nodes = [...issue[connection].nodes];
  const seenCommentIds =
    connection === "comments"
      ? assertUniqueLinearCommentIdentities(
          nodes,
          `Linear ${issue.identifier}.comments`,
        )
      : null;
  const seenCursors = new Set();
  let pageCount = 0;
  let pageInfo = issue[connection].pageInfo;
  for (;;) {
    const after = nextLinearCursor(
      pageInfo,
      `Linear ${issue.identifier}.${connection}`,
      seenCursors,
    );
    if (!after) break;
    pageCount += 1;
    if (pageCount > MAX_LINEAR_PAGES)
      throw new Error(
        `Linear ${issue.identifier}.${connection}: paginação excedeu o limite`,
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
    if (!next || !Array.isArray(next.nodes))
      throw new Error(
        `Linear ${issue.identifier}.${connection}: nodes ausente ou inválido`,
      );
    if (seenCommentIds)
      assertUniqueLinearCommentIdentities(
        next.nodes,
        `Linear ${issue.identifier}.comments`,
        seenCommentIds,
      );
    nodes.push(...next.nodes);
    pageInfo = next.pageInfo;
  }
  issue[connection] = {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

export async function readLinearIssues({ token, fetchImpl = fetch }) {
  const issues = [];
  const seenIssueIds = new Set();
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
    if (!data.issues || !Array.isArray(data.issues.nodes))
      throw new Error("Linear issues: nodes ausente ou inválido");
    assertUniqueLinearIssueIdentities(
      data.issues.nodes,
      "Linear issues",
      seenIssueIds,
    );
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
      if (!issue[connection] || !Array.isArray(issue[connection].nodes))
        throw new Error(
          `Linear ${issue.identifier ?? issue.id ?? "sem id"}.${connection}: nodes ausente ou inválido`,
        );
      if (connection === "comments")
        assertUniqueLinearCommentIdentities(
          issue[connection].nodes,
          `Linear ${issue.identifier ?? issue.id ?? "sem id"}.comments`,
        );
      const after = nextLinearCursor(
        issue[connection].pageInfo,
        `Linear ${issue.identifier ?? issue.id ?? "sem id"}.${connection}`,
        new Set(),
      );
      if (after) connectionQueue.push({ issue, connection });
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
  for (const issue of issues)
    issue.comments ??= { nodes: [], pageInfo: { hasNextPage: false } };
  return issues;
}

async function readLinearConnectionPages({
  token,
  query,
  root,
  variables = {},
  label = "Linear topology",
  validateNode,
  fetchImpl,
}) {
  const nodes = [];
  const seenNodeIds = new Set();
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
    if (!connection || !Array.isArray(connection.nodes))
      throw new Error("Linear topology retornou nodes ausentes ou inválidos");
    if (validateNode && connection.nodes.some((node) => !validateNode(node)))
      throw new Error(`${label}: node ausente ou inválido`);
    if (validateNode) {
      for (const node of connection.nodes) {
        if (seenNodeIds.has(node.id))
          throw new Error(`${label}: id duplicado ${node.id}`);
        seenNodeIds.add(node.id);
      }
    }
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
  const [teams, integrations] = await Promise.all([
    readLinearConnectionPages({
      token,
      query: TEAMS_QUERY,
      root: (data) => data.teams,
      fetchImpl,
    }),
    readLinearConnectionPages({
      token,
      query: INTEGRATIONS_QUERY,
      root: (data) => data.integrations,
      fetchImpl,
    }),
  ]);
  if (teams.some((team) => !linearTeamMetadataIsValid(team)))
    throw new Error(
      "Linear topology retornou time com identidade ou lifecycle ausente/inválido",
    );
  const matches = teams.filter((team) => team.key === umbrellaTeamKey);
  if (matches.length === 0)
    return {
      teams,
      integrations,
      auditFailure: "umbrella_team_missing",
      message: `o time guarda-chuva ${umbrellaTeamKey} não existe ou não pôde ser lido`,
    };
  if (matches.length !== 1) {
    return {
      teams,
      integrations,
      auditFailure: "ambiguous_umbrella_team",
      message: `${matches.length} times usam a chave ${umbrellaTeamKey}`,
    };
  }
  const team = matches[0];
  if (team.archivedAt || team.retiredAt) {
    return {
      team,
      teams,
      integrations,
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
      label: "Linear topology Cycles",
      validateNode: linearCycleMetadataIsValid,
      fetchImpl,
    }),
    readLinearConnectionPages({
      token,
      query: TEAM_PROJECTS_QUERY,
      root: (data) => data.team?.projects,
      variables: { id: team.id },
      label: "Linear topology Projects",
      validateNode: linearProjectMetadataIsValid,
      fetchImpl,
    }),
    readLinearConnectionPages({
      token,
      query: TEAM_INITIATIVES_QUERY,
      root: (data) => data.initiatives,
      variables: { teamId: team.id },
      label: "Linear topology Initiatives",
      validateNode: (initiative) =>
        linearInitiativeMetadataIsValid(initiative, team.id),
      fetchImpl,
    }),
    readLinearConnectionPages({
      token,
      query: TEAM_DOCUMENTS_QUERY,
      root: (data) => data.documents,
      variables: { teamId: team.id },
      label: "Linear topology Documents",
      validateNode: (document) =>
        linearDocumentMetadataIsValid(document, team.id),
      fetchImpl,
    }),
  ]);
  const subteams = teams.filter(
    (candidate) => candidate.parent?.id === team.id,
  );
  return {
    team,
    teams,
    integrations,
    cycles,
    projects,
    initiatives,
    documents,
    subteams,
  };
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
    if (!Array.isArray(batch))
      throw new Error(
        `${repo}#${number}: comentários GitHub retornaram página que não é array`,
      );
    for (const comment of batch) {
      const key = githubCommentStableIdentity(comment);
      if (key === null)
        throw new Error(
          `${repo}#${number}: comentário GitHub sem identidade estável`,
        );
      if (seen.has(key))
        throw new Error(`${repo}#${number}: comentário GitHub repetido ${key}`);
      seen.add(key);
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
  teamRepositories = DEFAULT_TEAM_REPOSITORIES,
  linearTopology,
  repositoryInventory,
  linearOnlyTeamKeys = [],
  fetchImpl = fetch,
}) {
  const links = new Map();
  const commentAuditUrls = new Set();
  const effectiveTeamRepositories = resolveEffectiveTeamRepositories({
    teamRepositories,
    linearTopology,
    linearIssues: issues,
    repositoryInventory,
    linearOnlyTeamKeys,
  });
  for (const issue of issues) {
    for (const link of collectGithubLinks(issue, organization))
      links.set(link.url, link);
    for (const url of collectGithubCommentAuditUrls(issue, organization, {
      teamRepositories: effectiveTeamRepositories,
      linearOnlyTeamKeys,
    })) {
      commentAuditUrls.add(url);
    }
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
          if (link.kind === "issue" && record?.pull_request) {
            records.set(link.url, {
              auditFailure: "resource_kind_mismatch",
              status: 200,
            });
            continue;
          }
          const comments =
            link.kind === "issue" &&
            commentAuditUrls.has(githubUrlKey(link.url))
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
      if (!Array.isArray(batch))
        throw new Error(
          "Inventário GitHub retornou página de repositórios que não é array",
        );
      if (
        batch.some(
          (repo) =>
            !isNonemptyTrimmedString(repo?.name) ||
            typeof repo.archived !== "boolean" ||
            typeof repo.has_issues !== "boolean",
        )
      )
        throw new Error(
          "Inventário GitHub retornou repositório com metadata inválida",
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
      issuesEnabled: repositories
        .filter((repo) => repo.has_issues !== false)
        .map((repo) => repo.name),
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
            if (!Array.isArray(batch))
              throw new Error(
                `${repo.name}: inventário de Issues retornou página que não é array`,
              );
            for (const issue of batch) {
              if (issue.pull_request) continue;
              if (
                !Number.isSafeInteger(issue?.number) ||
                issue.number <= 0 ||
                !githubIssueMetadataIsValid(issue)
              )
                throw new Error(
                  `${repo.name}: inventário de Issues retornou metadata inválida`,
                );
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
  return {
    active,
    issuesEnabled: repositories
      .filter((repo) => repo.has_issues !== false)
      .map((repo) => repo.name),
    issues,
    issueAuditFailures,
  };
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
  const linearOnlyNoGithubSyncAttestedTeamKeys = parseLinearOnlyTeamKeys(
    process.env.LINEAR_ONLY_NO_GITHUB_SYNC_ATTESTED_TEAM_KEYS,
    umbrellaTeamKey,
  );
  const linearGithubIntegrationAttestation =
    process.env.LINEAR_GITHUB_INTEGRATION_ATTESTATION?.trim() || "";
  const [issues, linearTopology] = await Promise.all([
    readLinearIssues({ token: linearToken }),
    readLinearTopology({
      token: linearToken,
      umbrellaTeamKey,
    }),
  ]);
  const repositoryInventory = await readGithubRepositoryInventory({
    organization,
    token: githubToken,
  });
  const effectiveTeamRepositories = resolveEffectiveTeamRepositories({
    linearTopology,
    linearIssues: issues,
    repositoryInventory,
    linearOnlyTeamKeys,
  });
  const githubByUrl = await readGithubRecords({
    issues,
    organization,
    token: githubToken,
    teamRepositories: effectiveTeamRepositories,
    linearTopology,
    repositoryInventory,
    linearOnlyTeamKeys,
  });
  const result = reconcileSnapshots({
    linearIssues: issues,
    githubByUrl,
    linearTopology,
    repositoryInventory,
    organization,
    umbrellaTeamKey,
    linearOnlyTeamKeys,
    linearOnlyNoGithubSyncAttestedTeamKeys,
    linearGithubIntegrationAttestation,
    teamRepositories: effectiveTeamRepositories,
    commentGraceMs: commentGraceMinutes * 60_000,
    releaseRequiredAfter,
  });
  await publishTerminalResult(result);
  process.exitCode = determineExitCode(result, {
    strictWarnings: process.env.STRICT_WARNINGS === "true",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(async (error) => {
    process.exitCode = 2;
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    const { result } = await writeIncompleteSummary(error, {
      summaryPath: "",
    });
    const { summaryError } = await publishTerminalResult(result, {
      bestEffortSummary: true,
    });
    if (summaryError) {
      console.error(
        `::error::falha ao escrever GITHUB_STEP_SUMMARY: ${
          summaryError instanceof Error
            ? summaryError.message
            : String(summaryError)
        }`,
      );
    }
  });
}
