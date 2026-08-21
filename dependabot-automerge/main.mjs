import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const DEPENDABOT_LOGIN = "dependabot[bot]";
const DEPENDABOT_USER_ID = 49699333;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseRepository(repository) {
  const parts = repository.split("/");
  assert(
    parts.length === 2 && parts.every(Boolean),
    "repository must use owner/name",
  );
  return { owner: parts[0], name: parts[1] };
}

function nextPage(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1];
  }
  return null;
}

export function validateRepository(settings, effectiveRules) {
  assert(settings.archived === false, "repository is archived");
  assert(settings.allow_auto_merge === true, "allow_auto_merge must be true");
  assert(
    settings.allow_update_branch === true,
    "allow_update_branch must be true",
  );
  assert(settings.allow_squash_merge === true, "squash merge must be enabled");
  assert(
    settings.allow_merge_commit === false,
    "merge commits must be disabled",
  );
  assert(
    settings.allow_rebase_merge === false,
    "rebase merge must be disabled",
  );

  const queue = effectiveRules.find((rule) => rule.type === "merge_queue");
  const checks = effectiveRules.find(
    (rule) => rule.type === "required_status_checks",
  );
  assert(queue, "effective rules must require the native merge queue");
  assert(
    checks?.parameters?.required_status_checks?.length > 0,
    "effective rules must require at least one status check",
  );
}

export function isCanonicalDependabotPull(pull, repository, defaultBranch) {
  return (
    pull.state === "open" &&
    pull.draft === false &&
    pull.user?.login === DEPENDABOT_LOGIN &&
    pull.user?.id === DEPENDABOT_USER_ID &&
    pull.base?.ref === defaultBranch &&
    pull.head?.repo?.full_name === repository &&
    pull.head?.ref?.startsWith("dependabot/")
  );
}

export function isCanonicalGraphPull(pull, repository, defaultBranch) {
  return (
    pull.state === "OPEN" &&
    pull.isDraft === false &&
    pull.author?.login === "dependabot" &&
    pull.author?.databaseId === DEPENDABOT_USER_ID &&
    pull.baseRefName === defaultBranch &&
    pull.headRepository?.nameWithOwner === repository &&
    pull.headRefName?.startsWith("dependabot/")
  );
}

export function decidePullAction(pull) {
  if (pull.autoMergeRequest || pull.mergeQueueEntry) return "already-armed";
  if (pull.mergeable === "CONFLICTING") return "manual-conflict";
  if (pull.mergeStateStatus === "BEHIND") return "update-branch";
  if (pull.mergeable === "UNKNOWN" || pull.mergeStateStatus === "UNKNOWN") {
    return "retry-later";
  }
  if (pull.mergeStateStatus === "CLEAN") return "enqueue";
  if (["BLOCKED", "HAS_HOOKS", "UNSTABLE"].includes(pull.mergeStateStatus)) {
    return "enable-auto-merge";
  }
  return "manual-review";
}

export async function processPullRequest(pull, api) {
  const action = decidePullAction(pull);
  const expectedHeadOid = pull.headRefOid;

  if (action === "update-branch") {
    const updated = await api.updateBranch(pull.id, expectedHeadOid);
    assert(
      updated?.headRefOid && updated.headRefOid !== expectedHeadOid,
      `PR #${pull.number}: branch update did not produce a new head`,
    );
    return { number: pull.number, action, head: updated.headRefOid };
  }

  if (action === "enqueue") {
    await api.enqueue(pull.id, expectedHeadOid);
    const readback = await api.getPull(pull.number);
    assert(
      readback.headRefOid === expectedHeadOid,
      `PR #${pull.number}: head changed`,
    );
    assert(
      readback.mergeQueueEntry,
      `PR #${pull.number}: queue readback missing`,
    );
    return { number: pull.number, action, head: expectedHeadOid };
  }

  if (action === "enable-auto-merge") {
    await api.enableAutoMerge(pull.id, expectedHeadOid);
    const readback = await api.getPull(pull.number);
    assert(
      readback.headRefOid === expectedHeadOid,
      `PR #${pull.number}: head changed`,
    );
    assert(
      readback.autoMergeRequest || readback.mergeQueueEntry,
      `PR #${pull.number}: auto-merge readback missing`,
    );
    return { number: pull.number, action, head: expectedHeadOid };
  }

  return { number: pull.number, action, head: expectedHeadOid };
}

