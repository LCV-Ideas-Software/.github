import { describe, expect, it, vi } from "vitest";

import { normalizeGitHubEvent } from "../src/domain";
import { handleFetch, processPrimaryMessage } from "../src/index";
import {
  fakeMessage,
  FakeQueue,
  makeEnv,
  MemoryDeliveryStore,
  signedRequest,
} from "./helpers";

const DELIVERY_ID = "00000000-0000-4000-8000-000000000040";
const REPOSITORY = "LCV-Ideas-Software/cross-review";
const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const OMITTED_VALUES = [
  "PRIVATE_ISSUE_BODY",
  "PRIVATE_PR_BODY",
  "PRIVATE_COMMENT_BODY",
  "PRIVATE_REVIEW_BODY",
  "PRIVATE_COMMIT_MESSAGE",
  "author-private@example.com",
  "PRIVATE_DIFF_HUNK",
  "PRIVATE_DISCUSSION_BODY",
  "PRIVATE_DISCUSSION_COMMENT_BODY",
  "src/private/location.ts",
  "C_ATTACKER_SELECTED_CHANNEL",
];

const activityCases: Array<[string, Record<string, unknown>]> = [
  [
    "push",
    {
      after: "b".repeat(40),
      before: "a".repeat(40),
      channel_id: "C_ATTACKER_SELECTED_CHANNEL",
      commits: [
        {
          author: {
            email: "author-private@example.com",
            name: "Private Author",
          },
          message: "PRIVATE_COMMIT_MESSAGE",
        },
      ],
      compare:
        "https://github.com/LCV-Ideas-Software/cross-review/compare/a...b",
      forced: false,
      head_commit: {
        author: { email: "author-private@example.com" },
        message: "PRIVATE_COMMIT_MESSAGE",
        timestamp: "2026-08-03T12:00:00Z",
      },
      ref: "refs/heads/main",
      sender: { login: "lcv-leo" },
      size: 1,
    },
  ],
  [
    "pull_request",
    {
      action: "opened",
      number: 42,
      pull_request: {
        body: "PRIVATE_PR_BODY",
        created_at: "2026-08-03T12:00:00Z",
        head: { ref: "feature/activity" },
        html_url: "https://github.com/LCV-Ideas-Software/cross-review/pull/42",
        number: 42,
        title: "Add activity relay",
      },
      sender: { login: "lcv-leo" },
    },
  ],
  [
    "pull_request_review",
    {
      action: "submitted",
      pull_request: {
        head: { ref: "feature/activity" },
        html_url: "https://github.com/LCV-Ideas-Software/cross-review/pull/42",
        number: 42,
        title: "Add activity relay",
      },
      review: {
        body: "PRIVATE_REVIEW_BODY",
        html_url:
          "https://github.com/LCV-Ideas-Software/cross-review/pull/42#pullrequestreview-1",
        state: "approved",
        submitted_at: "2026-08-03T12:00:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    },
  ],
  [
    "pull_request_review_comment",
    {
      action: "created",
      comment: {
        body: "PRIVATE_COMMENT_BODY",
        created_at: "2026-08-03T12:00:00Z",
        diff_hunk: "PRIVATE_DIFF_HUNK",
        html_url:
          "https://github.com/LCV-Ideas-Software/cross-review/pull/42#discussion_r1",
        path: "src/private/location.ts",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
      pull_request: {
        head: { ref: "feature/activity" },
        number: 42,
        title: "Add activity relay",
      },
    },
  ],
  [
    "issues",
    {
      action: "opened",
      issue: {
        body: "PRIVATE_ISSUE_BODY",
        created_at: "2026-08-03T12:00:00Z",
        html_url: "https://github.com/LCV-Ideas-Software/cross-review/issues/7",
        number: 7,
        title: "Example issue",
      },
      sender: { login: "lcv-leo" },
    },
  ],
  [
    "issue_comment",
    {
      action: "created",
      comment: {
        body: "PRIVATE_COMMENT_BODY",
        created_at: "2026-08-03T12:00:00Z",
        html_url:
          "https://github.com/LCV-Ideas-Software/cross-review/issues/7#issuecomment-1",
        user: { login: "lcv-leo" },
      },
      issue: { number: 7, title: "Example issue" },
    },
  ],
  [
    "release",
    {
      action: "published",
      release: {
        assets: [{ name: "private-build-metadata.zip" }],
        author: { login: "lcv-leo" },
        body: "PRIVATE_ISSUE_BODY",
        html_url:
          "https://github.com/LCV-Ideas-Software/cross-review/releases/tag/v1.2.3",
        name: "Stable release",
        published_at: "2026-08-03T12:00:00Z",
        tag_name: "v1.2.3",
        target_commitish: "main",
      },
    },
  ],
  [
    "discussion",
    {
      action: "created",
      discussion: {
        body: "PRIVATE_DISCUSSION_BODY",
        created_at: "2026-08-03T12:00:00Z",
        html_url:
          "https://github.com/LCV-Ideas-Software/cross-review/discussions/9",
        number: 9,
        title: "Architecture discussion",
        user: { login: "lcv-leo" },
      },
    },
  ],
  [
    "discussion_comment",
    {
      action: "created",
      comment: {
        body: "PRIVATE_DISCUSSION_COMMENT_BODY",
        created_at: "2026-08-03T12:00:00Z",
        html_url:
          "https://github.com/LCV-Ideas-Software/cross-review/discussions/9#discussioncomment-1",
        user: { login: "lcv-leo" },
      },
      discussion: {
        number: 9,
        title: "Architecture discussion",
      },
    },
  ],
];

describe("normal activity routing", () => {
  it.each(activityCases)(
    "normalizes %s to the internal activity destination",
    (event, payload) => {
      const result = normalizeGitHubEvent(
        event,
        payload,
        DELIVERY_ID,
        REPOSITORY,
        "main",
      );

      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") return;
      expect(result.destination).toBe("activity");
      expect(result.payload.severity).toBe("info");
      expect(result.payload.delivery_id).toBe(DELIVERY_ID);
      expect(
        Object.values(result.payload).every(
          (value) => typeof value === "string",
        ),
      ).toBe(true);

      const serialized = JSON.stringify(result.payload);
      for (const omitted of OMITTED_VALUES) {
        expect(serialized).not.toContain(omitted);
      }
    },
  );

  it("routes pushes only for refs/heads/<repository.default_branch>", () => {
    const base = structuredClone(activityCases[0]?.[1] ?? {});
    const defaultBranch = normalizeGitHubEvent(
      "push",
      base,
      DELIVERY_ID,
      REPOSITORY,
      "main",
    );
    expect(defaultBranch.kind).toBe("accepted");

    const feature = { ...base, ref: "refs/heads/feature/noise" };
    expect(
      normalizeGitHubEvent("push", feature, DELIVERY_ID, REPOSITORY, "main"),
    ).toEqual({ kind: "ignored", reason: "push_not_default_branch" });

    const tag = { ...base, ref: "refs/tags/v1.2.3" };
    expect(
      normalizeGitHubEvent("push", tag, DELIVERY_ID, REPOSITORY, "main"),
    ).toEqual({
      kind: "ignored",
      reason: "push_not_default_branch",
    });
  });

  it("persists the destination selected by the normalizer", async () => {
    const queue = new FakeQueue();
    const activityQueue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    const payload = {
      ...activityCases[1]?.[1],
      organization: { login: "LCV-Ideas-Software" },
      repository: {
        archived: false,
        full_name: REPOSITORY,
        owner: { login: "LCV-Ideas-Software" },
      },
    };
    const response = await handleFetch(
      await signedRequest("pull_request", DELIVERY_ID, payload),
      makeEnv(queue, { activityQueue }),
      { store, now: () => NOW },
    );

    expect(response.status).toBe(202);
    expect(store.deliveries.get(DELIVERY_ID)?.destination).toBe("activity");
    expect(queue.sent).toHaveLength(0);
    expect(activityQueue.sent).toEqual([{ deliveryId: DELIVERY_ID }]);
  });

  it("selects a fixed Secrets Store binding from destination, never from payload data", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    const alertsUrl = "https://hooks.slack.com/triggers/T/ALERTS/TOKEN";
    const activityUrl = "https://hooks.slack.com/triggers/T/ACTIVITY/TOKEN";
    store.seed(DELIVERY_ID, "queued", NOW, { destination: "activity" });
    store.deliveries.get(DELIVERY_ID)!.payload.details =
      "C_ATTACKER_SELECTED_CHANNEL";
    const { message } = fakeMessage(DELIVERY_ID);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));

    await processPrimaryMessage(
      message,
      makeEnv(queue, {
        alertsSlackUrl: alertsUrl,
        activitySlackUrl: activityUrl,
      }),
      { store, now: () => NOW, fetch: fetchMock },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(activityUrl);
    expect(fetchMock.mock.calls[0]?.[0]).not.toBe(alertsUrl);
  });
});
