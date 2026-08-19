const GITHUB_HOSTNAME = "github.com";
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;

function canonicalString(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0
    ? value.toLowerCase()
    : null;
}

export function parseGithubOwner(value) {
  const canonical = canonicalString(value);
  return canonical !== null && OWNER_PATTERN.test(canonical) ? canonical : null;
}

export function parseGithubRepository(value) {
  const canonical = canonicalString(value);
  return canonical !== null &&
    canonical !== "." &&
    canonical !== ".." &&
    REPOSITORY_PATTERN.test(canonical)
    ? canonical
    : null;
}

export function parseGithubResourceNumber(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function buildGithubResourceKey({ owner, repository, number } = {}) {
  const canonicalOwner = parseGithubOwner(owner);
  const canonicalRepository = parseGithubRepository(repository);
  const canonicalNumber = parseGithubResourceNumber(number);
  if (
    canonicalOwner === null ||
    canonicalRepository === null ||
    canonicalNumber === null
  ) {
    return null;
  }
  return `${canonicalOwner}/${canonicalRepository}#${canonicalNumber}`;
}

export function parseGithubResourceKey(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const match = /^([^/#]+)\/([^/#]+)#([^#]+)$/u.exec(value);
  if (!match) return null;
  const key = buildGithubResourceKey({
    owner: match[1],
    repository: match[2],
    number: match[3],
  });
  if (key === null) return null;
  const [ownerAndRepository, numberText] = key.split("#");
  const [owner, repository] = ownerAndRepository.split("/");
  return Object.freeze({
    owner,
    repository,
    number: Number(numberText),
    key,
  });
}

function parsedUrl(raw) {
  if (
    typeof raw !== "string" ||
    raw !== raw.trim() ||
    raw.length === 0 ||
    /[\u0000-\u0020\u007f]/u.test(raw)
  )
    return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function literalUrlSyntax(raw) {
  const match =
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?(#[\s\S]*)?$/u.exec(
      raw,
    );
  const pathname = match?.[2] ?? "/";
  if (
    match === null ||
    pathname.includes("\\") ||
    pathname.includes("%") ||
    /(?:^|\/)\.{1,2}(?:\/|$)/u.test(pathname)
  ) {
    return null;
  }
  return Object.freeze({
    authority: match[1],
    pathname,
    hasQueryDelimiter: match[3] !== undefined,
    hasFragmentDelimiter: match[4] !== undefined,
  });
}

export function hasGithubHostname(raw) {
  return parsedUrl(raw)?.hostname.toLowerCase() === GITHUB_HOSTNAME;
}

export function parseGithubResourceUrl(raw, { role = "attachment" } = {}) {
  if (!new Set(["attachment", "external-thread"]).has(role)) return null;
  const url = parsedUrl(raw);
  if (url?.hostname.toLowerCase() !== GITHUB_HOSTNAME) return null;
  const literal = literalUrlSyntax(raw);
  if (literal === null) return null;
  const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([^/]+)\/?$/u.exec(
    literal.pathname,
  );
  if (!match) return null;
  const key = buildGithubResourceKey({
    owner: match[1],
    repository: match[2],
    number: match[4],
  });
  if (key === null) return null;
  const parsedKey = parseGithubResourceKey(key);
  const secure =
    url.protocol === "https:" &&
    literal.authority.toLowerCase() === GITHUB_HOSTNAME &&
    !literal.hasQueryDelimiter &&
    (role === "external-thread" || !literal.hasFragmentDelimiter);
  return Object.freeze({
    ...parsedKey,
    kind: match[3] === "pull" ? "pull" : "issue",
    secure,
  });
}

/**
 * Exhaustively classifies an attachment URL without treating every github.com
 * link as a GitHub Issue or pull request identity.
 */
export function classifyGithubAttachmentUrl(raw) {
  const url = parsedUrl(raw);
  if (url === null) return Object.freeze({ kind: "invalid-url" });
  if (url.hostname.toLowerCase() !== GITHUB_HOSTNAME) {
    return Object.freeze({ kind: "non-github" });
  }

  const resource = parseGithubResourceUrl(raw, { role: "attachment" });
  if (resource !== null) {
    return Object.freeze({
      kind: resource.kind === "pull" ? "github-pull" : "github-issue",
      resource,
    });
  }

  return Object.freeze({ kind: "github-other" });
}
