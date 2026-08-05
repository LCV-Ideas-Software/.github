import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const API_ROOT = "https://api.github.com";
export const API_VERSION = "2026-03-10";
export const DEFAULT_ORGANIZATION = "LCV-Ideas-Software";
export const DEFAULT_MINIMUM_REPOSITORIES = 11;
export const REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_DOCKER_DIGEST_BASELINE_URL = new URL(
  "./github-actions-docker-digests.json",
  import.meta.url,
);

const GHCR_ROOT = "https://ghcr.io";
const GHCR_TOKEN_URL = "https://ghcr.io/token";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/i;
const OCI_MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const OCI_MANIFEST_MEDIA_TYPES = new Set(
  OCI_MANIFEST_ACCEPT.split(", ").map((value) => value.toLowerCase()),
);

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const EXTERNAL_USES =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[A-Za-z0-9_.\-/]+)?@([0-9a-f]{40})$/i;
const STABLE_SEMVER_TAG = /^(.*?)(\d+)\.(\d+)\.(\d+)$/;
const EXACT_STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const EXACT_STABLE_VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SLACK_CLI_CHECKSUM = /^[0-9a-f]{64}$/i;
const SETUP_DENO_SOURCE = "denoland/setup-deno";
const DENO_RUNTIME_SOURCE = "denoland/deno";
const SLACK_CLI_SOURCE = "slackapi/slack-cli";
const SLACK_CLI_PIN_KEYS = Object.freeze([
  "SLACK_CLI_ASSET",
  "SLACK_CLI_SHA256",
  "SLACK_CLI_VERSION",
]);

