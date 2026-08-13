# Zizmor policy baseline

`policy-baselines.v1.json` is the immutable suppression boundary used by the
reusable Zizmor workflow. It does not declare that a finding is harmless by
rule name alone. Each authorization is bound to an organization repository,
canonical path, regular-file mode and exact Git blob SHA.

Before Zizmor runs, the reusable workflow validates both the event's trusted
base snapshot and the candidate snapshot. It rejects:

- a missing, renamed or alternative Zizmor configuration;
- an unreviewed config or inline-ignore blob;
- a symlink, executable or other unexpected Git mode;
- a case-colliding or noncanonical path; and
- a Zizmor ignore in any audited workflow or action not explicitly listed as
  `inline-ignore`.

The candidate repository supplies no policy inputs. The manifest and validator
are checked out from `job.workflow_repository` at `job.workflow_sha`, so they
are versioned with the reusable workflow release.

## Updating an authorized blob

1. Review the changed consumer file and the suppressed rule in its complete
   security context.
2. Add the new lowercase 40-character Git blob SHA to that exact manifest
   entry. During a two-phase rollout, retain the old SHA until every relevant
   base and candidate snapshot has crossed the release boundary.
3. Run the validator mutation suite, the complete required-context policy
   suite and a real Zizmor 1.29 audit of the consumer snapshot.
4. Merge through the native queue and publish a new signed, immutable
   `zizmor/vX.Y.Z` component release.
5. Move consumers one repository at a time. Remove obsolete blob SHAs in a
   later component release after no supported base snapshot needs them.

Never add a wildcard, repository-provided input, mutable ref, path-only
authorization or rule-wide suppression to this manifest.
