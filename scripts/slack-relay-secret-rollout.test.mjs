import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { provisionCloudflareNextSecret } from "./provision-cloudflare-relay-secret.mjs";
import { provisionSlackNextSecret } from "./provision-slack-relay-secret.mjs";

const SECRET = "rollout-test-only-new-relay-signing-secret";
const FINGERPRINT = createHash("sha256").update(SECRET, "utf8").digest("hex");
const STORE_ID = "f".repeat(32);
const CURRENT_ID = "c".repeat(32);
const NEXT_ID = "d".repeat(32);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cloudflareSecret({ id, name, comment = "", status = "active" }) {
  return {
    id,
    name,
    status,
    store_id: STORE_ID,
    scopes: ["workers"],
    comment,
  };
}

const cloudflareEnvironment = Object.freeze({
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_API_TOKEN: "cloudflare-test-token-never-log",
  SLACK_RELAY_SECRET_STORE_ID: STORE_ID,
  SLACK_RELAY_CURRENT_SECRET_ID: CURRENT_ID,
  SLACK_RELAY_SIGNING_SECRET: SECRET,
});

test("Cloudflare inventory paginates, stages NEXT by body, and verifies metadata", async () => {
  const calls = [];
  let created = false;
  const result = await provisionCloudflareNextSecret({
    environment: cloudflareEnvironment,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const parsed = new URL(String(url));
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        assert.equal(body[0].value, SECRET);
        assert.equal(body[0].name, "github-slack-relay-signing-secret-next");
        created = true;
        return json({
          success: true,
          result: [
            cloudflareSecret({
              id: NEXT_ID,
              name: "github-slack-relay-signing-secret-next",
              comment: `sha256:${FINGERPRINT}`,
            }),
          ],
        });
      }
      if (init.method === "PATCH") {
        return json({
          success: true,
          result: cloudflareSecret({
            id: NEXT_ID,
            name: "github-slack-relay-signing-secret-next",
            comment: `sha256:${FINGERPRINT}`,
          }),
        });
      }
      const page = Number(parsed.searchParams.get("page"));
      if (page === 1) {
        return json({
          success: true,
          result: Array.from({ length: 100 }, (_, index) =>
            cloudflareSecret({
              id: index === 0 ? CURRENT_ID : String(index).padStart(32, "0"),
              name:
                index === 0
                  ? "github-slack-relay-signing-secret"
                  : `unrelated-${index}`,
            }),
          ),
          result_info: { page: 1, per_page: 100, count: 100, total_count: 101 },
        });
      }
      return json({
        success: true,
        result: created
          ? [
              cloudflareSecret({
                id: NEXT_ID,
                name: "github-slack-relay-signing-secret-next",
                comment: `sha256:${FINGERPRINT}`,
              }),
            ]
          : [cloudflareSecret({ id: "e".repeat(32), name: "last-unrelated" })],
        result_info: { page: 2, per_page: 100, count: 1, total_count: 101 },
      });
    },
    sleep: async () => {},
  });

  assert.deepEqual(result, {
    status: "staged",
    secretName: "github-slack-relay-signing-secret-next",
  });
  assert.ok(
    calls.some(({ url }) => new URL(url).searchParams.get("page") === "2"),
  );
  for (const { url, init } of calls) {
    assert.doesNotMatch(url, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(init.headers ?? {}), new RegExp(SECRET));
  }
});

test("Cloudflare response loss converges only through the exact fingerprint", async () => {
  let staged = false;
  let posts = 0;
  const result = await provisionCloudflareNextSecret({
    environment: cloudflareEnvironment,
    fetchImpl: async (_url, init = {}) => {
      if (init.method === "POST") {
        posts += 1;
        staged = true;
        throw new Error("simulated_response_loss");
      }
      if (init.method === "PATCH") {
        return json({
          success: true,
          result: cloudflareSecret({
            id: NEXT_ID,
            name: "github-slack-relay-signing-secret-next",
            comment: `sha256:${FINGERPRINT}`,
          }),
        });
      }
      return json({
        success: true,
        result: [
          cloudflareSecret({
            id: CURRENT_ID,
            name: "github-slack-relay-signing-secret",
          }),
          ...(staged
            ? [
                cloudflareSecret({
                  id: NEXT_ID,
                  name: "github-slack-relay-signing-secret-next",
                  comment: `sha256:${FINGERPRINT}`,
                }),
              ]
            : []),
        ],
        result_info: {
          page: 1,
          per_page: 100,
          count: staged ? 2 : 1,
          total_count: staged ? 2 : 1,
        },
      });
    },
    sleep: async () => {},
  });
  assert.equal(posts, 1);
  assert.equal(result.status, "staged");
});