export class GitHubApiError extends Error {
  constructor(message, { status, requestId, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitHubApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

export class OciRegistryError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OciRegistryError";
    this.code = code;
    this.status = status;
  }
}

function requiredString(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  if (value.trim() !== value) {
    throw new Error(
      `Required environment variable ${name} contains surrounding whitespace.`,
    );
  }
  return value;
}

export function readConfiguration(environment = process.env) {
  const token = requiredString(environment, "GITHUB_TOKEN");
  const organization = environment.ORGANIZATION?.trim() || DEFAULT_ORGANIZATION;
  if (!/^[A-Za-z0-9-]+$/.test(organization)) {
    throw new Error("ORGANIZATION is not a valid GitHub organization login.");
  }

  const minimumRepositories = Number.parseInt(
    environment.MIN_ACTIVE_REPOSITORIES ?? String(DEFAULT_MINIMUM_REPOSITORIES),
    10,
  );
  if (
    !Number.isSafeInteger(minimumRepositories) ||
    minimumRepositories < 1 ||
    String(minimumRepositories) !==
      (environment.MIN_ACTIVE_REPOSITORIES ??
        String(DEFAULT_MINIMUM_REPOSITORIES))
  ) {
    throw new Error("MIN_ACTIVE_REPOSITORIES must be a positive integer.");
  }

  return Object.freeze({
    token,
    organization,
    minimumRepositories,
    summaryPath: environment.GITHUB_STEP_SUMMARY,
  });
}

function requestDiagnostic(response) {
  const requestId = response.headers.get("x-github-request-id");
  const rateRemaining = response.headers.get("x-ratelimit-remaining");
  return [
    requestId ? `request-id=${requestId}` : undefined,
    rateRemaining === "0" ? "rate-limit-exhausted=true" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

export class GitHubReadonlyApi {
  constructor({ token, fetchImpl = globalThis.fetch } = {}) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("A non-empty GitHub token is required.");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl must be a function.");
    }
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async getJson(path, { allow404 = false } = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error("GitHub API paths must start with '/'.");
    }
    const url = new URL(path, API_ROOT);
    if (url.origin !== API_ROOT || !url.pathname.startsWith("/")) {
      throw new Error("Refusing a GitHub API request outside api.github.com.");
    }

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "lcv-github-actions-pin-audit",
          "X-GitHub-Api-Version": API_VERSION,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GitHubApiError(
        `GitHub API GET ${url.pathname} failed before a response was received.`,
        { cause: error },
      );
    }

    if (allow404 && response.status === 404) return undefined;
    if (!response.ok) {
      const diagnostic = requestDiagnostic(response);
      throw new GitHubApiError(
        `GitHub API GET ${url.pathname} returned HTTP ${response.status}${diagnostic ? ` (${diagnostic})` : ""}.`,
        {
          status: response.status,
          requestId: response.headers.get("x-github-request-id") ?? undefined,
        },
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new GitHubApiError(
        `GitHub API GET ${url.pathname} returned invalid JSON.`,
        { status: response.status, cause: error },
      );
    }
  }

  async paginate(path, { maximumPages = 100 } = {}) {
    const results = [];
    for (let page = 1; page <= maximumPages; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pageResults = await this.getJson(
        `${path}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(pageResults)) {
        throw new Error(`Expected an array while paginating ${path}.`);
      }
      results.push(...pageResults);
      if (pageResults.length < 100) return results;
    }
    throw new Error(
      `Pagination for ${path} exceeded ${maximumPages} pages; coverage is incomplete.`,
    );
  }
}

function canonicalDigest(value, context) {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new Error(`${context} must be a complete sha256 OCI digest.`);
  }
  return value.toLowerCase();
}

function parseBearerChallenge(value, repository) {
  if (typeof value !== "string") {
    throw new OciRegistryError(
      "INVALID_REGISTRY_AUTH_CHALLENGE",
      "GHCR returned HTTP 401 without a Bearer authentication challenge.",
    );
  }
  const scheme = /^Bearer\s+/i.exec(value);
  if (!scheme) {
    throw new OciRegistryError(
      "INVALID_REGISTRY_AUTH_CHALLENGE",
      "GHCR returned an unsupported registry authentication challenge.",
    );
  }

  const attributes = new Map();
  const source = value.slice(scheme[0].length);
  const separator = /\s*,\s*/y;
  const attribute = /\s*([A-Za-z][A-Za-z0-9_-]*)="([^"\\]*)"/y;
  let offset = 0;
  while (offset < source.length) {
    if (source.slice(offset).trim().length === 0) break;
    if (offset > 0) {
      separator.lastIndex = offset;
      const separated = separator.exec(source);
      if (!separated) {
        throw new OciRegistryError(
          "INVALID_REGISTRY_AUTH_CHALLENGE",
          "GHCR returned a malformed registry authentication challenge.",
        );
      }
      offset = separator.lastIndex;
    }
    attribute.lastIndex = offset;
    const match = attribute.exec(source);
    if (!match || attributes.has(match[1].toLowerCase())) {
      throw new OciRegistryError(
        "INVALID_REGISTRY_AUTH_CHALLENGE",
        "GHCR returned a malformed registry authentication challenge.",
      );
    }
    attributes.set(match[1].toLowerCase(), match[2]);
    offset = attribute.lastIndex;
  }

  const realm = attributes.get("realm");
  const service = attributes.get("service");
  const scope = attributes.get("scope");
  if (
    realm !== GHCR_TOKEN_URL ||
    service !== "ghcr.io" ||
    scope !== `repository:${repository}:pull`
  ) {
    throw new OciRegistryError(
      "INVALID_REGISTRY_AUTH_CHALLENGE",
      "GHCR returned a Bearer challenge outside the expected anonymous pull scope.",
    );
  }
  return { realm, service, scope };
}

async function boundedResponseBytes(response, maximumBytes, context) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumBytes
    ) {
      throw new OciRegistryError(
        "INVALID_REGISTRY_RESPONSE",
        `${context} declared an invalid or oversized response body.`,
      );
    }
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) {
    throw new OciRegistryError(
      "INVALID_REGISTRY_RESPONSE",
      `${context} returned an oversized response body.`,
    );
  }
  return bytes;
}

export function parseDockerImageReference(value) {
  if (typeof value !== "string" || !value.startsWith("docker://")) {
    throw new Error("Docker Action image must start with docker://.");
  }
  const raw = value.slice("docker://".length);
  if (
    raw.length === 0 ||
    raw.trim() !== raw ||
    /[?#\\\s]/.test(raw) ||
    raw.includes("..")
  ) {
    throw new Error("Docker Action image reference is malformed.");
  }

  const at = raw.lastIndexOf("@");
  if (at !== -1 && raw.indexOf("@") !== at) {
    throw new Error("Docker Action image reference contains multiple digests.");
  }
  const digest =
    at === -1
      ? undefined
      : canonicalDigest(
          raw.slice(at + 1),
          "Docker Action image reference digest",
        );
  const nameAndTag = at === -1 ? raw : raw.slice(0, at);
  const slash = nameAndTag.indexOf("/");
  const firstComponent = slash === -1 ? nameAndTag : nameAndTag.slice(0, slash);
  const explicitRegistry =
    firstComponent.includes(".") ||
    firstComponent.includes(":") ||
    firstComponent === "localhost";
  const registry = explicitRegistry
    ? firstComponent.toLowerCase()
    : "docker.io";
  let repositoryAndTag = explicitRegistry
    ? nameAndTag.slice(firstComponent.length + 1)
    : nameAndTag;
  if (!repositoryAndTag) {
    throw new Error("Docker Action image reference has no repository name.");
  }

  const finalSlash = repositoryAndTag.lastIndexOf("/");
  const finalColon = repositoryAndTag.lastIndexOf(":");
  let tag;
  if (finalColon > finalSlash) {
    tag = repositoryAndTag.slice(finalColon + 1);
    repositoryAndTag = repositoryAndTag.slice(0, finalColon);
  } else if (!digest) {
    tag = "latest";
  }
  if (tag && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    throw new Error("Docker Action image reference has an invalid tag.");
  }

  const components = repositoryAndTag.split("/");
  if (
    components.some(
      (component) => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(component),
    )
  ) {
    throw new Error(
      "Docker Action image repository must use canonical lowercase OCI components.",
    );
  }
  const repository = repositoryAndTag;
  const canonicalName = `${registry}/${repository}`;
  const canonical = digest
    ? `${canonicalName}${tag ? `:${tag}` : ""}@${digest}`
    : `${canonicalName}:${tag}`;
  return Object.freeze({
    original: value,
    registry,
    repository,
    tag,
    digest,
    canonical,
    manifestReference: digest ?? tag,
  });
}

export class OciRegistryReadonlyClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl must be a function.");
    }
    this.fetchImpl = fetchImpl;
  }

  async request(url, headers = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OciRegistryError(
        "REGISTRY_REQUEST_FAILED",
        `Read-only OCI request to ${url.origin}${url.pathname} failed before a response was received.`,
        { cause: error },
      );
    }
    return response;
  }

  async anonymousPullToken(challenge, repository) {
    const parsed = parseBearerChallenge(challenge, repository);
    const tokenUrl = new URL(parsed.realm);
    tokenUrl.searchParams.set("service", parsed.service);
    tokenUrl.searchParams.set("scope", parsed.scope);
    const response = await this.request(tokenUrl, {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "lcv-github-actions-pin-audit",
    });
    if (!response.ok) {
      throw new OciRegistryError(
        "REGISTRY_AUTH_FAILED",
        `GHCR anonymous pull token request returned HTTP ${response.status}.`,
        { status: response.status },
      );
    }
    const bytes = await boundedResponseBytes(
      response,
      MAX_TOKEN_RESPONSE_BYTES,
      "GHCR anonymous pull token endpoint",
    );
    let payload;
    try {
      payload = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new OciRegistryError(
        "INVALID_REGISTRY_RESPONSE",
        "GHCR anonymous pull token endpoint returned invalid JSON.",
        { cause: error },
      );
    }
    const token = payload?.token ?? payload?.access_token;
    if (
      typeof token !== "string" ||
      token.length < 16 ||
      token.length > 16_384
    ) {
      throw new OciRegistryError(
        "INVALID_REGISTRY_RESPONSE",
        "GHCR anonymous pull token endpoint returned an invalid token.",
      );
    }
    return token;
  }

  async resolveDigest(value) {
    const image =
      typeof value === "string" ? parseDockerImageReference(value) : value;
    if (image?.registry !== "ghcr.io") {
      throw new OciRegistryError(
        "UNSUPPORTED_DOCKER_IMAGE_REGISTRY",
        `Docker Action image registry ${image?.registry ?? "unknown"} is not covered by the anonymous GHCR resolver.`,
      );
    }
    const repositoryPath = image.repository
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const manifestUrl = new URL(
      `/v2/${repositoryPath}/manifests/${encodeURIComponent(image.manifestReference)}`,
      GHCR_ROOT,
    );
    const requestHeaders = {
      Accept: OCI_MANIFEST_ACCEPT,
      "Accept-Encoding": "identity",
      "User-Agent": "lcv-github-actions-pin-audit",
    };
    let response = await this.request(manifestUrl, requestHeaders);
    if (response.status === 401) {
      const token = await this.anonymousPullToken(
        response.headers.get("www-authenticate"),
        image.repository,
      );
      response = await this.request(manifestUrl, {
        ...requestHeaders,
        Authorization: `Bearer ${token}`,
      });
    }
    if (!response.ok) {
      throw new OciRegistryError(
        "REGISTRY_MANIFEST_UNAVAILABLE",
        `GHCR manifest resolution for ${image.canonical} returned HTTP ${response.status}.`,
        { status: response.status },
      );
    }

    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!mediaType || !OCI_MANIFEST_MEDIA_TYPES.has(mediaType)) {
      throw new OciRegistryError(
        "INVALID_REGISTRY_RESPONSE",
        `GHCR returned an unsupported manifest media type for ${image.canonical}.`,
      );
    }
    const headerDigest = canonicalDigest(
      response.headers.get("docker-content-digest"),
      `GHCR Docker-Content-Digest for ${image.canonical}`,
    );
    const manifest = await boundedResponseBytes(
      response,
      MAX_MANIFEST_BYTES,
      `GHCR manifest for ${image.canonical}`,
    );
    const computedDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    if (computedDigest !== headerDigest) {
      throw new OciRegistryError(
        "REGISTRY_DIGEST_MISMATCH",
        `GHCR manifest body for ${image.canonical} does not match Docker-Content-Digest.`,
      );
    }
    if (image.digest && image.digest !== headerDigest) {
      throw new OciRegistryError(
        "REGISTRY_DIGEST_MISMATCH",
        `GHCR resolved ${image.canonical} to a different digest.`,
      );
    }
    return headerDigest;
  }
}

export function parseDockerDigestBaseline(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    throw new Error("Docker Action digest baseline is not valid JSON.", {
      cause: error,
    });
  }
  if (
    !payload ||
    Array.isArray(payload) ||
    payload.version !== 1 ||
    !payload.images ||
    Array.isArray(payload.images) ||
    typeof payload.images !== "object"
  ) {
    throw new Error(
      "Docker Action digest baseline must contain version 1 and an images object.",
    );
  }
  const baseline = new Map();
  for (const [reference, digestValue] of Object.entries(payload.images)) {
    const parsed = parseDockerImageReference(`docker://${reference}`);
    if (
      parsed.registry !== "ghcr.io" ||
      parsed.digest ||
      parsed.canonical !== reference
    ) {
      throw new Error(
        `Docker Action digest baseline key ${reference} must be a canonical tagged GHCR image.`,
      );
    }
    if (baseline.has(parsed.canonical)) {
      throw new Error(
        `Docker Action digest baseline contains duplicate image ${parsed.canonical}.`,
      );
    }
    baseline.set(
      parsed.canonical,
      canonicalDigest(
        digestValue,
        `Docker Action digest baseline for ${parsed.canonical}`,
      ),
    );
  }
  return baseline;
}

export async function loadDockerDigestBaseline(
  baselineUrl = DEFAULT_DOCKER_DIGEST_BASELINE_URL,
) {
  return parseDockerDigestBaseline(await fs.readFile(baselineUrl, "utf8"));
}

export function isAuditedYamlPath(path) {
  if (typeof path !== "string") return false;
  return (
    /^\.github\/workflows\/.+\.ya?ml$/i.test(path) ||
    /(^|\/)action\.ya?ml$/i.test(path)
  );
}

function parseQuotedScalar(raw, quote) {
  let value = "";
  for (let index = 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === "'" && character === "'" && raw[index + 1] === "'") {
      value += "'";
      index += 1;
      continue;
    }
    if (character === quote) {
      const remainder = raw.slice(index + 1).trim();
      if (remainder && !remainder.startsWith("#")) {
        throw new Error("Unexpected content after the quoted uses value.");
      }
      return {
        value,
        comment: remainder.startsWith("#")
          ? remainder.slice(1).trim()
          : undefined,
      };
    }
    if (quote === '"' && character === "\\") {
      const escaped = raw[index + 1];
      if (escaped === undefined) break;
      value += escaped;
      index += 1;
      continue;
    }
    value += character;
  }
  throw new Error("Unterminated quoted uses value.");
}

function parseUsesScalar(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("The uses value is empty.");
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return parseQuotedScalar(trimmed, trimmed[0]);
  }

  const commentMatch = /^(.*?)(?:\s+#(.*))?$/.exec(trimmed);
  const value = commentMatch[1].trim();
  if (!value || /\s/.test(value)) {
    throw new Error("The unquoted uses value is empty or contains whitespace.");
  }
  return {
    value,
    comment: commentMatch[2]?.trim() || undefined,
  };
}

function finding(code, repository, path, line, message, reference) {
  return { code, repository, path, line, message, reference };
}

export function parseUsesReferences(content, { repository, path }) {
  if (typeof content !== "string") {
    throw new Error("Workflow content must be a string.");
  }
  const references = [];
  const findings = [];
  const lines = content.replaceAll("\r\n", "\n").split("\n");

  for (const [index, line] of lines.entries()) {
    if (/^\s*#/.test(line)) continue;
    const canonical = /^\s*(?:-\s*)?uses\s*:\s*(.*)$/.exec(line);
    if (!canonical) {
      if (
        /^\s*(?:-\s*)?\{.*\buses\s*:/.test(line) ||
        /^\s*[A-Za-z0-9_-]+\s*:\s*\{.*\buses\s*:/.test(line)
      ) {
        findings.push(
          finding(
            "UNSUPPORTED_USES_SYNTAX",
            repository,
            path,
            index + 1,
            "Flow-style YAML containing uses is not auditable; use a canonical block-style uses key.",
          ),
        );
      }
      continue;
    }

    let parsed;
    try {
      parsed = parseUsesScalar(canonical[1]);
    } catch (error) {
      findings.push(
        finding(
          "UNSUPPORTED_USES_SYNTAX",
          repository,
          path,
          index + 1,
          error.message,
        ),
      );
      continue;
    }

    if (parsed.value.startsWith("./")) continue;

    const external = EXTERNAL_USES.exec(parsed.value);
    if (!external || !FULL_COMMIT_SHA.test(external[4])) {
      findings.push(
        finding(
          "UNPINNED_EXTERNAL_ACTION",
          repository,
          path,
          index + 1,
          `External uses reference must be owner/repository[/path]@ followed by a full 40-character commit SHA: ${parsed.value}`,
          parsed.value,
        ),
      );
      continue;
    }

    const commentTag = parsed.comment?.split(/\s+/, 1)[0];
    const source = `${external[1]}/${external[2]}`;
    references.push({
      repository,
      path,
      line: index + 1,
      value: parsed.value,
      owner: external[1],
      sourceRepository: external[2],
      source,
      actionPath: external[3]?.slice(1),
      sha: external[4].toLowerCase(),
      commentTag,
    });
    if (!commentTag) {
      findings.push(
        finding(
          "MISSING_VERSION_COMMENT",
          repository,
          path,
          index + 1,
          `Pinned external Action ${parsed.value} must have its exact release tag in a same-line comment.`,
          parsed.value,
        ),
      );
    }
  }

  return { references, findings };
}

function logicalKeyIndent(line) {
  const indentation = indentationOf(line, "Workflow mapping key");
  return indentation + (/^\s*-\s+/.test(line) ? 2 : 0);
}

function nestedBlock(lines, headerIndex, headerIndent) {
  let end = lines.length;
  const children = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const indent = indentationOf(line, "Workflow nested mapping");
    if (indent <= headerIndent) {
      end = index;
      break;
    }
    children.push({ index, line, indent });
  }
  const directIndent = children.length
    ? Math.min(...children.map(({ indent }) => indent))
    : undefined;
  return { children, directIndent, end };
}

function workflowLiteralScalar(raw, context) {
  let parsed;
  try {
    parsed = parseUsesScalar(raw);
  } catch (error) {
    throw new Error(`${context} is not a supported YAML scalar.`, {
      cause: error,
    });
  }
  if (/^[>|&*!\[{]/.test(parsed.value) || parsed.value.includes("${{")) {
    throw new Error(`${context} must be a literal value.`);
  }
  return parsed.value;
}

export function parseWorkflowRuntimePins(
  content,
  { repository, path },
  usesReferences,
) {
  if (typeof content !== "string") {
    throw new Error("Workflow content must be a string.");
  }
  const references =
    usesReferences ??
    parseUsesReferences(content, { repository, path }).references;
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const denoReferences = [];
  const slackCliReferences = [];
  const findings = [];

  for (const reference of references.filter(
    ({ source }) => source.toLowerCase() === SETUP_DENO_SOURCE,
  )) {
    const usesIndex = reference.line - 1;
    const usesIndent = logicalKeyIndent(lines[usesIndex]);
    let stepEnd = lines.length;
    for (let index = usesIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      if (indentationOf(line, "Deno setup step") < usesIndent) {
        stepEnd = index;
        break;
      }
    }

    const withHeaders = [];
    for (let index = usesIndex + 1; index < stepEnd; index += 1) {
      const line = lines[index];
      const match = /^\s*with\s*:\s*(.*)$/.exec(line);
      if (
        match &&
        indentationOf(line, "Deno setup with mapping") === usesIndent
      ) {
        withHeaders.push({ index, remainder: match[1].trim() });
      }
    }
    if (withHeaders.length !== 1) {
      findings.push(
        finding(
          "MISSING_DENO_VERSION_PIN",
          repository,
          path,
          reference.line,
          `${reference.value} must have exactly one canonical block-style with mapping containing an exact deno-version.`,
          reference.value,
        ),
      );
      continue;
    }

    const withHeader = withHeaders[0];
    if (withHeader.remainder && !withHeader.remainder.startsWith("#")) {
      findings.push(
        finding(
          "UNSUPPORTED_DENO_VERSION_PIN",
          repository,
          path,
          withHeader.index + 1,
          "The setup-deno with mapping must use canonical block-style YAML.",
          reference.value,
        ),
      );
      continue;
    }

    const block = nestedBlock(lines, withHeader.index, usesIndent);
    const versionEntries = block.children.filter(
      ({ line, indent }) =>
        indent === block.directIndent && /^\s*deno-version\s*:/.test(line),
    );
    if (versionEntries.length !== 1) {
      findings.push(
        finding(
          "MISSING_DENO_VERSION_PIN",
          repository,
          path,
          reference.line,
          `${reference.value} must declare exactly one direct deno-version input.`,
          reference.value,
        ),
      );
      continue;
    }

    const versionEntry = versionEntries[0];
    const raw = /^\s*deno-version\s*:\s*(.*)$/.exec(versionEntry.line)[1];
    let value;
    try {
      value = workflowLiteralScalar(raw, "setup-deno deno-version");
    } catch (error) {
      findings.push(
        finding(
          "UNSUPPORTED_DENO_VERSION_PIN",
          repository,
          path,
          versionEntry.index + 1,
          error.message,
          reference.value,
        ),
      );
      continue;
    }
    const versionMatch = /^v?(\d+\.\d+\.\d+)$/.exec(value);
    if (!versionMatch) {
      findings.push(
        finding(
          "NON_EXACT_DENO_VERSION_PIN",
          repository,
          path,
          versionEntry.index + 1,
          `setup-deno deno-version must be an exact stable version, not ${value}.`,
          reference.value,
        ),
      );
      continue;
    }
    denoReferences.push({
      repository,
      path,
      line: versionEntry.index + 1,
      value,
      version: versionMatch[1],
      actionReference: reference.value,
    });
  }

  for (const [index, line] of lines.entries()) {
    const envMatch = /^\s*env\s*:\s*(.*)$/.exec(line);
    if (!envMatch) continue;
    const envIndent = logicalKeyIndent(line);
    const remainder = envMatch[1].trim();
    if (remainder && !remainder.startsWith("#")) {
      if (SLACK_CLI_PIN_KEYS.some((key) => remainder.includes(key))) {
        findings.push(
          finding(
            "UNSUPPORTED_SLACK_CLI_PIN",
            repository,
            path,
            index + 1,
            "Slack CLI pins must use a canonical block-style env mapping.",
          ),
        );
      }
      continue;
    }

    const block = nestedBlock(lines, index, envIndent);
    const entries = new Map();
    for (const child of block.children) {
      if (child.indent !== block.directIndent) continue;
      const entry = /^\s*(SLACK_CLI_(?:ASSET|SHA256|VERSION))\s*:\s*(.*)$/.exec(
        child.line,
      );
      if (!entry) continue;
      if (!entries.has(entry[1])) entries.set(entry[1], []);
      entries.get(entry[1]).push({
        index: child.index,
        raw: entry[2],
      });
    }
    if (entries.size === 0) continue;

    const invalidCardinality = SLACK_CLI_PIN_KEYS.filter(
      (key) => (entries.get(key)?.length ?? 0) !== 1,
    );
    if (invalidCardinality.length > 0) {
      findings.push(
        finding(
          "INCOMPLETE_SLACK_CLI_PIN",
          repository,
          path,
          index + 1,
          `A Slack CLI env block must contain each pin exactly once; invalid keys: ${invalidCardinality.join(", ")}.`,
        ),
      );
      continue;
    }

    const values = new Map();
    let scalarFailed = false;
    for (const key of SLACK_CLI_PIN_KEYS) {
      const entry = entries.get(key)[0];
      try {
        values.set(
          key,
          workflowLiteralScalar(entry.raw, `Slack CLI pin ${key}`),
        );
      } catch (error) {
        scalarFailed = true;
        findings.push(
          finding(
            "UNSUPPORTED_SLACK_CLI_PIN",
            repository,
            path,
            entry.index + 1,
            error.message,
          ),
        );
      }
    }
    if (scalarFailed) continue;

    const version = values.get("SLACK_CLI_VERSION");
    const asset = values.get("SLACK_CLI_ASSET");
    const checksum = values.get("SLACK_CLI_SHA256");
    if (!EXACT_STABLE_VERSION.test(version)) {
      findings.push(
        finding(
          "NON_EXACT_SLACK_CLI_VERSION_PIN",
          repository,
          path,
          entries.get("SLACK_CLI_VERSION")[0].index + 1,
          `SLACK_CLI_VERSION must be an exact stable version, not ${version}.`,
        ),
      );
      continue;
    }
    const assetPrefix = `slack_cli_${version}_`;
    if (
      !asset.startsWith(assetPrefix) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.slice(assetPrefix.length))
    ) {
      findings.push(
        finding(
          "INVALID_SLACK_CLI_ASSET_PIN",
          repository,
          path,
          entries.get("SLACK_CLI_ASSET")[0].index + 1,
          `SLACK_CLI_ASSET must be a canonical official versioned asset for ${version}.`,
        ),
      );
      continue;
    }
    if (!SLACK_CLI_CHECKSUM.test(checksum)) {
      findings.push(
        finding(
          "INVALID_SLACK_CLI_CHECKSUM_PIN",
          repository,
          path,
          entries.get("SLACK_CLI_SHA256")[0].index + 1,
          "SLACK_CLI_SHA256 must be an exact 64-character SHA-256 checksum.",
        ),
      );
      continue;
    }
    slackCliReferences.push({
      repository,
      path,
      line: entries.get("SLACK_CLI_VERSION")[0].index + 1,
      version,
      asset,
      checksum: checksum.toLowerCase(),
      checksumLine: entries.get("SLACK_CLI_SHA256")[0].index + 1,
    });
  }

  return { denoReferences, slackCliReferences, findings };
}

function indentationOf(line, context) {
  const indentation = /^\s*/.exec(line)[0];
  if (indentation.includes("\t")) {
    throw new Error(`${context} must not use tabs for YAML indentation.`);
  }
  return indentation.length;
}

function metadataScalar(raw, key) {
  let parsed;
  try {
    parsed = parseUsesScalar(raw);
  } catch (error) {
    throw new Error(`Action metadata runs.${key} is not a supported scalar.`, {
      cause: error,
    });
  }
  if (/^[>|&*!\[{]/.test(parsed.value) || parsed.value.includes("${{")) {
    throw new Error(`Action metadata runs.${key} is not a literal scalar.`);
  }
  return parsed.value;
}

export function parseActionRuntime(content) {
  if (typeof content !== "string") {
    throw new Error("Action metadata must be a string.");
  }
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  let runsIndex = -1;
  let runsIndent = -1;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = /^\s*runs\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const indentation = indentationOf(line, "Action metadata runs mapping");
    if (indentation !== 0) continue;
    if (runsIndex !== -1) {
      throw new Error("Action metadata contains duplicate runs mappings.");
    }
    const remainder = match[1].trim();
    if (remainder && !remainder.startsWith("#")) {
      throw new Error(
        "Flow-style Action metadata runs mapping is unsupported.",
      );
    }
    runsIndex = index;
    runsIndent = indentation;
  }
  if (runsIndex === -1) {
    throw new Error("Action metadata has no canonical runs mapping.");
  }

  const childLines = [];
  for (let index = runsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const indent = indentationOf(line, "Action metadata runs mapping");
    if (indent <= runsIndent) break;
    childLines.push({ line, indent });
  }
  if (childLines.length === 0) {
    throw new Error("Action metadata runs mapping is empty.");
  }
  const directIndent = Math.min(...childLines.map(({ indent }) => indent));
  const values = new Map();
  for (const { line, indent } of childLines) {
    if (indent !== directIndent) continue;
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match || !["using", "image"].includes(match[1])) continue;
    if (values.has(match[1])) {
      throw new Error(`Action metadata contains duplicate runs.${match[1]}.`);
    }
    values.set(match[1], metadataScalar(match[2], match[1]));
  }
  const using = values.get("using");
  if (!using) {
    throw new Error("Action metadata has no canonical literal runs.using.");
  }
  const image = values.get("image");
  if (using.toLowerCase() === "docker" && !image) {
    throw new Error(
      "Docker Action metadata has no canonical literal runs.image.",
    );
  }
  return Object.freeze({ using: using.toLowerCase(), image });
}

export function parseStableSemverTag(tag) {
  if (typeof tag !== "string") return undefined;
  const match = STABLE_SEMVER_TAG.exec(tag);
  if (!match) return undefined;
  return {
    tag,
    prefix: match[1],
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4]),
  };
}

export function selectLatestStableTag(tags) {
  const versions = tags
    .map((entry) =>
      parseStableSemverTag(typeof entry === "string" ? entry : entry?.name),
    )
    .filter(Boolean);
  versions.sort(
    (left, right) =>
      right.major - left.major ||
      right.minor - left.minor ||
      right.patch - left.patch ||
      left.tag.localeCompare(right.tag),
  );
  return versions[0]?.tag;
}

async function resolveTagToCommit(api, owner, repository, tag) {
  const ref = await api.getJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/tags/${encodeURIComponent(tag)}`,
    { allow404: true },
  );
  if (!ref) return undefined;

  let object = ref.object;
  const visited = new Set();
  for (let depth = 0; depth < 10; depth += 1) {
    if (!object || typeof object.sha !== "string") {
      throw new Error(`${owner}/${repository} tag ${tag} has no Git object.`);
    }
    if (visited.has(object.sha)) {
      throw new Error(`${owner}/${repository} tag ${tag} contains a cycle.`);
    }
    visited.add(object.sha);
    if (object.type === "commit") return object.sha.toLowerCase();
    if (object.type !== "tag") {
      throw new Error(
        `${owner}/${repository} tag ${tag} resolves to unsupported Git object type ${object.type}.`,
      );
    }
    const annotated = await api.getJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/tags/${object.sha}`,
    );
    object = annotated.object;
  }
  throw new Error(`${owner}/${repository} tag ${tag} exceeded peel depth.`);
}

function encodeRefPrefix(prefix) {
  return prefix.split("/").map(encodeURIComponent).join("/");
}

async function latestStableRelease(api, owner, repository, tagHint) {
  const parsedHint = parseStableSemverTag(tagHint);
  if (parsedHint?.prefix) {
    const matchingRefs = await api.getJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/matching-refs/tags/${encodeRefPrefix(parsedHint.prefix)}`,
    );
    if (!Array.isArray(matchingRefs)) {
      throw new Error(
        `${owner}/${repository} returned malformed matching tag references.`,
      );
    }
    const familyTags = matchingRefs
      .map((entry) =>
        typeof entry.ref === "string" && entry.ref.startsWith("refs/tags/")
          ? entry.ref.slice("refs/tags/".length)
          : undefined,
      )
      .filter((tag) => parseStableSemverTag(tag)?.prefix === parsedHint.prefix);
    const latestFamilyTag = selectLatestStableTag(familyTags);
    if (!latestFamilyTag) {
      throw new Error(
        `${owner}/${repository} has no stable semantic-version tag in family ${parsedHint.prefix}*.`,
      );
    }
    return latestFamilyTag;
  }

  const latest = await api.getJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/latest`,
    { allow404: true },
  );
  if (latest) {
    if (
      latest.draft === true ||
      latest.prerelease === true ||
      typeof latest.tag_name !== "string" ||
      latest.tag_name.length === 0
    ) {
      throw new Error(
        `${owner}/${repository} returned an invalid latest stable release.`,
      );
    }
    return latest.tag_name;
  }

  const tags = await api.paginate(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tags`,
  );
  const tag = selectLatestStableTag(tags);
  if (!tag) {
    throw new Error(
      `${owner}/${repository} has neither a latest stable release nor a stable semantic-version tag.`,
    );
  }
  return tag;
}

function parseOfficialStableRelease(release, source, expectedTag) {
  if (
    !release ||
    Array.isArray(release) ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== "string"
  ) {
    throw new Error(`${source} returned a malformed stable release.`);
  }
  if (expectedTag && release.tag_name !== expectedTag) {
    throw new Error(
      `${source} returned release ${release.tag_name} for requested tag ${expectedTag}.`,
    );
  }
  const versionMatch = EXACT_STABLE_VERSION_TAG.exec(release.tag_name);
  if (!versionMatch) {
    throw new Error(
      `${source} release tag ${release.tag_name} is not an exact stable vMAJOR.MINOR.PATCH tag.`,
    );
  }
  return Object.freeze({
    payload: release,
    tag: release.tag_name,
    version: `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}`,
  });
}

async function officialRelease(
  api,
  source,
  { tag, allow404 = false, cache = new Map() } = {},
) {
  const [owner, repository] = source.split("/");
  const key = `${source.toLowerCase()}@${tag ?? "latest"}`;
  return cachePromise(cache, key, async () => {
    const path = tag
      ? `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/tags/${encodeURIComponent(tag)}`
      : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/latest`;
    const release = await api.getJson(path, { allow404 });
    if (!release) return undefined;
    return parseOfficialStableRelease(release, source, tag);
  });
}

