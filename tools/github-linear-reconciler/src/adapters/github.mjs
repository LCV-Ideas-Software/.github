import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { z } from "zod";

const PaginatingOctokit = Octokit.plugin(paginateRest);
const MAX_PAGES = 1_000;
const pathSchema = z.string().regex(/^\/[A-Za-z0-9_{}./-]+$/u);

export const githubRepositoryResponseSchema = z.object({
  name: z.string().min(1),
  archived: z.boolean(),
  has_issues: z.boolean(),
  fork: z.boolean(),
});

const githubIssueResponseSchema = z.object({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["open", "closed"]),
  state_reason: z.enum(["completed", "not_planned", "reopened"]).nullable(),
  pull_request: z.unknown().optional(),
});

const githubCommentResponseSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  node_id: z.string().min(1).optional(),
  body: z.string().nullable(),
  user: z.object({ login: z.string().min(1) }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
});

const githubPullResponseSchema = z.object({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  merged_at: z.iso.datetime({ offset: true }).nullable(),
  merge_commit_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/iu)
    .nullable(),
});

function decode(schema, value, scope) {
  if (!schema || typeof schema.safeParse !== "function")
    throw new Error(`${scope}: schema Zod obrigatorio`);
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${scope}: payload GitHub invalido`);
  return result.data;
}

function githubStatus(issue) {
  if (issue.state === "open") {
    if (issue.state_reason !== null && issue.state_reason !== "reopened")
      throw new Error("combinacao state/state_reason GitHub invalida");
    return "active";
  }
  if (!new Set(["completed", "not_planned"]).has(issue.state_reason))
    throw new Error("combinacao state/state_reason GitHub invalida");
  return issue.state_reason === "not_planned" ? "canceled" : "completed";
}

function resourceKey(organization, repository, number) {
  return `${organization}/${repository}#${number}`.toLowerCase();
}

function isLinearLinkbackControl(comment) {
  return (
    new Set(["linear[bot]", "linear-code[bot]"]).has(
      comment.user?.login.toLowerCase(),
    ) && comment.body?.trimStart().startsWith("<!-- linear-linkback -->")
  );
}

function freezeSnapshot(snapshot) {
  for (const value of Object.values(snapshot)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item.comments) Object.freeze(item.comments);
        Object.freeze(item);
      }
      Object.freeze(value);
    }
  }
  return Object.freeze(snapshot);
}

/**
 * @typedef {object} GithubBoundarySnapshot
 * @property {boolean} complete
 * @property {ReadonlyArray<{source:"github",code:string,scope:string,message:string}>} failures
 * @property {number} capturedAtMs
 * @property {string} organization
 * @property {ReadonlyArray<{name:string,archived:boolean,issuesEnabled:boolean,fork:boolean}>} repositories
 * @property {ReadonlyArray<{key:string,repository:string,number:number,status:"active"|"completed"|"canceled",comments:ReadonlyArray<object>}>} issues
 * @property {ReadonlyArray<{key:string,repository:string,number:number,mergedAtMs:number|null,mergeCommitSha:string|null}>} pulls
 */

