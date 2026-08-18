/**
 * Finds directed cycles in the functional graph formed by issue.duplicateOf.
 * Each issue is visited at most once after its walk is resolved, so the
 * traversal is O(n) in both time and space.
 *
 * @param {{identifier:string, duplicateOf:string|null}[]} issues
 * @returns {string[][]} Cycle members in traversal order; incoming tails are omitted.
 */
export function findDuplicateOfCycles(issues) {
  const targetByIdentifier = new Map(
    issues.map((issue) => [issue.identifier, issue.duplicateOf]),
  );
  const resolved = new Set();
  const cycles = [];

  for (const identifier of targetByIdentifier.keys()) {
    if (resolved.has(identifier)) continue;

    const path = [];
    const pathIndex = new Map();
    let current = identifier;

    while (
      targetByIdentifier.has(current) &&
      !resolved.has(current) &&
      !pathIndex.has(current)
    ) {
      pathIndex.set(current, path.length);
      path.push(current);
      const next = targetByIdentifier.get(current);
      if (next === null || !targetByIdentifier.has(next)) {
        current = null;
        break;
      }
      current = next;
    }

    if (current !== null && pathIndex.has(current)) {
      cycles.push(path.slice(pathIndex.get(current)));
    }
    for (const member of path) resolved.add(member);
  }

  return cycles;
}
