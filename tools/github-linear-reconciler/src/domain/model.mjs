/**
 * @typedef {'active'|'completed'|'canceled'} NormalizedStatus
 * @typedef {'github-backed'|'linear-only'|'umbrella'} TeamMode
 *
 * @typedef {object} TeamMapping
 * @property {string} linearTeamKey
 * @property {TeamMode} mode
 * @property {string=} repository Canonical lowercase repository for github-backed.
 * @property {string=} linearReleasePipelineId Stable Linear pipeline ID for github-backed.
 *
 * @typedef {object} ReconcilerConfig
 * @property {string} organization Canonical lowercase GitHub organization.
 * @property {number|string|Date} releaseRequiredAfter
 * @property {number} commentGraceMinutes
 * @property {TeamMapping[]} mappings
 *
 * @typedef {object} LinearComment
 * @property {string} id
 * @property {'github'|'linear'} provenance
 * @property {string|null} resourceKey Canonical lowercase owner/repository#number.
 * @property {string|null} externalId
 * @property {string|null} threadId
 * @property {boolean} connected
 * @property {number} createdAtMs Epoch milliseconds, decoded by the adapter.
 * @property {number} updatedAtMs Epoch milliseconds, bounded by capturedAtMs; any Linear-provider inversion is canonicalized to createdAtMs by the adapter.
 *
 * @typedef {object} GithubThreadControl
 * @property {string} linearCommentId Stable Linear comment identity; globally disjoint from content-comment IDs.
 * @property {boolean} connected Current external-thread connection state.
 * @property {string|null} observedResourceKey Corroborative GitHub Issue key, never an authoritative counterpart.
 * @property {'resource'|'unparseable'|'absent'} urlState Allowlisted URL observation without retaining the provider URL.
 *
 * @typedef {object} NormalizedRelease
 * @property {string} id
 * @property {string} pipelineId Stable Linear pipeline identity.
 * @property {'continuous'|'scheduled'} pipelineType
 * @property {string} commitSha Canonical lowercase opaque commit identity.
 * @property {number|null} completedAtMs Null while the release is planned.
 * @property {number} updatedAtMs Provider timestamp for the release's last meaningful update; it is not an upper bound for completedAtMs.
 * @property {string} issueToReleaseId Stable association identity.
 * @property {number} issueToReleaseUpdatedAtMs Provider timestamp for the association's last meaningful update.
 *
 * @typedef {object} NormalizedLinearIssue
 * @property {string} id
 * @property {string} identifier
 * @property {string} teamId Stable Linear team identity.
 * @property {string} teamKey
 * @property {number} updatedAtMs Epoch milliseconds, bounded by capturedAtMs.
 * @property {NormalizedStatus} status
 * @property {NativeCounterpart[]} nativeCounterparts Canonical GitHub Issues Sync identities.
 * @property {string[]} nativeCounterpartKeys Strict projection of nativeCounterparts.resourceKey for rule evaluation.
 * @property {string[]} attachmentIssueKeys Explicit GitHub Issue attachments.
 * @property {string[]} insecureGithubResourceKeys Noncanonical or unencrypted GitHub resources, never fetched.
 * @property {string[]} carrierPullKeys
 * @property {LinearComment[]} comments
 * @property {GithubThreadControl[]} githubThreadControls Provider controls excluded from content-comment reconciliation.
 * @property {NormalizedRelease[]} releases
 * @property {string|null} duplicateOf
 * @property {string[]} relatedIdentifiers
 * @property {string|null} duplicateKey Precomputed exact candidate signal.
 * @property {string[]} similarityKeys Precomputed advisory-only signals.
 *
 * @typedef {object} NativeCounterpart
 * @property {string} resourceKey Canonical lowercase owner/repository#number.
 * @property {string} externalId Opaque, case-sensitive GitHub node ID from Linear ExternalEntityInfo.id.
 *
 * @typedef {object} NormalizedReleasePipeline
 * @property {string} id Stable Linear pipeline identity.
 * @property {'continuous'|'scheduled'} type
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 *
 * @typedef {object} NormalizedWorkspaceRelease
 * @property {string} id Stable Linear release identity.
 * @property {string} pipelineId Stable Linear pipeline identity.
 * @property {string|null} commitSha Null when the release carries no Git commit evidence.
 * @property {number|null} completedAtMs Null while the release is planned.
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 *
 * @typedef {object} NormalizedIssueToRelease
 * @property {string} id Stable Linear association identity.
 * @property {string} issueId Stable Linear issue identity.
 * @property {string} releaseId Stable Linear release identity.
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 *
 * @typedef {object} NormalizedLinearSnapshot
 * @property {boolean} complete
 * @property {{source:"linear",code:"node_invalid"|"boundary_invalid"|"adapter_internal_error",scope:string,reasonCodes:string[],message:string}[]} failures Sanitized machine-readable failures; incomplete snapshots expose no normalized entities.
 * @property {number} captureStartedAtMs Common observation-window start in epoch milliseconds.
 * @property {number} capturedAtMs Source-specific observation-window end in epoch milliseconds; the paginated read is not an atomic point-in-time snapshot.
 * @property {{id:string,key:string,active:boolean,updatedAtMs:number}[]} teams
 * @property {NormalizedLinearIssue[]} issues
 * @property {{id:string,teamId:string,teamKey:string,updatedAtMs:number}[]} cycles
 * @property {{id:string,teamId:string,teamKey:string,updatedAtMs:number}[]} projects
 * @property {{id:string,teamId:string,teamKey:string,updatedAtMs:number}[]} initiatives
 * @property {{id:string,teamId:string,teamKey:string,updatedAtMs:number}[]} documents
 * @property {NormalizedReleasePipeline[]} releasePipelines
 * @property {NormalizedWorkspaceRelease[]} releases
 * @property {NormalizedIssueToRelease[]} issueToReleases
 *
 * @typedef {object} GithubComment
 * @property {string} id
 * @property {string} threadId
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 *
 * @typedef {object} NormalizedGithubIssue
 * @property {string} key Canonical lowercase owner/repository#number.
 * @property {string} nodeId Opaque, case-sensitive GitHub node ID.
 * @property {string} repository
 * @property {number} number
 * @property {NormalizedStatus} status
 * @property {number} createdAtMs Epoch milliseconds, bounded by the GitHub observation end.
 * @property {number} updatedAtMs Epoch milliseconds, bounded by capturedAtMs.
 * @property {GithubComment[]} comments
 *
 * @typedef {object} NormalizedGithubPull
 * @property {string} key
 * @property {string} repository
 * @property {number} number
 * @property {number} createdAtMs Epoch milliseconds, bounded by the GitHub observation end.
 * @property {number} updatedAtMs Epoch milliseconds, bounded by capturedAtMs.
 * @property {number|null} mergedAtMs
 * @property {string|null} mergeCommitSha
 *
 * @typedef {object} NormalizedGithubSnapshot
 * @property {boolean} complete
 * @property {{source:string,code:string,scope:string}[]} failures
 * @property {number} captureStartedAtMs Common observation-window start in epoch milliseconds.
 * @property {number} capturedAtMs Source-specific observation-window end in epoch milliseconds; the paginated read is not an atomic point-in-time snapshot.
 * @property {{id:number,name:string,archived:false,issuesEnabled:boolean,fork:boolean}[]} repositories
 * @property {NormalizedGithubIssue[]} issues
 * @property {NormalizedGithubPull[]} pulls
 */

export const NORMALIZED_STATUSES = Object.freeze([
  "active",
  "completed",
  "canceled",
]);

export const TEAM_MODES = Object.freeze([
  "github-backed",
  "linear-only",
  "umbrella",
]);