test("Cloudflare rewrites an existing NEXT even when its metadata fingerprint matches", async () => {
  let patched = false;
  const result = await provisionCloudflareNextSecret({
    environment: cloudflareEnvironment,
    fetchImpl: async (url, init = {}) => {
      if (init.method === "PATCH") {
        assert.match(String(url), new RegExp(`/${NEXT_ID}$`));
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body, {
          value: SECRET,
          scopes: ["workers"],
          comment: `sha256:${FINGERPRINT}`,
        });
        patched = true;
        return json({
          success: true,
          result: cloudflareSecret({
            id: NEXT_ID,
            name: "github-slack-relay-signing-secret-next",
            comment: `sha256:${FINGERPRINT}`,
          }),
        });
      }
      return json({
        success: true,
        result: [
          cloudflareSecret({
            id: CURRENT_ID,
            name: "github-slack-relay-signing-secret",
          }),
          cloudflareSecret({
            id: NEXT_ID,
            name: "github-slack-relay-signing-secret-next",
            comment: `sha256:${FINGERPRINT}`,
          }),
        ],
        result_info: { page: 1, per_page: 100, count: 2, total_count: 2 },
      });
    },
    sleep: async () => {},
  });
  assert.equal(patched, true);
  assert.equal(result.status, "restaged");
});

test("Cloudflare waits for a successful pending rewrite to become active without rewriting it", async () => {
  let patched = 0;
  let readsAfterPatch = 0;
  const result = await provisionCloudflareNextSecret({
    environment: cloudflareEnvironment,
    fetchImpl: async (_url, init = {}) => {
      if (init.method === "PATCH") {
        patched += 1;
        return json({
          success: true,
          result: cloudflareSecret({
            id: NEXT_ID,
            name: "github-slack-relay-signing-secret-next",
            comment: `sha256:${FINGERPRINT}`,
            status: "pending",
          }),
        });
      }
      if (patched > 0) readsAfterPatch += 1;
      const status = patched > 0 && readsAfterPatch < 2 ? "pending" : "active";
      return json({
        success: true,
        result: [
          cloudflareSecret({
            id: CURRENT_ID,
            name: "github-slack-relay-signing-secret",
          }),
          cloudflareSecret({
            id: NEXT_ID,
            name: "github-slack-relay-signing-secret-next",
            comment: `sha256:${FINGERPRINT}`,
            status,
          }),
        ],
        result_info: { page: 1, per_page: 100, count: 2, total_count: 2 },
      });
    },
    sleep: async () => {},
  });
  assert.equal(patched, 1);
  assert.equal(result.status, "restaged");
});

test("Cloudflare fails boundedly when a successful rewrite remains pending", async () => {
  let patched = 0;
  let reads = 0;
  await assert.rejects(
    provisionCloudflareNextSecret({
      environment: cloudflareEnvironment,
      fetchImpl: async (_url, init = {}) => {
        if (init.method === "PATCH") {
          patched += 1;
          return json({
            success: true,
            result: cloudflareSecret({
              id: NEXT_ID,
              name: "github-slack-relay-signing-secret-next",
              comment: `sha256:${FINGERPRINT}`,
              status: "pending",
            }),
          });
        }
        reads += 1;
        return json({
          success: true,
          result: [
            cloudflareSecret({
              id: CURRENT_ID,
              name: "github-slack-relay-signing-secret",
            }),
            cloudflareSecret({
              id: NEXT_ID,
              name: "github-slack-relay-signing-secret-next",
              comment: `sha256:${FINGERPRINT}`,
              status: reads === 1 ? "active" : "pending",
            }),
          ],
          result_info: { page: 1, per_page: 100, count: 2, total_count: 2 },
        });
      },
      sleep: async () => {},
    }),
    /did not become active/,
  );
  assert.equal(patched, 1);
});

test("Slack staging never places the secret in argv, URL, headers, or output", async () => {
  const calls = [];
  let staged = false;
  const result = await provisionSlackNextSecret({
    environment: {
      SLACK_APP_ID: "A12345678",
      SLACK_RELAY_SIGNING_SECRET: SECRET,
      SLACK_SERVICE_TOKEN: "slack-test-token-never-log",
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const method = String(url).split("/").at(-1);
      if (method === "apps.hosted.variables.add") {
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body, {
          app_id: "A12345678",
          variables: [
            { name: "SLACK_RELAY_SIGNING_SECRET_NEXT", value: SECRET },
          ],
        });
        staged = true;
        return json({ ok: true });
      }
      return json({
        ok: true,
        variable_names: [
          "SLACK_RELAY_SIGNING_SECRET",
          ...(staged ? ["SLACK_RELAY_SIGNING_SECRET_NEXT"] : []),
        ],
      });
    },
  });
  assert.deepEqual(result, {
    status: "staged",
    variableName: "SLACK_RELAY_SIGNING_SECRET_NEXT",
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  for (const { url, init } of calls) {
    assert.doesNotMatch(url, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(init.headers), new RegExp(SECRET));
  }
});