async function verifiedReleaseCommit(api, source, release, commitCache) {
  const [owner, repository] = source.split("/");
  const sha = await resolveTagToCommit(api, owner, repository, release.tag);
  if (!sha) {
    throw new Error(`${source} release tag ${release.tag} is missing.`);
  }
  return verifiedCommit(api, owner, repository, sha, commitCache);
}

function officialSlackCliAsset(release, name) {
  if (!Array.isArray(release.payload.assets)) {
    throw new Error(
      `${SLACK_CLI_SOURCE} release ${release.tag} returned malformed assets.`,
    );
  }
  const matching = release.payload.assets.filter(
    (asset) => asset?.name === name,
  );
  if (matching.length > 1) {
    throw new Error(
      `${SLACK_CLI_SOURCE} release ${release.tag} contains duplicate asset ${name}.`,
    );
  }
  if (matching.length === 0) return undefined;
  const asset = matching[0];
  const expectedUrl = `https://github.com/${SLACK_CLI_SOURCE}/releases/download/${release.tag}/${encodeURIComponent(name)}`;
  if (
    asset.state !== "uploaded" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.browser_download_url !== expectedUrl
  ) {
    throw new Error(
      `${SLACK_CLI_SOURCE} release ${release.tag} returned invalid metadata for asset ${name}.`,
    );
  }
  if (typeof asset.digest !== "string" || !SHA256_DIGEST.test(asset.digest)) {
    return Object.freeze({ asset, checksum: undefined });
  }
  return Object.freeze({
    asset,
    checksum: asset.digest.slice("sha256:".length).toLowerCase(),
  });
}

