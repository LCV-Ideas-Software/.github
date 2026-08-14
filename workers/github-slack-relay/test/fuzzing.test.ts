import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { handleFetch } from "../src/index";
import { SUPPORTED_RELAY_EVENTS } from "../src/domain";
import {
  FakeQueue,
  makeEnv,
  MemoryDeliveryStore,
  signedRequest,
  TEST_WEBHOOK_SECRET,
} from "./helpers";

const TARGET_REPOSITORY = "LCV-Ideas-Software/cross-review";
const PRIVATE_SENTINEL = "PRIVATE_WEBHOOK_FIELD_MUST_NOT_BE_RELAYED";
const SUPPORTED_EVENTS = [...SUPPORTED_RELAY_EVENTS];

async function signatureFor(body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TEST_WEBHOOK_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "HMAC" }, key, body),
  );
  return `sha256=${[...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("property-based GitHub webhook security", () => {
  it("rejects every body mutation before persistence or enqueue", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 4_096 }),
        fc.integer({ min: 0, max: 255 }),
        fc.uuid(),
        async (originalBody, appendedByte, deliveryId) => {
          const tamperedBody = new Uint8Array(originalBody.byteLength + 1);
          tamperedBody.set(originalBody);
          tamperedBody[tamperedBody.length - 1] = appendedByte;
          const tampered = new Request("https://relay.example/github/webhook", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-GitHub-Delivery": deliveryId,
              "X-GitHub-Event": "workflow_run",
              "X-Hub-Signature-256": await signatureFor(originalBody),
            },
            body: tamperedBody.buffer,
          });
          const queue = new FakeQueue();
          const store = new MemoryDeliveryStore();

          const response = await handleFetch(tampered, makeEnv(queue), {
            store,
          });

          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({ error: "invalid_signature" });
          expect(store.deliveries.size).toBe(0);
          expect(queue.sent).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("handles arbitrary signed JSON without an exception or fail-open delivery", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SUPPORTED_EVENTS),
        fc.uuid(),
        fc.jsonValue(),
        async (event, deliveryId, payload) => {
          const queue = new FakeQueue();
          const store = new MemoryDeliveryStore();
          const response = await handleFetch(
            await signedRequest(event, deliveryId, payload),
            makeEnv(queue),
            { store },
          );

          expect(response.status).toBeLessThan(500);
          const result = (await response.json()) as Record<string, unknown>;
          if (result.accepted === true && result.queued === true) {
            expect(store.deliveries.size).toBe(1);
            expect(queue.sent).toEqual([{ deliveryId }]);
          } else {
            expect(store.deliveries.size).toBe(0);
            expect(queue.sent).toHaveLength(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // 200 full handleFetch property runs sat at ~5.0s once the ADR-001
  // presence fence added one async outbox lookup per request; the default
  // 5s budget flakes under load while the property itself passes.
  it("bounds and sanitizes every attacker-controlled workflow field", { timeout: 20_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.record({
          actor: fc.string({ maxLength: 600, unit: "binary" }),
          branch: fc.string({ maxLength: 800, unit: "binary" }),
          occurredAt: fc.string({ maxLength: 200, unit: "binary" }),
          url: fc.string({ maxLength: 3_000, unit: "binary" }),
          workflow: fc.string({ maxLength: 1_000, unit: "binary" }),
        }),
        async (deliveryId, generated) => {
          const queue = new FakeQueue();
          const store = new MemoryDeliveryStore();
          const payload = {
            action: "completed",
            organization: { login: "LCV-Ideas-Software" },
            private_field: PRIVATE_SENTINEL,
            repository: {
              archived: false,
              default_branch: "main",
              full_name: TARGET_REPOSITORY,
              owner: { login: "LCV-Ideas-Software" },
            },
            sender: { login: generated.actor },
            workflow_run: {
              actor: { login: generated.actor },
              conclusion: "failure",
              head_branch: generated.branch,
              html_url: generated.url,
              name: generated.workflow,
              private_field: PRIVATE_SENTINEL,
              updated_at: generated.occurredAt,
            },
          };

          const response = await handleFetch(
            await signedRequest("workflow_run", deliveryId, payload),
            makeEnv(queue),
            { store },
          );

          expect(response.status).toBe(202);
          expect(queue.sent).toEqual([{ deliveryId }]);
          const stored = store.deliveries.get(deliveryId);
          expect(stored).toBeDefined();
          if (stored === undefined) return;

          const outbound = stored.payload;
          expect(
            Object.values(outbound).every((value) => typeof value === "string"),
          ).toBe(true);
          expect(outbound.source.length).toBeLessThanOrEqual(50);
          expect(outbound.severity.length).toBeLessThanOrEqual(20);
          expect(outbound.repository.length).toBeLessThanOrEqual(200);
          expect(outbound.title.length).toBeLessThanOrEqual(300);
          expect(outbound.details.length).toBeLessThanOrEqual(1_500);
          expect(outbound.actor.length).toBeLessThanOrEqual(100);
          expect(outbound.branch.length).toBeLessThanOrEqual(255);
          expect(outbound.url.length).toBeLessThanOrEqual(2_048);
          expect(outbound.delivery_id.length).toBeLessThanOrEqual(128);
          expect(outbound.event.length).toBeLessThanOrEqual(64);
          expect(outbound.action.length).toBeLessThanOrEqual(64);
          expect(outbound.url).toMatch(/^https:\/\/github\.com(?:\/|$)/u);
          expect(JSON.stringify(outbound)).not.toContain(PRIVATE_SENTINEL);

          for (const value of Object.values(outbound)) {
            expect(value).not.toMatch(/[\u0000-\u001f\u007f-\u009f<>]/u);
            expect(value.isWellFormed()).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
