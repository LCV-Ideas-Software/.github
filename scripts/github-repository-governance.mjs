import { pathToFileURL } from "node:url";

export const API_VERSION = "2026-03-10";
export const REQUIRED_PULL_REQUEST_POLICY = "collaborators_only";

const API_ORIGIN = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "lcv-repository-governance";

function requiredEnvironmentValue(
  environment,
  name,
  { sensitive = false } = {},
) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  if (sensitive && value !== value.trim()) {
    throw new Error(
      `Required environment variable ${name} contains surrounding whitespace.`,
    );
  }
  return sensitive ? value : value.trim();
}

export function readConfiguration(environment = process.env) {
  const organizationName = requiredEnvironmentValue(
    environment,
    "ORGANIZATION_NAME",
  );
  const repository = requiredEnvironmentValue(environment, "GITHUB_REPOSITORY");
  if (repository !== `${organizationName}/.github`) {
    throw new Error(
      "Repository governance must run from the organization's .github repository.",
    );
  }
  if (
    requiredEnvironmentValue(environment, "GITHUB_REF") !== "refs/heads/main"
  ) {
    throw new Error("Repository governance is restricted to main.");
  }

  return Object.freeze({
    organizationName,
    token: requiredEnvironmentValue(environment, "TOKEN", { sensitive: true }),
  });
}

function apiUrl(pathname, searchParams) {
  const url = new URL(pathname, API_ORIGIN);
  for (const [name, value] of Object.entries(searchParams ?? {})) {
    url.searchParams.set(name, String(value));
  }
  return url;
}

function repositoryPath(organizationName, repositoryName) {
  return `/repos/${encodeURIComponent(organizationName)}/${encodeURIComponent(repositoryName)}`;
}

function apiError(response, method, pathname) {
  const requestId = response.headers.get("x-github-request-id");
  const sso = response.headers.get("x-github-sso");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const context = [];
  if (requestId) context.push(`request-id=${requestId}`);
  if (sso) context.push("sso-authorization=required");
  if (
    response.status === 429 ||
    (response.status === 403 && remaining === "0")
  ) {
    context.push("rate-limit-reached");
  }
  const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
  return new Error(
    `GitHub API ${method} ${pathname} returned HTTP ${response.status}${suffix}.`,
  );
}

async function githubRequest({
  token,
  method = "GET",
  url,
  body,
  fetchImpl,
  expectedStatuses = [200],
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `GitHub API ${method} ${url.pathname} could not be reached.`,
      {
        cause: error,
      },
    );
  }
  if (!expectedStatuses.includes(response.status)) {
    throw apiError(response, method, url.pathname);
  }
  return response.status === 204 ? undefined : response.json();
}

function validateRepository(repository, organizationName) {
  if (
    repository === null ||
    typeof repository !== "object" ||
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    typeof repository.name !== "string" ||
    repository.name === "" ||
    repository.owner?.login !== organizationName ||
    typeof repository.archived !== "boolean" ||
    typeof repository.disabled !== "boolean" ||
    typeof repository.has_pull_requests !== "boolean" ||
    typeof repository.pull_request_creation_policy !== "string"
  ) {
    throw new Error(
      "GitHub returned malformed repository governance metadata.",
    );
  }
  return repository;
}

function isCompliant(repository) {
  return (
    repository.has_pull_requests === true &&
    repository.pull_request_creation_policy === REQUIRED_PULL_REQUEST_POLICY
  );
}

async function listRepositories(configuration, fetchImpl) {
  const repositories = [];
  const ids = new Set();
  const names = new Set();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pathname = `/orgs/${encodeURIComponent(configuration.organizationName)}/repos`;
    const batch = await githubRequest({
      token: configuration.token,
      url: apiUrl(pathname, { page, per_page: PAGE_SIZE, type: "all" }),
      fetchImpl,
    });
    if (!Array.isArray(batch)) {
      throw new Error("GitHub returned a malformed repository list.");
    }
    for (const candidate of batch) {
      const repository = validateRepository(
        candidate,
        configuration.organizationName,
      );
      if (ids.has(repository.id) || names.has(repository.name)) {
        throw new Error("GitHub returned duplicate repository metadata.");
      }
      ids.add(repository.id);
      names.add(repository.name);
      repositories.push(repository);
    }
    if (batch.length < PAGE_SIZE) return repositories;
  }
  throw new Error(`Repository pagination exceeded ${MAX_PAGES} pages.`);
}

async function getRepository(configuration, repositoryName, fetchImpl) {
  const pathname = repositoryPath(
    configuration.organizationName,
    repositoryName,
  );
  const repository = await githubRequest({
    token: configuration.token,
    url: apiUrl(pathname),
    fetchImpl,
  });
  return validateRepository(repository, configuration.organizationName);
}

async function updateRepository(configuration, repository, fetchImpl) {
  const pathname = repositoryPath(
    configuration.organizationName,
    repository.name,
  );
  try {
    const updated = await githubRequest({
      token: configuration.token,
      method: "PATCH",
      url: apiUrl(pathname),
      body: {
        has_pull_requests: true,
        pull_request_creation_policy: REQUIRED_PULL_REQUEST_POLICY,
      },
      fetchImpl,
    });
    const validated = validateRepository(
      updated,
      configuration.organizationName,
    );
    if (!isCompliant(validated)) {
      throw new Error(
        `Repository ${repository.name} remained outside the required pull-request policy.`,
      );
    }
    return "updated";
  } catch (mutationError) {
    let reconciled;
    try {
      reconciled = await getRepository(
        configuration,
        repository.name,
        fetchImpl,
      );
    } catch (readError) {
      throw new AggregateError(
        [mutationError, readError],
        `The governance state of repository ${repository.name} is uncertain.`,
      );
    }
    if (isCompliant(reconciled)) return "reconciled";
    throw mutationError;
  }
}

export async function reconcileRepositoryGovernance(
  configuration,
  { fetchImpl = fetch } = {},
) {
  const repositories = await listRepositories(configuration, fetchImpl);
  const activeRepositories = repositories
    .filter((repository) => !repository.archived && !repository.disabled)
    .sort((left, right) => left.name.localeCompare(right.name));
  const results = [];

  for (const repository of activeRepositories) {
    const outcome = isCompliant(repository)
      ? "unchanged"
      : await updateRepository(configuration, repository, fetchImpl);
    results.push(Object.freeze({ name: repository.name, outcome }));
  }

  const verification = await listRepositories(configuration, fetchImpl);
  const drift = verification
    .filter((repository) => !repository.archived && !repository.disabled)
    .filter((repository) => !isCompliant(repository))
    .map((repository) => repository.name)
    .sort();
  if (drift.length > 0) {
    throw new Error(
      `Repository governance verification failed for: ${drift.join(", ")}.`,
    );
  }

  return Object.freeze({
    activeRepositoryCount: activeRepositories.length,
    updatedRepositoryCount: results.filter(
      ({ outcome }) => outcome === "updated",
    ).length,
    reconciledRepositoryCount: results.filter(
      ({ outcome }) => outcome === "reconciled",
    ).length,
    unchangedRepositoryCount: results.filter(
      ({ outcome }) => outcome === "unchanged",
    ).length,
    repositories: Object.freeze(results),
  });
}

async function main() {
  const result = await reconcileRepositoryGovernance(readConfiguration());
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