export async function auditRuntimeToolUpdates({
  api,
  denoReferences = [],
  slackCliReferences = [],
  commitCache = new Map(),
  releaseCache = new Map(),
} = {}) {
  if (!api || typeof api.getJson !== "function") {
    throw new Error("A GitHub read-only API client is required.");
  }
  const findings = [];

  if (denoReferences.length > 0) {
    const latestDeno = await officialRelease(api, DENO_RUNTIME_SOURCE, {
      cache: releaseCache,
    });
    const latestCommit = await verifiedReleaseCommit(
      api,
      DENO_RUNTIME_SOURCE,
      latestDeno,
      commitCache,
    );
    for (const reference of denoReferences) {
      if (!latestCommit.verified) {
        findings.push(
          finding(
            "UNVERIFIED_DENO_RELEASE",
            reference.repository,
            reference.path,
            reference.line,
            `${DENO_RUNTIME_SOURCE} latest stable release ${latestDeno.tag}@${latestCommit.sha} is not GitHub-verified (reason: ${latestCommit.reason}).`,
            reference.value,
          ),
        );
      }
      if (reference.version !== latestDeno.version) {
        findings.push(
          finding(
            "STALE_DENO_VERSION_PIN",
            reference.repository,
            reference.path,
            reference.line,
            `deno-version ${reference.value} is not the latest official stable Deno release ${latestDeno.version}.`,
            reference.value,
          ),
        );
      }
    }
  }

  if (slackCliReferences.length > 0) {
    const latestSlack = await officialRelease(api, SLACK_CLI_SOURCE, {
      cache: releaseCache,
    });
    const latestCommit = await verifiedReleaseCommit(
      api,
      SLACK_CLI_SOURCE,
      latestSlack,
      commitCache,
    );
    for (const reference of slackCliReferences) {
      if (!latestCommit.verified) {
        findings.push(
          finding(
            "UNVERIFIED_SLACK_CLI_RELEASE",
            reference.repository,
            reference.path,
            reference.line,
            `${SLACK_CLI_SOURCE} latest stable release ${latestSlack.tag}@${latestCommit.sha} is not GitHub-verified (reason: ${latestCommit.reason}).`,
            reference.asset,
          ),
        );
      }

      const pinnedTag = `v${reference.version}`;
      const pinnedRelease =
        pinnedTag === latestSlack.tag
          ? latestSlack
          : await officialRelease(api, SLACK_CLI_SOURCE, {
              tag: pinnedTag,
              allow404: true,
              cache: releaseCache,
            });
      if (!pinnedRelease) {
        findings.push(
          finding(
            "UNKNOWN_SLACK_CLI_RELEASE",
            reference.repository,
            reference.path,
            reference.line,
            `${SLACK_CLI_SOURCE} has no official stable release ${pinnedTag}.`,
            reference.asset,
          ),
        );
      } else {
        const pinnedCommit = await verifiedReleaseCommit(
          api,
          SLACK_CLI_SOURCE,
          pinnedRelease,
          commitCache,
        );
        if (!pinnedCommit.verified) {
          findings.push(
            finding(
              "UNVERIFIED_SLACK_CLI_PINNED_RELEASE",
              reference.repository,
              reference.path,
              reference.line,
              `${SLACK_CLI_SOURCE} pinned release ${pinnedTag}@${pinnedCommit.sha} is not GitHub-verified (reason: ${pinnedCommit.reason}).`,
              reference.asset,
            ),
          );
        }
        const pinnedAsset = officialSlackCliAsset(
          pinnedRelease,
          reference.asset,
        );
        if (!pinnedAsset) {
          findings.push(
            finding(
              "UNKNOWN_SLACK_CLI_ASSET",
              reference.repository,
              reference.path,
              reference.line,
              `${SLACK_CLI_SOURCE} release ${pinnedTag} does not contain asset ${reference.asset}.`,
              reference.asset,
            ),
          );
        } else if (!pinnedAsset.checksum) {
          findings.push(
            finding(
              "MISSING_OFFICIAL_SLACK_CLI_CHECKSUM",
              reference.repository,
              reference.path,
              reference.checksumLine,
              `${SLACK_CLI_SOURCE} release ${pinnedTag} does not expose a SHA-256 digest for ${reference.asset}.`,
              reference.asset,
            ),
          );
        } else if (pinnedAsset.checksum !== reference.checksum) {
          findings.push(
            finding(
              "SLACK_CLI_CHECKSUM_MISMATCH",
              reference.repository,
              reference.path,
              reference.checksumLine,
              `Pinned checksum ${reference.checksum} does not match the official release-asset checksum ${pinnedAsset.checksum} for ${reference.asset}.`,
              reference.asset,
            ),
          );
        }
      }

      const assetSuffix = reference.asset.slice(
        `slack_cli_${reference.version}_`.length,
      );
      const latestAssetName = `slack_cli_${latestSlack.version}_${assetSuffix}`;
      const latestAsset = officialSlackCliAsset(latestSlack, latestAssetName);
      if (!latestAsset) {
        findings.push(
          finding(
            "LATEST_SLACK_CLI_ASSET_UNAVAILABLE",
            reference.repository,
            reference.path,
            reference.line,
            `${SLACK_CLI_SOURCE} latest stable release ${latestSlack.tag} does not contain the corresponding official asset ${latestAssetName}.`,
            reference.asset,
          ),
        );
      } else if (!latestAsset.checksum) {
        findings.push(
          finding(
            "MISSING_LATEST_SLACK_CLI_CHECKSUM",
            reference.repository,
            reference.path,
            reference.line,
            `${SLACK_CLI_SOURCE} latest stable release ${latestSlack.tag} does not expose a SHA-256 digest for ${latestAssetName}.`,
            reference.asset,
          ),
        );
      } else if (reference.version !== latestSlack.version) {
        findings.push(
          finding(
            "STALE_SLACK_CLI_VERSION_PIN",
            reference.repository,
            reference.path,
            reference.line,
            `Slack CLI ${reference.version} is not the latest official stable release ${latestSlack.version}; expected asset ${latestAssetName} with SHA-256 ${latestAsset.checksum}.`,
            reference.asset,
          ),
        );
      }
    }
  }

  return { findings };
}

