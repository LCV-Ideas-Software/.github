<!-- entire-agent:begin -->
Read .entire/agent-guide.md for this repository's workflow, source inspection, and verification guidance.
@.entire/agent-guide.md
<!-- entire-agent:end -->

## Entire and GitHub together (enterprise standard)

This section applies to agent sessions on a local workstation with the Entire
CLI installed. It does not apply to agents that run in GitHub Actions or in a
provider's cloud, such as the `@claude` workflow, Codex cloud tasks or the
Copilot coding agent: they commit through their own tools and follow their own
instructions.

Entire and GitHub run together, in parallel, at all times. GitHub remains the
source of truth and the home of the controls (signed commits, rulesets, CodeQL,
reviews); Entire captures a checkpoint when a commit is made and syncs it when
the commit is pushed. Work recorded in only one of them is incomplete.

1. Start the agent session at this repository's root, or at its worktree under
   `.worktrees/`. A session opened in a parent folder is not attributed to this
   repository.
2. Before working, run `entire status --detailed`. If the hooks are missing, run
   `entire configure --force`; do not reinstall what already works.
3. Keep the result in files of this repository. Work that changes no file here,
   such as API-only or console operations, produces no checkpoint.
4. Commit with a local, signed `git commit`; never through the GitHub API or web
   editor, and never with `--no-verify`, so that Entire's Git hooks run.
   `.entire/settings.json` sets `"commit_linking": "always"`, so commits link to
   the captured session without a prompt.
5. The hook writes the `Entire-Checkpoint` trailer when the commit is made. Never
   invent a checkpoint ID the tool did not create. A squash merge makes a new
   commit on `main` without the branch commits' trailers, and the dispatch reads
   only `main`: end the squash commit message with the `Entire-Checkpoint` lines
   the hook wrote on the pull request's commits, copied as they are, one per
   checkpoint proven in step 6 (operator decision of 02/11/2026).
6. Push with `git push`, then prove that the checkpoint reached GitHub and Entire:
   `git ls-remote origin 'refs/entire/*'` lists the ID from the commit trailer,
   and `entire checkpoint explain <id> --repo gh/<owner>/<repo> --json` answers
   when run from a clone of another repository. Inside this repository's own
   clone the command reads the local copy and answers even when Entire never
   received the checkpoint.
7. Once per pull request, after it is merged, generate a remote dispatch:
   `entire dispatch --repos gh/<owner>/<repo> --since <author time of the PR's first commit> --voice neutral`.
   Take that time from `gh pr view <number> --json commits -q '.commits[0].authoredDate'`:
   checkpoints are created at commit time, before the PR exists. The window can
   also include other work merged in the same period. Add `--jurisdiction <slug>`
   when the repository is placed outside your home jurisdiction
   (`entire auth status` shows the home one).
   Every dispatch must have a title. The CLI has no title option, so take the
   newest setup for this repository from
   `entire api --jurisdiction <slug> /api/v1/me/dispatch-setups` and run
   `entire api --jurisdiction <slug> -X PATCH /api/v1/me/dispatch-setups/<setup-id> -f "name=<repo> — PR #<number>: <PR title>"`.
   Use the same jurisdiction slug that generated the dispatch in both commands:
   each jurisdiction lists only its own setups. In Git Bash on Windows, prefix
   `entire api` with `MSYS_NO_PATHCONV=1`, or the `/api/v1/...` path is rewritten
   into a Windows path.
   Post the dispatch title and markdown as a comment on the pull request, with
   the PR's checkpoint IDs read from its commit trailers; the dispatch must cover
   them. Entire allows one generation per minute per account: after a rate-limit
   answer, wait 60 seconds and retry once. Write `<owner>/<repo>` exactly as GitHub
   spells it: a different case answers that the repository was not found.
   "No checkpoints" for this window means the squash message lacks the trailer
   lines of step 5 or step 6 failed; never create an artificial commit to fill a
   dispatch.
8. Report configuration, executed-and-proven evidence, and pending items
   separately.
