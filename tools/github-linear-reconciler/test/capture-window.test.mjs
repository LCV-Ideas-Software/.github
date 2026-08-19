import assert from "node:assert/strict";
import test from "node:test";

import { createCaptureWindow } from "../src/domain/capture-window.mjs";

const STARTED_AT = "2030-01-02T04:00:00.000Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);

test("janela fixa mantém início e fim idênticos", () => {
  const window = createCaptureWindow({ startedAt: STARTED_AT });

  assert.equal(window.captureStartedAtMs, STARTED_AT_MS);
  assert.equal(window.currentCeilingMs(), STARTED_AT_MS);
  assert.equal(window.closeMs(), STARTED_AT_MS);
});

test("janela live avança monotonicamente e fecha no último tick local", () => {
  let clockMs = STARTED_AT_MS + 1;
  const window = createCaptureWindow({
    startedAt: STARTED_AT,
    clock: () => clockMs,
  });

  assert.equal(window.currentCeilingMs(), STARTED_AT_MS + 1);
  clockMs += 1;
  assert.equal(window.closeMs(), STARTED_AT_MS + 2);
  assert.equal(window.currentCeilingMs(), STARTED_AT_MS + 2);
});

test("janela live falha fechada para relógio inválido ou regressivo", () => {
  let clockValue = STARTED_AT_MS + 1;
  const window = createCaptureWindow({
    startedAt: STARTED_AT,
    clock: () => clockValue,
  });
  assert.equal(window.currentCeilingMs(), STARTED_AT_MS + 1);

  clockValue = STARTED_AT_MS;
  assert.throws(() => window.currentCeilingMs(), /relógio.*regressivo/iu);

  const invalid = createCaptureWindow({
    startedAt: STARTED_AT,
    clock: () => Number.NaN,
  });
  assert.throws(() => invalid.currentCeilingMs(), /relógio.*inválido/iu);
});