function cachePromise(cache, key, operation) {
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(operation));
  return cache.get(key);
}

async function verifiedCommit(api, owner, repository, sha, cache) {
  const key = `${owner.toLowerCase()}/${repository.toLowerCase()}@${sha}`;
  return cachePromise(cache, key, async () => {
    const commit = await api.getJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${sha}`,
    );
    if (typeof commit.sha !== "string" || commit.sha.toLowerCase() !== sha) {
      throw new Error(
        `${owner}/${repository} returned a different commit for ${sha}.`,
      );
    }
    return {
      sha,
      verified: commit.commit?.verification?.verified === true,
      reason: commit.commit?.verification?.reason ?? "unknown",
    };
  });
}

async function decodeBlob(api, repository, blob, cache) {
  return cachePromise(cache, blob.sha, async () => {
    const response = await api.getJson(
      `/repos/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}/git/blobs/${blob.sha}`,
    );
    if (
      response.encoding !== "base64" ||
      typeof response.content !== "string"
    ) {
      throw new Error(
        `${repository.full_name}/${blob.path} was not returned as a base64 Git blob.`,
      );
    }
    return Buffer.from(
      response.content.replaceAll("\n", ""),
      "base64",
    ).toString("utf8");
  });
}

function encodeRepositoryPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeContentsFile(response, source, metadataPath) {
  if (
    response?.type !== "file" ||
    response.encoding !== "base64" ||
    typeof response.content !== "string"
  ) {
    throw new Error(
      `${source}/${metadataPath} was not returned as a base64 GitHub contents file.`,
    );
  }
  return Buffer.from(response.content.replaceAll("\n", ""), "base64").toString(
    "utf8",
  );
}

async function readActionRuntime(api, reference, cache) {
  if (/\.ya?ml$/i.test(reference.actionPath ?? "")) {
    return Object.freeze({ kind: "reusable-workflow" });
  }
  const key = `${reference.source.toLowerCase()}@${reference.sha}/${reference.actionPath ?? ""}`;
  return cachePromise(cache, key, async () => {
    const directory = reference.actionPath ? `${reference.actionPath}/` : "";
    for (const filename of ["action.yml", "action.yaml"]) {
      const metadataPath = `${directory}${filename}`;
      const response = await api.getJson(
        `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.sourceRepository)}/contents/${encodeRepositoryPath(metadataPath)}?ref=${encodeURIComponent(reference.sha)}`,
        { allow404: true },
      );
      if (!response) continue;
      const content = decodeContentsFile(
        response,
        reference.source,
        metadataPath,
      );
      let runtime;
      try {
        runtime = parseActionRuntime(content);
      } catch (error) {
        return Object.freeze({
          kind: "invalid-action",
          metadataPath,
          error: error.message,
        });
      }
      return Object.freeze({
        kind: "action",
        metadataPath,
        runtime,
      });
    }
    return undefined;
  });
}

export async function runAudit({
  api,
  registryClient,
  dockerDigestBaseline = new Map(),
  organization = DEFAULT_ORGANIZATION,
  minimumRepositories = DEFAULT_MINIMUM_REPOSITORIES,
} = {}) {
  if (!api || typeof api.getJson !== "function") {
    throw new Error("A GitHub read-only API client is required.");
  }
  if (!(dockerDigestBaseline instanceof Map)) {
    throw new Error("Docker Action digest baseline must be a Map.");
  }

  const allRepositories = await api.paginate(
    `/orgs/${encodeURIComponent(organization)}/repos?type=all`,
  );
  const repositories = allRepositories
    .filter(
      (repository) =>
        repository.archived !== true && repository.disabled !== true,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  if (repositories.length < minimumRepositories) {
    throw new Error(
      `The token can see only ${repositories.length} active, non-archived repositories; expected at least ${minimumRepositories}.`,
    );
  }

  const findings = [];
  const references = [];
  const denoReferences = [];
  const slackCliReferences = [];
  const blobCache = new Map();
  let yamlFileCount = 0;

  for (const repository of repositories) {
    if (
      typeof repository.name !== "string" ||
      typeof repository.default_branch !== "string" ||
      typeof repository.owner?.login !== "string"
    ) {
      throw new Error("GitHub returned incomplete repository metadata.");
    }
    const tree = await api.getJson(
      `/repos/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`,
    );
    if (tree.truncated !== false || !Array.isArray(tree.tree)) {
      throw new Error(
        `${repository.full_name} returned a truncated or malformed recursive Git tree; refusing incomplete coverage.`,
      );
    }
    const yamlBlobs = tree.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        typeof entry.sha === "string" &&
        isAuditedYamlPath(entry.path),
    );
    yamlFileCount += yamlBlobs.length;

    for (const blob of yamlBlobs) {
      const content = await decodeBlob(api, repository, blob, blobCache);
      const parsed = parseUsesReferences(content, {
        repository: repository.full_name,
        path: blob.path,
      });
      findings.push(...parsed.findings);
      references.push(...parsed.references);
      const runtimePins = parseWorkflowRuntimePins(
        content,
        {
          repository: repository.full_name,
          path: blob.path,
        },
        parsed.references,
      );
      findings.push(...runtimePins.findings);
      denoReferences.push(...runtimePins.denoReferences);
      slackCliReferences.push(...runtimePins.slackCliReferences);
    }
  }

  if (yamlFileCount === 0) {
    throw new Error("No workflow or Action YAML files were found.");
  }

  const latestCache = new Map();
  const tagCache = new Map();
  const commitCache = new Map();
  const actionRuntimeCache = new Map();
  const registryDigestCache = new Map();
  const dockerImages = new Set();
  let dockerActionReferenceCount = 0;
  for (const reference of references) {
    const sourceKey = reference.source.toLowerCase();
    const tagFamily = parseStableSemverTag(reference.commentTag)?.prefix ?? "";
    const latestKey = `${sourceKey}|${tagFamily}`;
    const latest = await cachePromise(latestCache, latestKey, async () => {
      const tag = await latestStableRelease(
        api,
        reference.owner,
        reference.sourceRepository,
        reference.commentTag,
      );
      const sha = await resolveTagToCommit(
        api,
        reference.owner,
        reference.sourceRepository,
        tag,
      );
      if (!sha) {
        throw new Error(
          `${reference.source} latest release tag ${tag} is missing.`,
        );
      }
      const commit = await verifiedCommit(
        api,
        reference.owner,
        reference.sourceRepository,
        sha,
        commitCache,
      );
      return { tag, sha, commit };
    });

    const pinnedCommit = await verifiedCommit(
      api,
      reference.owner,
      reference.sourceRepository,
      reference.sha,
      commitCache,
    );
    if (!pinnedCommit.verified) {
      findings.push(
        finding(
          "UNVERIFIED_ACTION_COMMIT",
          reference.repository,
          reference.path,
          reference.line,
          `${reference.source}@${reference.sha} is not GitHub-verified (reason: ${pinnedCommit.reason}).`,
          reference.value,
        ),
      );
    }
    if (!latest.commit.verified) {
      findings.push(
        finding(
          "UNVERIFIED_LATEST_RELEASE",
          reference.repository,
          reference.path,
          reference.line,
          `${reference.source} latest stable release ${latest.tag}@${latest.sha} is not GitHub-verified (reason: ${latest.commit.reason}).`,
          reference.value,
        ),
      );
    }

    if (reference.commentTag) {
      const tagKey = `${sourceKey}@${reference.commentTag}`;
      const commentSha = await cachePromise(tagCache, tagKey, () =>
        resolveTagToCommit(
          api,
          reference.owner,
          reference.sourceRepository,
          reference.commentTag,
        ),
      );
      if (!commentSha) {
        findings.push(
          finding(
            "UNKNOWN_VERSION_COMMENT",
            reference.repository,
            reference.path,
            reference.line,
            `${reference.source} has no tag named ${reference.commentTag}.`,
            reference.value,
          ),
        );
      } else if (commentSha !== reference.sha) {
        findings.push(
          finding(
            "VERSION_COMMENT_SHA_MISMATCH",
            reference.repository,
            reference.path,
            reference.line,
            `Comment ${reference.commentTag} resolves to ${commentSha}, not pinned SHA ${reference.sha}.`,
            reference.value,
          ),
        );
      }
      if (reference.commentTag !== latest.tag) {
        findings.push(
          finding(
            "STALE_VERSION_COMMENT",
            reference.repository,
            reference.path,
            reference.line,
            `Comment ${reference.commentTag} is not the latest stable release tag ${latest.tag} for ${reference.source}.`,
            reference.value,
          ),
        );
      }
    }

    if (reference.sha !== latest.sha) {
      findings.push(
        finding(
          "STALE_ACTION_PIN",
          reference.repository,
          reference.path,
          reference.line,
          `${reference.source} is pinned to ${reference.sha}; latest stable ${latest.tag} resolves to ${latest.sha}.`,
          reference.value,
        ),
      );
    }

    const actionRuntime = await readActionRuntime(
      api,
      reference,
      actionRuntimeCache,
    );
    if (!actionRuntime) {
      findings.push(
        finding(
          "ACTION_METADATA_NOT_FOUND",
          reference.repository,
          reference.path,
          reference.line,
          `${reference.value} does not expose action.yml or action.yaml at the pinned SHA.`,
          reference.value,
        ),
      );
      continue;
    }
    if (actionRuntime.kind === "reusable-workflow") continue;
    if (actionRuntime.kind === "invalid-action") {
      findings.push(
        finding(
          "UNAUDITABLE_ACTION_METADATA",
          reference.repository,
          reference.path,
          reference.line,
          `${reference.source}/${actionRuntime.metadataPath}@${reference.sha} cannot be audited: ${actionRuntime.error}`,
          reference.value,
        ),
      );
      continue;
    }
    if (
      actionRuntime.runtime.using !== "docker" ||
      !actionRuntime.runtime.image.startsWith("docker://")
    ) {
      continue;
    }

    dockerActionReferenceCount += 1;
    let image;
    try {
      image = parseDockerImageReference(actionRuntime.runtime.image);
    } catch (error) {
      findings.push(
        finding(
          "INVALID_DOCKER_IMAGE_REFERENCE",
          reference.repository,
          reference.path,
          reference.line,
          `${reference.source}/${actionRuntime.metadataPath}@${reference.sha} declares an invalid external Docker image: ${error.message}`,
          reference.value,
        ),
      );
      continue;
    }
    dockerImages.add(image.canonical);
    if (!registryClient || typeof registryClient.resolveDigest !== "function") {
      throw new Error(
        "A read-only OCI registry client is required when external Docker Actions are found.",
      );
    }

    let currentDigest;
    try {
      currentDigest = await cachePromise(
        registryDigestCache,
        image.canonical,
        () => registryClient.resolveDigest(image),
      );
    } catch (error) {
      if (error instanceof OciRegistryError && error.code) {
        findings.push(
          finding(
            error.code,
            reference.repository,
            reference.path,
            reference.line,
            `${reference.source}/${actionRuntime.metadataPath}@${reference.sha}: ${error.message}`,
            reference.value,
          ),
        );
        continue;
      }
      throw error;
    }
    currentDigest = canonicalDigest(
      currentDigest,
      `Resolved Docker digest for ${image.canonical}`,
    );
    if (image.digest) continue;

    const baselineDigest = dockerDigestBaseline.get(image.canonical);
    if (!baselineDigest) {
      findings.push(
        finding(
          "MISSING_DOCKER_IMAGE_DIGEST_BASELINE",
          reference.repository,
          reference.path,
          reference.line,
          `${image.canonical} currently resolves to ${currentDigest}, but has no version-controlled digest baseline.`,
          reference.value,
        ),
      );
    } else if (
      canonicalDigest(
        baselineDigest,
        `Docker digest baseline for ${image.canonical}`,
      ) !== currentDigest
    ) {
      findings.push(
        finding(
          "DOCKER_IMAGE_DIGEST_DRIFT",
          reference.repository,
          reference.path,
          reference.line,
          `${image.canonical} now resolves to ${currentDigest}, not controlled baseline ${baselineDigest}.`,
          reference.value,
        ),
      );
    }
  }

  const runtimeToolAudit = await auditRuntimeToolUpdates({
    api,
    denoReferences,
    slackCliReferences,
    commitCache,
  });
  findings.push(...runtimeToolAudit.findings);

  findings.sort(
    (left, right) =>
      left.repository.localeCompare(right.repository) ||
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  );
  return {
    organization,
    repositoryCount: repositories.length,
    yamlFileCount,
    referenceCount: references.length,
    dockerActionReferenceCount,
    uniqueDockerImageCount: dockerImages.size,
    denoRuntimeReferenceCount: denoReferences.length,
    slackCliReferenceCount: slackCliReferences.length,
    uniqueActionRepositoryCount: new Set(
      references.map((reference) => reference.source.toLowerCase()),
    ).size,
    findings,
  };
}

function escapeWorkflowCommand(value, property = false) {
  let escaped = String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  if (property) {
    escaped = escaped.replaceAll(":", "%3A").replaceAll(",", "%2C");
  }
  return escaped;
}

export function formatFindingAnnotation(entry) {
  const title = escapeWorkflowCommand(entry.code, true);
  const file = escapeWorkflowCommand(`${entry.repository}/${entry.path}`, true);
  const message = escapeWorkflowCommand(entry.message);
  return `::error file=${file},line=${entry.line},title=${title}::${message}`;
}

function brasiliaTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "Etc/GMT+3",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function renderSummary(result, date = new Date()) {
  const lines = [
    "## Auditoria de dependências do GitHub Actions",
    "",
    `- Gerado em: ${brasiliaTimestamp(date)}`,
    `- Repositórios ativos e não arquivados: ${result.repositoryCount}`,
    `- Workflows e Actions YAML auditados: ${result.yamlFileCount}`,
    `- Referências externas auditadas: ${result.referenceCount}`,
    `- Repositórios de Actions distintos: ${result.uniqueActionRepositoryCount}`,
    `- Referências a Actions Docker externas: ${result.dockerActionReferenceCount ?? 0}`,
    `- Imagens Docker externas distintas: ${result.uniqueDockerImageCount ?? 0}`,
    `- Pins do runtime Deno: ${result.denoRuntimeReferenceCount ?? 0}`,
    `- Pins da Slack CLI: ${result.slackCliReferenceCount ?? 0}`,
    `- Achados: ${result.findings.length}`,
    "",
  ];
  if (result.findings.length === 0) {
    lines.push(
      "Todos os pins externos, runtimes e ferramentas auditados estão atuais, coerentes e verificados.",
    );
  } else {
    lines.push("### Achados", "");
    for (const entry of result.findings) {
      lines.push(
        `- **${entry.code}** — \`${entry.repository}/${entry.path}:${entry.line}\`: ${entry.message}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function main(environment = process.env) {
  const configuration = readConfiguration(environment);
  const api = new GitHubReadonlyApi({ token: configuration.token });
  const registryClient = new OciRegistryReadonlyClient();
  const dockerDigestBaseline = await loadDockerDigestBaseline();
  const result = await runAudit({
    api,
    registryClient,
    dockerDigestBaseline,
    organization: configuration.organization,
    minimumRepositories: configuration.minimumRepositories,
  });
  for (const entry of result.findings) {
    console.error(formatFindingAnnotation(entry));
  }
  const summary = renderSummary(result);
  if (configuration.summaryPath) {
    await fs.appendFile(configuration.summaryPath, summary, "utf8");
  }
  console.log(
    `Audited ${result.referenceCount} external uses references in ${result.yamlFileCount} YAML files across ${result.repositoryCount} repositories; docker-images=${result.uniqueDockerImageCount}; deno-pins=${result.denoRuntimeReferenceCount}; slack-cli-pins=${result.slackCliReferenceCount}; findings=${result.findings.length}.`,
  );
  if (result.findings.length > 0) process.exitCode = 1;
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `::error title=GITHUB_ACTIONS_PIN_AUDIT_FAILED::${escapeWorkflowCommand(error.message)}`,
    );
    process.exitCode = 1;
  });
}
