import { finding } from "../domain/findings.mjs";

export function evaluateUmbrella(context) {
  const { linear, umbrellaTeamKey } = context;
  const findings = [];
  for (const collection of [
    "issues",
    "cycles",
    "projects",
    "initiatives",
    "documents",
  ]) {
    for (const entity of linear[collection]) {
      if (entity.teamKey !== umbrellaTeamKey) continue;
      const identity = entity.identifier ?? entity.id;
      findings.push(
        finding(
          "drift",
          "umbrella_work_item_present",
          identity,
          `umbrella contains a normalized ${collection} work item`,
          [umbrellaTeamKey, collection],
        ),
      );
    }
  }
  return findings;
}
