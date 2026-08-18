import { validateConfig } from "./domain/config.mjs";
import {
  exitCodeForResult,
  finalizeFindings,
  finding,
} from "./domain/findings.mjs";
import { validateSnapshots } from "./domain/validate-snapshot.mjs";
import { evaluateAttachments } from "./rules/attachments.mjs";
import { evaluateComments } from "./rules/comments.mjs";
import { evaluateCounterparts } from "./rules/counterparts.mjs";
import { evaluateDuplicates } from "./rules/duplicates.mjs";
import { evaluateReleases } from "./rules/releases.mjs";
import { evaluateStatus } from "./rules/status.mjs";
import { evaluateUmbrella } from "./rules/umbrella.mjs";

const RULES = Object.freeze([
  evaluateCounterparts,
  evaluateUmbrella,
  evaluateStatus,
  evaluateAttachments,
  evaluateComments,
  evaluateReleases,
  evaluateDuplicates,
]);

export function evaluate({ config, linear, github, now = new Date() }) {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) {
    return finalizeFindings([
      finding(
        "incomplete",
        "evaluation_time_invalid",
        "evaluation",
        "now must be a valid Date",
      ),
    ]);
  }
  const validatedConfig = validateConfig(config);
  if (validatedConfig.findings.length > 0) {
    return finalizeFindings(validatedConfig.findings);
  }
  const snapshotFindings = validateSnapshots(
    linear,
    github,
    validatedConfig.organization,
    nowMs,
  );
  if (snapshotFindings.length > 0) return finalizeFindings(snapshotFindings);

  const context = {
    config,
    linear,
    github,
    nowMs,
    mappingByTeam: validatedConfig.mappingByTeam,
    mappingByRepository: validatedConfig.mappingByRepository,
    umbrellaTeamKey: validatedConfig.umbrellaTeamKey,
    releaseRequiredAfterMs: validatedConfig.releaseRequiredAfterMs,
    commentGraceMs: validatedConfig.commentGraceMs,
    githubIssueByKey: new Map(github.issues.map((issue) => [issue.key, issue])),
    githubPullByKey: new Map(github.pulls.map((pull) => [pull.key, pull])),
  };
  return finalizeFindings(RULES.flatMap((rule) => rule(context)));
}

export function determineExitCode(result) {
  return exitCodeForResult(result);
}
