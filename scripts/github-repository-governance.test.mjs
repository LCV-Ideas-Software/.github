import assert from "node:assert/strict";
import test from "node:test";

import {
  API_VERSION,
  readConfiguration,
  reconcileRepositoryGovernance,
} from "./github-repository-governance.mjs";

const ORGANIZATION = "LCV-Ideas-Software";

function repository(
  name,
  {
    id = Math.abs(
      [...name].reduce(
        (total, character) => total + character.charCodeAt(0),
        1,
      ),
    ),
    archived = false,
    disabled = false,
    hasPullRequests = true,
    policy = "collaborators_only",
    owner = ORGANIZATION,
  } = {},
) {
  return {
    id,
    name,
    archived,
    disabled,
    has_pull_requests: hasPullRequests,
    pull_request_creation_policy: policy,
    owner: { login: owner },
  };
}

function response(status, body, headers = {}) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function configuration() {
  return {
    organizationName: ORGANIZATION,
    token: "secret-token",
  };
}

test("configuration is restricted to main in the organization governance repository", () => {
  assert.deepEqual(
    readConfiguration({
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: `${ORGANIZATION}/.github`,
      ORGANIZATION_NAME: ORGANIZATION,
      TOKEN: "secret-token",
    }),
    configuration(),
  );
  assert.throws(
    () =>
      readConfiguration({
        GITHUB_REF: "refs/pull/1/merge",
        GITHUB_REPOSITORY: `${ORGANIZATION}/.github`,
        ORGANIZATION_NAME: ORGANIZATION,
        TOKEN: "secret-token",
      }),
    /restricted to main/,
  );
});

test("only active drift is patched and the final inventory is verified", async () => {
  const active = repository("active", {
    hasPullRequests: false,
    policy: "all",
  });
  const compliant = repository("compliant", { id: 2 });
  const archived = repository("archived", {
    id: 3,
    archived: true,
    hasPullRequests: false,
    policy: "all",
  });
  const disabled = repository("disabled", {
    id: 4,
    disabled: true,
    hasPullRequests: false,
    policy: "all",
  });
  let listCallCount = 0;
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === "PATCH") {
      assert.match(String(url), /\/repos\/LCV-Ideas-Software\/active$/);
      assert.deepEqual(JSON.parse(options.body), {
        has_pull_requests: true,
        pull_request_creation_policy: "collaborators_only",
      });
      return response(200, {
        ...active,
        has_pull_requests: true,
        pull_request_creation_policy: "collaborators_only",
      });
    }
    listCallCount += 1;
    const currentActive =
      listCallCount === 1
        ? active
        : {
            ...active,
            has_pull_requests: true,
            pull_request_creation_policy: "collaborators_only",
          };
    return response(200, [currentActive, compliant, archived, disabled]);
  };

  const result = await reconcileRepositoryGovernance(configuration(), {
    fetchImpl,
  });
  assert.equal(result.activeRepositoryCount, 2);
  assert.equal(result.updatedRepositoryCount, 1);
  assert.equal(result.unchangedRepositoryCount, 1);
  assert.equal(
    requests.filter(({ options }) => options.method === "PATCH").length,
    1,
  );
  assert.ok(
    requests.every(
      ({ options }) =>
        options.headers["X-GitHub-Api-Version"] === API_VERSION &&
        options.headers.Authorization === "Bearer secret-token",
    ),
  );
});

test("an ambiguous patch is accepted only after an exact compliant read", async () => {
  const drift = repository("drift", { hasPullRequests: true, policy: "all" });
  let listCallCount = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === "PATCH") throw new TypeError("network closed");
    if (String(url).includes("/repos/LCV-Ideas-Software/drift")) {
      return response(200, {
        ...drift,
        pull_request_creation_policy: "collaborators_only",
      });
    }
    listCallCount += 1;
    return response(200, [
      listCallCount === 1
        ? drift
        : { ...drift, pull_request_creation_policy: "collaborators_only" },
    ]);
  };

  const result = await reconcileRepositoryGovernance(configuration(), {
    fetchImpl,
  });
  assert.equal(result.reconciledRepositoryCount, 1);
});

test("an ambiguous patch fails closed when the repository still drifts", async () => {
  const drift = repository("drift", { hasPullRequests: true, policy: "all" });
  const fetchImpl = async (url, options) => {
    if (options.method === "PATCH") throw new TypeError("network closed");
    if (String(url).includes("/repos/LCV-Ideas-Software/drift")) {
      return response(200, drift);
    }
    return response(200, [drift]);
  };

  await assert.rejects(
    reconcileRepositoryGovernance(configuration(), { fetchImpl }),
    /could not be reached/,
  );
});

test("owner mismatches and duplicate repository metadata fail before mutation", async () => {
  for (const payload of [
    [repository("foreign", { owner: "Other-Organization" })],
    [repository("duplicate"), repository("duplicate", { id: 999 })],
  ]) {
    let patchCount = 0;
    const fetchImpl = async (_url, options) => {
      if (options.method === "PATCH") patchCount += 1;
      return response(200, payload);
    };
    await assert.rejects(
      reconcileRepositoryGovernance(configuration(), { fetchImpl }),
      /malformed repository governance metadata|duplicate repository metadata/,
    );
    assert.equal(patchCount, 0);
  }
});

test("API failures do not expose the token", async () => {
  const fetchImpl = async () =>
    response(403, { message: "forbidden" }, { "x-github-sso": "required" });
  await assert.rejects(
    reconcileRepositoryGovernance(configuration(), { fetchImpl }),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /sso-authorization=required/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});
