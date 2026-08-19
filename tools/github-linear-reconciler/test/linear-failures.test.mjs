import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import {
  LINEAR_BOUNDARY_REASON_CODES,
  LINEAR_NODE_NORMALIZATION_REASON_CODES,
  LinearBoundaryError,
  LinearNodeNormalizationError,
  linearAdapterInternalFailure,
  linearBoundaryError,
  linearBoundaryFailure,
  linearFailureReferences,
  linearNodeFailure,
  linearNodeNormalizationError,
  linearNodeReasonCodes,
  validLinearFailure,
} from "../src/domain/linear-failures.mjs";

test("reason codes Linear sao allowlisted, unicos e estaveis", () => {
  for (const codes of [
    LINEAR_NODE_NORMALIZATION_REASON_CODES,
    LINEAR_BOUNDARY_REASON_CODES,
  ]) {
    assert.equal(Object.isFrozen(codes), true);
    assert.deepEqual(codes, [...new Set(codes)].sort());
  }
  assert.throws(
    () => linearNodeNormalizationError("raw-provider-message"),
    TypeError,
  );
  assert.throws(
    () => linearBoundaryError("workspace", "raw-provider-message"),
    TypeError,
  );
});

test("falha de node deduplica reasons e nunca serializa a causa bruta", () => {
  const error = linearNodeNormalizationError(
    "timestamp_invalid",
    "schema_invalid",
    "timestamp_invalid",
  );
  assert.equal(error instanceof LinearNodeNormalizationError, true);
  assert.deepEqual(error.reasonCodes, ["schema_invalid", "timestamp_invalid"]);

  const failure = linearNodeFailure("issues[3].comments[8]", error);
  assert.deepEqual(failure, {
    source: "linear",
    code: "node_invalid",
    scope: "issues[3].comments[8]",
    reasonCodes: ["schema_invalid", "timestamp_invalid"],
    message: "linear node normalization failed",
  });
  assert.equal(JSON.stringify(failure).includes("raw-provider-message"), false);
  assert.equal(Object.isFrozen(failure), true);
  assert.equal(Object.isFrozen(failure.reasonCodes), true);
});

test("somente erro tipado ou Zod e acumulavel como node", () => {
  const zodError = z
    .object({ id: z.string().min(1) })
    .safeParse({ id: "" }).error;
  assert.deepEqual(linearNodeReasonCodes(zodError), ["schema_invalid"]);
  assert.equal(linearNodeReasonCodes(new Error("provider secret")), null);
  assert.equal(linearNodeFailure("issues[0]", new Error("bug")), null);
});

test("falha estrutural preserva somente scope ordinal e reason allowlisted", () => {
  const rawCause = new Error("token=super-secret");
  const error = linearBoundaryError(
    "issues[2].attachments",
    "connection_read_failed",
    rawCause,
  );
  assert.equal(error instanceof LinearBoundaryError, true);
  assert.equal(error.cause, rawCause);
  const failure = linearBoundaryFailure(error);
  assert.deepEqual(failure, {
    source: "linear",
    code: "boundary_invalid",
    scope: "issues[2].attachments",
    reasonCodes: ["connection_read_failed"],
    message: "linear boundary failed",
  });
  assert.equal(JSON.stringify(failure).includes("super-secret"), false);
  assert.throws(
    () => linearBoundaryError("issues/LINEAR-SECRET", "connection_read_failed"),
    TypeError,
  );
});

test("erro interno do adapter e fixo, vazio e sanitizado", () => {
  assert.deepEqual(linearAdapterInternalFailure(), {
    source: "linear",
    code: "adapter_internal_error",
    scope: "workspace",
    reasonCodes: [],
    message: "linear adapter internal error",
  });
});

test("validador e referencias recusam codigo ou mensagem fora do contrato", () => {
  const failure = linearNodeFailure(
    "issues[0].attachments[2]",
    linearNodeNormalizationError("schema_invalid"),
  );
  assert.equal(validLinearFailure(failure), true);
  assert.deepEqual(linearFailureReferences(failure), [
    "linear:node_invalid:issues[0].attachments[2]:schema_invalid",
  ]);
  assert.equal(
    validLinearFailure({ ...failure, message: "remote payload: secret" }),
    false,
  );
  assert.deepEqual(
    linearFailureReferences({
      ...failure,
      reasonCodes: ["remote payload: secret"],
    }),
    [],
  );
});