export function createGithubAdapter({ token, request, paginateIterator } = {}) {
  if (typeof token !== "string" || token.trim() === "")
    throw new Error("token GitHub somente leitura obrigatorio");
  const client =
    request && paginateIterator ? null : new PaginatingOctokit({ auth: token });
  const requestImpl =
    request ?? ((route, parameters) => client.request(route, parameters));
  const iteratorImpl =
    paginateIterator ??
    ((route, parameters) => client.paginate.iterator(route, parameters));

  async function get({ path, parameters = {}, schema }) {
    const parsedPath = pathSchema.safeParse(path);
    if (!parsedPath.success) throw new Error("path GitHub GET invalido");
    const response = await requestImpl(`GET ${parsedPath.data}`, parameters);
    return decode(schema, response?.data, `GET ${parsedPath.data}`);
  }

  async function paginate({ path, parameters = {}, itemSchema, identity }) {
    const parsedPath = pathSchema.safeParse(path);
    if (!parsedPath.success) throw new Error("path GitHub paginate invalido");
    if (typeof identity !== "function")
      throw new Error("paginate exige identidade estavel");
    const output = [];
    const identities = new Set();
    let pages = 0;
    for await (const response of iteratorImpl(
      `GET ${parsedPath.data}`,
      parameters,
    )) {
      pages += 1;
      if (pages > MAX_PAGES)
        throw new Error("paginacao GitHub excedeu o limite");
      if (!Array.isArray(response?.data))
        throw new Error("pagina GitHub nao retornou array");
      for (const raw of response.data) {
        const item = decode(itemSchema, raw, `GET ${parsedPath.data}`);
        const key = identity(item);
        if (typeof key !== "string" || key === "")
          throw new Error("identidade GitHub invalida");
        if (identities.has(key))
          throw new Error(`identidade GitHub duplicada: ${key}`);
        identities.add(key);
        output.push(item);
      }
    }
    return Object.freeze(output);
  }

  async function readOrganizationSnapshot({ organization, capturedAt }) {
    try {
      const capturedAtMs = Date.parse(capturedAt);
      if (!Number.isFinite(capturedAtMs))
        throw new Error("capturedAt invalido");
      const repositoriesRaw = await paginate({
        path: "/orgs/{org}/repos",
        parameters: { org: organization, type: "all", per_page: 100 },
        itemSchema: githubRepositoryResponseSchema,
        identity: (repository) => repository.name.toLowerCase(),
      });
      const repositories = repositoriesRaw
        .filter((repository) => !repository.archived)
        .map((repository) => ({
          name: repository.name.toLowerCase(),
          archived: false,
          issuesEnabled: repository.has_issues,
          fork: repository.fork,
        }));
      const issues = [];
      const pulls = [];
      for (const repository of repositories) {
        if (repository.issuesEnabled) {
          const rawIssues = await paginate({
            path: "/repos/{owner}/{repo}/issues",
            parameters: {
              owner: organization,
              repo: repository.name,
              state: "all",
              per_page: 100,
            },
            itemSchema: githubIssueResponseSchema,
            identity: (issue) => String(issue.number),
          });
          for (const issue of rawIssues.filter((item) => !item.pull_request)) {
            const comments = await paginate({
              path: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
              parameters: {
                owner: organization,
                repo: repository.name,
                issue_number: issue.number,
                per_page: 100,
              },
              itemSchema: githubCommentResponseSchema,
              identity: (comment) => comment.node_id ?? String(comment.id),
            });
            const key = resourceKey(
              organization,
              repository.name,
              issue.number,
            );
            issues.push({
              key,
              repository: repository.name,
              number: issue.number,
              status: githubStatus(issue),
              comments: comments
                .filter((comment) => !isLinearLinkbackControl(comment))
                .map((comment) => ({
                  id: comment.node_id ?? String(comment.id),
                  threadId: key,
                  createdAtMs: Date.parse(comment.created_at),
                })),
            });
          }
        }
        const rawPulls = await paginate({
          path: "/repos/{owner}/{repo}/pulls",
          parameters: {
            owner: organization,
            repo: repository.name,
            state: "all",
            per_page: 100,
          },
          itemSchema: githubPullResponseSchema,
          identity: (pull) => String(pull.number),
        });
        for (const pull of rawPulls) {
          pulls.push({
            key: resourceKey(organization, repository.name, pull.number),
            repository: repository.name,
            number: pull.number,
            mergedAtMs: pull.merged_at ? Date.parse(pull.merged_at) : null,
            mergeCommitSha: pull.merge_commit_sha?.toLowerCase() ?? null,
          });
        }
      }
      return freezeSnapshot({
        complete: true,
        failures: [],
        capturedAtMs,
        organization: organization.toLowerCase(),
        repositories,
        issues,
        pulls,
      });
    } catch (error) {
      return freezeSnapshot({
        complete: false,
        failures: [
          {
            source: "github",
            code: "boundary_invalid",
            scope: "organization",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        capturedAtMs: Number.isFinite(Date.parse(capturedAt))
          ? Date.parse(capturedAt)
          : 0,
        organization: String(organization ?? "").toLowerCase(),
        repositories: [],
        issues: [],
        pulls: [],
      });
    }
  }

  return Object.freeze({ get, paginate, readOrganizationSnapshot });
}

export async function readGithubSnapshot({
  config,
  token,
  capturedAt = new Date().toISOString(),
} = {}) {
  return createGithubAdapter({ token }).readOrganizationSnapshot({
    organization: config?.organization,
    capturedAt,
  });
}
