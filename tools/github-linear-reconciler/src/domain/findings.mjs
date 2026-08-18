const STATES = Object.freeze(["clean", "advisory", "drift", "incomplete"]);
const SEVERITIES = new Set(STATES.slice(1));

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function finding(severity, code, entity, message, references = []) {
  if (!SEVERITIES.has(severity)) {
    throw new TypeError(`Unsupported finding severity: ${severity}`);
  }
  return {
    severity,
    code: String(code),
    entity: String(entity),
    message: String(message),
    references: [...new Set(references.map(String))].sort(compareText),
  };
}

export function finalizeFindings(findings) {
  const ordered = [...findings].sort((left, right) =>
    compareText(
      `${left.severity}:${left.code}:${left.entity}:${left.references.join(",")}`,
      `${right.severity}:${right.code}:${right.entity}:${right.references.join(",")}`,
    ),
  );
  const counts = { drift: 0, advisory: 0, incomplete: 0 };
  for (const item of ordered) counts[item.severity] += 1;
  const state = counts.incomplete
    ? "incomplete"
    : counts.drift
      ? "drift"
      : counts.advisory
        ? "advisory"
        : "clean";
  return { state, counts, findings: ordered };
}

export function exitCodeForResult(result) {
  if (result?.counts?.incomplete > 0 || result?.state === "incomplete")
    return 2;
  if (
    result?.counts?.drift > 0 ||
    result?.counts?.advisory > 0 ||
    result?.state === "drift" ||
    result?.state === "advisory"
  ) {
    return 1;
  }
  return 0;
}
