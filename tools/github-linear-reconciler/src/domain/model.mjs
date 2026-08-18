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
 *
 * @typedef {object} NormalizedRelease
 * @property {string} id
 * @property {string} pipelineId Stable Linear pipeline identity.
 * @property {'continuous'|'scheduled'} pipelineType
 * @property {string} commitSha Canonical lowercase opaque commit identity.
 * @property {number} completedAtMs
 *
 * @typedef {object} NormalizedLinearIssue
 * @property {string} id
 * @property {string} identifier
 * @property {string} teamKey
 * @property {NormalizedStatus} status
 * @property {string[]} nativeCounterpartKeys GitHub Issues Sync counterparts.
 * @property {string[]} attachmentIssueKeys Explicit GitHub Issue attachments.
 * @property {string[]} insecureGithubResourceKeys Noncanonical or unencrypted GitHub resources, never fetched.
 * @property {string[]} carrierPullKeys
 * @property {LinearComment[]} comments
 * @property {NormalizedRelease[]} releases
 * @property {string|null} duplicateOf
 * @property {string[]} relatedIdentifiers
 * @property {string|null} duplicateKey Precomputed exact candidate signal.
 * @property {string[]} similarityKeys Precomputed advisory-only signals.
 *
 * @typedef {object} NormalizedLinearSnapshot
 * @property {boolean} complete
 * @property {{source:string,code:string,scope:string}[]} failures
 * @property {{key:string,active:boolean}[]} teams
 * @property {NormalizedLinearIssue[]} issues
 * @property {{id:string,teamKey:string}[]} cycles
 * @property {{id:string,teamKey:string}[]} projects
 * @property {{id:string,teamKey:string}[]} initiatives
 * @property {{id:string,teamKey:string}[]} documents
 *
 * @typedef {object} GithubComment
 * @property {string} id
 * @property {string} threadId
 * @property {number} createdAtMs
 *
 * @typedef {object} NormalizedGithubIssue
 * @property {string} key Canonical lowercase owner/repository#number.
 * @property {string} repository
 * @property {number} number
 * @property {NormalizedStatus} status
 * @property {GithubComment[]} comments
 *
 * @typedef {object} NormalizedGithubPull
 * @property {string} key
 * @property {string} repository
 * @property {number} number
 * @property {number|null} mergedAtMs
 * @property {string|null} mergeCommitSha
 *
 * @typedef {object} NormalizedGithubSnapshot
 * @property {boolean} complete
 * @property {{source:string,code:string,scope:string}[]} failures
 * @property {{name:string,archived?:boolean}[]} repositories
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
