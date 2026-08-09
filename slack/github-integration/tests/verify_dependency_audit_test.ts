import {
  readVerificationConfiguration,
  verifyAuditOutput,
  verifyEsbuildReachability,
  verifyExceptionWindow,
  verifyLatestHookRelease,
  verifyLocalPins,
} from "../scripts/verify_dependency_audit.ts";

function assertThrows(action: () => void, expected: string): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expected)) return;
    throw new Error(
      `Expected error containing "${expected}", received "${message}"`,
    );
  }
  throw new Error(`Expected action to throw "${expected}"`);
}

const KNOWN_AUDIT = `
╭ esbuild enables any website to send any requests to the development server and read the response
│ Severity:   moderate
│ Package:    esbuild
│ Vulnerable: <=0.24.2
╰ Info:       https://github.com/advisories/GHSA-67mh-4wv8-2f99

Found 1 vulnerabilities
Severity: 0 low, 1 moderate, 0 high, 0 critical
`;

const HOOKS = JSON.stringify({
  hooks: {
    "get-hooks":
      "deno run -q --allow-read --allow-net https://deno.land/x/deno_slack_hooks@1.5.0/mod.ts",
  },
});

Deno.test("documents candidate and trusted audit invocations", async () => {
  const readme = await Deno.readTextFile(
    new URL("../README.md", import.meta.url),
  );
  for (
    const required of [
      "env -u GITHUB_TOKEN GITHUB_EVENT_NAME=merge_group deno task --frozen audit",
      "GITHUB_EVENT_NAME=workflow_dispatch deno task --frozen audit",
    ]
  ) {
    if (!readme.includes(required)) {
      throw new Error(
        `README is missing the exact audit invocation: ${required}`,
      );
    }
  }
});

const LOCK = JSON.stringify({
  specifiers: { "npm:esbuild@0.24.2": "0.24.2" },
  npm: {
    "esbuild@0.24.2": {
      integrity:
        "sha512-+9egpBW8I3CD5XPe0n6BfT5fxLzxrlDzqydF3aviG+9ni1lDC/OvMHcxqEFV0+LANZG5R1bFMWfUrjVsdwxJvA==",
    },
  },
  remote: {
    "https://deno.land/x/deno_slack_hooks@1.5.0/bundler/esbuild_bundler.ts":
      "3d1dc26a0bacc50e31bdb5b90afa3e4229d07405e042f783aebd1235da5c761a",
  },
});

Deno.test("keeps candidate events tokenless and trusted events live", () => {
  for (const eventName of ["pull_request", "merge_group"]) {
    const configuration = readVerificationConfiguration({
      GITHUB_EVENT_NAME: eventName,
      GITHUB_TOKEN: "",
    });
    if (configuration.verifyUpstreamLive) {
      throw new Error(`${eventName} unexpectedly enabled live verification`);
    }
    assertThrows(
      () =>
        readVerificationConfiguration({
          GITHUB_EVENT_NAME: eventName,
          GITHUB_TOKEN: "candidate-must-not-receive-this-token",
        }),
      "must not receive GITHUB_TOKEN",
    );
  }

  for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
    const configuration = readVerificationConfiguration({
      GITHUB_EVENT_NAME: eventName,
      GITHUB_TOKEN: "trusted-job-token",
    });
    if (!configuration.verifyUpstreamLive) {
      throw new Error(`${eventName} unexpectedly skipped live verification`);
    }
    assertThrows(
      () =>
        readVerificationConfiguration({
          GITHUB_EVENT_NAME: eventName,
          GITHUB_TOKEN: "",
        }),
      "requires GITHUB_TOKEN",
    );
  }

  assertThrows(
    () => readVerificationConfiguration({ GITHUB_TOKEN: "" }),
    "GITHUB_EVENT_NAME",
  );
});

Deno.test("accepts only the reviewed audit finding", () => {
  verifyAuditOutput(KNOWN_AUDIT, 1);
});

Deno.test("rejects any additional low-or-higher advisory", () => {
  const unexpected = KNOWN_AUDIT.replace(
    "Found 1 vulnerabilities\nSeverity: 0 low, 1 moderate, 0 high, 0 critical",
    `╭ unexpected low-severity advisory
│ Severity:   low
│ Package:    example
│ Vulnerable: <1.0.1
╰ Info:       https://github.com/advisories/GHSA-aaaa-bbbb-cccc

Found 2 vulnerabilities
Severity: 1 low, 1 moderate, 0 high, 0 critical`,
  );
  assertThrows(() => verifyAuditOutput(unexpected, 1), "exactly one");
});

Deno.test("rejects a changed advisory identity", () => {
  const unexpected = KNOWN_AUDIT.replace(
    "GHSA-67mh-4wv8-2f99",
    "GHSA-aaaa-bbbb-cccc",
  );
  assertThrows(() => verifyAuditOutput(unexpected, 1), "unexpected advisory");
});

Deno.test("rejects an allowed advisory URL embedded under another host", () => {
  const unexpected = KNOWN_AUDIT.replace(
    "https://github.com/advisories/GHSA-67mh-4wv8-2f99",
    "https://attacker.invalid/?next=https://github.com/advisories/GHSA-67mh-4wv8-2f99",
  );
  assertThrows(() => verifyAuditOutput(unexpected, 1), "unexpected advisory");
});

Deno.test("validates exact local hook and lockfile pins", () => {
  verifyLocalPins(HOOKS, LOCK);
  assertThrows(
    () => verifyLocalPins(HOOKS.replace("@1.5.0", "@1.5.1"), LOCK),
    "must remain pinned",
  );
});

Deno.test("allows only build and stop in the reviewed hook", () => {
  verifyEsbuildReachability(`
    import * as esbuild from "npm:esbuild@0.24.2";
    await esbuild.build({ write: false });
    esbuild.stop();
  `);
  assertThrows(
    () =>
      verifyEsbuildReachability(`
        import * as esbuild from "npm:esbuild@0.24.2";
        const context = await esbuild.context({});
        await context.serve();
        esbuild.stop();
      `),
    "call set changed",
  );
});

Deno.test("expires the temporary exception on its review deadline", () => {
  verifyExceptionWindow(Date.parse("2026-10-31T23:59:59Z"));
  assertThrows(
    () => verifyExceptionWindow(Date.parse("2026-11-01T00:00:00Z")),
    "expired",
  );
});

Deno.test("accepts only the reviewed latest stable hook release", () => {
  verifyLatestHookRelease({
    tag_name: "1.5.0",
    draft: false,
    prerelease: false,
  });
  assertThrows(
    () =>
      verifyLatestHookRelease({
        tag_name: "1.5.1",
        draft: false,
        prerelease: false,
      }),
    "1.5.1 is the latest stable release",
  );
  assertThrows(
    () =>
      verifyLatestHookRelease({
        tag_name: "1.5.0",
        draft: true,
        prerelease: false,
      }),
    "draft or prerelease",
  );
  assertThrows(
    () =>
      verifyLatestHookRelease({
        tag_name: "1.5.0",
        draft: false,
        prerelease: true,
      }),
    "draft or prerelease",
  );
  assertThrows(
    () => verifyLatestHookRelease(null),
    "no latest deno_slack_hooks release",
  );
});