class GitHubApi {
  constructor({ token, repository, fetchImpl = fetch }) {
    this.repository = repository;
    this.fetchImpl = fetchImpl;
    this.headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "lcv-dependabot-native-automerge",
      "X-GitHub-Api-Version": API_VERSION,
    };
  }

  async request(url, options = {}) {
    const response = await this.fetchImpl(url, {
      ...options,
      headers: { ...this.headers, ...options.headers },
    });
    const body = await response.text();
    const data = body ? JSON.parse(body) : null;
    if (!response.ok) {
      throw new Error(
        `${options.method ?? "GET"} ${new URL(url).pathname}: HTTP ${response.status}: ${data?.message ?? body}`,
      );
    }
    return { data, headers: response.headers };
  }

  async graphql(query, variables = {}) {
    const { data } = await this.request(`${API_ROOT}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (data.errors?.length) {
      throw new Error(
        `GraphQL: ${data.errors.map((error) => error.message).join("; ")}`,
      );
    }
    return data.data;
  }

  async getRepository() {
    return (await this.request(`${API_ROOT}/repos/${this.repository}`)).data;
  }

  async getEffectiveRules(defaultBranch) {
    const branch = encodeURIComponent(defaultBranch);
    return (
      await this.request(
        `${API_ROOT}/repos/${this.repository}/rules/branches/${branch}`,
      )
    ).data;
  }

  async listOpenPulls() {
    const pulls = [];
    let url = `${API_ROOT}/repos/${this.repository}/pulls?state=open&per_page=100`;
    let pages = 0;
    while (url) {
      pages += 1;
      assert(pages <= 10, "pull request pagination exceeded 10 pages");
      const response = await this.request(url);
      pulls.push(...response.data);
      url = nextPage(response.headers.get("link"));
    }
    return pulls;
  }

  async getPull(number) {
    const { owner, name } = parseRepository(this.repository);
    const data = await this.graphql(
      `query($owner:String!,$name:String!,$number:Int!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){
            id number state isDraft baseRefName headRefName headRefOid
            mergeable mergeStateStatus
            headRepository{nameWithOwner}
            author{login ... on Bot{databaseId}}
            autoMergeRequest{enabledAt}
            mergeQueueEntry{position state enqueuedAt}
          }
        }
      }`,
      { owner, name, number },
    );
    return data.repository?.pullRequest;
  }

  async updateBranch(pullRequestId, expectedHeadOid) {
    const data = await this.graphql(
      `mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){
        updatePullRequestBranch(input:{
          pullRequestId:$pullRequestId,
          expectedHeadOid:$expectedHeadOid,
          updateMethod:REBASE
        }){pullRequest{number headRefOid}}
      }`,
      { pullRequestId, expectedHeadOid },
    );
    return data.updatePullRequestBranch?.pullRequest;
  }

  async enqueue(pullRequestId, expectedHeadOid) {
    await this.graphql(
      `mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){
        enqueuePullRequest(input:{
          pullRequestId:$pullRequestId,
          expectedHeadOid:$expectedHeadOid,
          jump:false
        }){mergeQueueEntry{id position state}}
      }`,
      { pullRequestId, expectedHeadOid },
    );
  }

  async enableAutoMerge(pullRequestId, expectedHeadOid) {
    await this.graphql(
      `mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){
        enablePullRequestAutoMerge(input:{
          pullRequestId:$pullRequestId,
          expectedHeadOid:$expectedHeadOid,
          mergeMethod:SQUASH
        }){pullRequest{number headRefOid autoMergeRequest{enabledAt}}}
      }`,
      { pullRequestId, expectedHeadOid },
    );
  }
}

function writeSummary(repository, results) {
  const lines = [
    `## Dependabot native auto-merge — ${repository}`,
    "",
    "| PR | Resultado | SHA |",
    "| --- | --- | --- |",
    ...results.map(
      (result) =>
        `| #${result.number} | ${result.action} | \`${result.head.slice(0, 12)}\` |`,
    ),
    "",
  ];
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
  }
}

export async function reconcile({ token, repository, fetchImpl = fetch }) {
  assert(token, "github_token is required");
  parseRepository(repository);
  const api = new GitHubApi({ token, repository, fetchImpl });
  const settings = await api.getRepository();
  const rules = await api.getEffectiveRules(settings.default_branch);
  validateRepository(settings, rules);

  const candidates = (await api.listOpenPulls())
    .filter((pull) =>
      isCanonicalDependabotPull(pull, repository, settings.default_branch),
    )
    .sort((left, right) => left.number - right.number);

  const results = [];
  for (const candidate of candidates) {
    const pull = await api.getPull(candidate.number);
    assert(
      pull && isCanonicalGraphPull(pull, repository, settings.default_branch),
      `PR #${candidate.number}: canonical identity or target changed`,
    );
    assert(
      pull.headRefOid === candidate.head.sha,
      `PR #${candidate.number}: head changed`,
    );
    results.push(await processPullRequest(pull, api));
  }

  writeSummary(repository, results);
  const manual = results.filter((result) =>
    ["manual-conflict", "manual-review"].includes(result.action),
  );
  assert(
    manual.length === 0,
    `manual intervention required for PRs: ${manual.map((result) => `#${result.number}`).join(", ")}`,
  );
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  reconcile({
    token: process.env.AUTOMATION_TOKEN,
    repository: process.env.TARGET_REPOSITORY,
  })
    .then((results) => {
      console.log(JSON.stringify({ processed: results.length, results }));
    })
    .catch((error) => {
      console.error(`::error::${error.message}`);
      process.exitCode = 1;
    });
}
