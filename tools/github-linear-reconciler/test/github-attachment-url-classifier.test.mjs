import assert from "node:assert/strict";
import test from "node:test";

import { classifyGithubAttachmentUrl } from "../src/domain/github-resource.mjs";

test("classificador distingue GitHub Issue e Pull sem perder a identidade", () => {
  assert.deepEqual(
    classifyGithubAttachmentUrl(
      "https://github.com/Example-Org/.GitHub/issues/7",
    ),
    {
      kind: "github-issue",
      resource: {
        owner: "example-org",
        repository: ".github",
        number: 7,
        key: "example-org/.github#7",
        kind: "issue",
        secure: true,
      },
    },
  );
  assert.deepEqual(
    classifyGithubAttachmentUrl(
      "https://github.com/example-org/repo/pull/9#discussion-diff-1",
    ),
    {
      kind: "github-pull",
      resource: {
        owner: "example-org",
        repository: "repo",
        number: 9,
        key: "example-org/repo#9",
        kind: "pull",
        secure: false,
      },
    },
  );
});

test("classificador preserva paginas GitHub genericas como categoria explicita", () => {
  for (const raw of [
    "https://github.com/example-org/repo",
    "https://github.com/example-org/repo/actions/runs/7",
    "https://github.com/example-org/repo/discussions/7#discussioncomment-1",
    "https://github.com/example-org/repo/issues",
    "https://github.com/example-org/repo/issues?q=is%3Aopen",
    "https://github.com/example-org/repo/pull/7/checks",
    "https://github.com/example-org/repo/pull/7/commits",
    "https://github.com/example-org/repo/pull/7/files",
    "https://github.com/example-org/repo/pulls/7",
    "https://github.com/issues",
  ]) {
    assert.deepEqual(classifyGithubAttachmentUrl(raw), {
      kind: "github-other",
    });
  }
});

test("classificador separa links externos de entradas invalidas", () => {
  for (const raw of [
    "https://linear.app/example/issue/EX-7",
    "https://gist.github.com/example/abcdef",
    "https://github.com.evil.example/example-org/repo/issues/7",
    "https://github.com@evil.example/example-org/repo/issues/7",
    "https://github.com./example-org/repo/issues/7",
    "mailto:owner@example.com",
  ]) {
    assert.deepEqual(classifyGithubAttachmentUrl(raw), {
      kind: "non-github",
    });
  }
  for (const raw of [
    null,
    undefined,
    "",
    " not-a-url",
    "https://github.com/example-org/repo/issues/7\n",
  ]) {
    assert.deepEqual(classifyGithubAttachmentUrl(raw), {
      kind: "invalid-url",
    });
  }
});

test("paths GitHub ambiguos permanecem genericos e nunca criam identidade", () => {
  for (const raw of [
    "https://github.com/example-org/repo/issues/not-a-number",
    "https://github.com/example-org/repo/issues/0",
    "https://github.com/example-org/repo/pull/9007199254740992",
    "https://github.com/example-org/repo/issues/7/files",
    "https://github.com/-example/repo/issues/7",
    "https://github.com/example-org/../issues/7",
    "https://github.com/example-org/re%70o/issues/7",
    "https://github.com/example-org/repo/%69ssues/7",
    "https://github.com/example-org/./repo/pull/7",
  ]) {
    assert.deepEqual(classifyGithubAttachmentUrl(raw), {
      kind: "github-other",
    });
  }
});

test("identidade exata preserva sinalizacao de URL insegura", () => {
  for (const raw of [
    "http://github.com/example-org/repo/issues/7",
    "ftp://github.com/example-org/repo/issues/7",
    "https://user:secret@github.com/example-org/repo/issues/7",
    "https://github.com:443/example-org/repo/issues/7",
    "https://github.com:444/example-org/repo/issues/7",
    "https://github.com/example-org/repo/issues/7?notification=1",
    "https://github.com/example-org/repo/issues/7#issuecomment-1",
    "https://%67ithub.com/example-org/repo/issues/7",
  ]) {
    const result = classifyGithubAttachmentUrl(raw);
    assert.equal(result.kind, "github-issue", raw);
    assert.equal(result.resource?.secure, false, raw);
  }
});

test("resultado do classificador e imutavel", () => {
  const generic = classifyGithubAttachmentUrl(
    "https://github.com/example-org/repo/actions",
  );
  const issue = classifyGithubAttachmentUrl(
    "https://github.com/example-org/repo/issues/7",
  );
  assert.equal(Object.isFrozen(generic), true);
  assert.equal(Object.isFrozen(issue), true);
  assert.equal(Object.isFrozen(issue.resource), true);
});
