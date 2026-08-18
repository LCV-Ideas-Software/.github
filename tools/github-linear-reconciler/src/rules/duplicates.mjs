import { finding } from "../domain/findings.mjs";

function createDuplicateComponents(issues) {
  const parent = new Map(
    issues.map((issue) => [issue.identifier, issue.identifier]),
  );

  function find(identifier) {
    const current = parent.get(identifier);
    if (current === identifier) return identifier;
    const root = find(current);
    parent.set(identifier, root);
    return root;
  }

  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    parent.set(second, first);
  }

  for (const issue of issues) {
    if (issue.duplicateOf) union(issue.identifier, issue.duplicateOf);
  }
  return find;
}

function signalGroups(issues, selector) {
  const groups = new Map();
  for (const issue of issues) {
    for (const signal of selector(issue)) {
      const members = groups.get(signal) ?? [];
      members.push(issue);
      groups.set(signal, members);
    }
  }
  return [...groups.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function groupNeedsReconciliation(members, find, issueByIdentifier) {
  const roots = new Set(members.map((issue) => find(issue.identifier)));
  if (roots.size <= 1) return false;
  const memberIdentifiers = new Set(members.map((issue) => issue.identifier));
  const edges = new Set();
  for (const issue of members) {
    const leftRoot = find(issue.identifier);
    for (const related of issue.relatedIdentifiers) {
      if (!memberIdentifiers.has(related) || !issueByIdentifier.has(related))
        continue;
      const rightRoot = find(related);
      if (leftRoot === rightRoot) continue;
      edges.add([leftRoot, rightRoot].sort().join("\u0000"));
    }
  }
  return edges.size !== (roots.size * (roots.size - 1)) / 2;
}

function appendGroupedFindings({
  findings,
  groups,
  find,
  issueByIdentifier,
  code,
  message,
  emitted,
  exactGroups,
}) {
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const references = members.map((issue) => issue.identifier).toSorted();
    const groupKey = references.join("\u0000");
    if (exactGroups?.has(groupKey) || emitted.has(`${code}:${groupKey}`))
      continue;
    if (!groupNeedsReconciliation(members, find, issueByIdentifier)) continue;
    emitted.add(`${code}:${groupKey}`);
    findings.push(
      finding("advisory", code, references.join(", "), message, references),
    );
  }
}

export function evaluateDuplicates(context) {
  const issues = context.linear.issues.toSorted((left, right) =>
    left.identifier < right.identifier
      ? -1
      : left.identifier > right.identifier
        ? 1
        : 0,
  );
  const issueByIdentifier = new Map(
    issues.map((issue) => [issue.identifier, issue]),
  );
  const find = createDuplicateComponents(issues);
  const findings = [];
  const emitted = new Set();
  const exactGroups = new Set();
  const duplicateGroups = signalGroups(issues, (issue) =>
    issue.duplicateKey ? [issue.duplicateKey] : [],
  );
  for (const [, members] of duplicateGroups) {
    if (members.length > 1) {
      exactGroups.add(
        members
          .map((issue) => issue.identifier)
          .toSorted()
          .join("\u0000"),
      );
    }
  }
  appendGroupedFindings({
    findings,
    groups: duplicateGroups,
    find,
    issueByIdentifier,
    code: "duplicate_candidate",
    message: "exact duplicate fingerprint needs human confirmation",
    emitted,
  });
  appendGroupedFindings({
    findings,
    groups: signalGroups(issues, (issue) => issue.similarityKeys),
    find,
    issueByIdentifier,
    code: "similar_issue_candidate",
    message: "conservative similarity fingerprint needs human confirmation",
    emitted,
    exactGroups,
  });
  return findings;
}
