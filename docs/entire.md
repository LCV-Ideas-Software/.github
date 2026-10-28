# Entire in `.github`

Verified configuration: 27 October 2026. Tracking: [LCV-477](https://linear.app/lcv-ideas-software/issue/LCV-477).

## Agent integration

Entire CLI 0.12.2, Brain 0.3.0 and Graph 0.6.0 were verified locally. Native Codex and Git hooks are installed for session and checkpoint capture; execution evidence is distinguished below. The read-only MCP server is configured in `.codex/config.toml` as `entire mcp`; MCP retrieval does not replace capture. Start a new Codex session inside this repository or its linked worktree, not the parent workspace.

The official setup manages `.entire/agent-guide.md` and delimited blocks in AGENTS.md/CLAUDE.md. Operator instructions take precedence, including avoiding redundant queries, tests and analysis. Existing repository instructions and hooks are preserved. GitHub Actions remains the independent CI system; Depot is not adopted.

## Local data and hosted memory

Keep generated indexes, state and caches in this repository's `temp/entire/`. The plugin executables are installed globally. Use the official environment overrides before Brain/Graph commands:

```powershell
$entireTaskRoot = Join-Path (Get-Location).Path 'temp/entire'
$env:ENTIRE_PLUGIN_DIR = Join-Path $entireTaskRoot 'plugins'
$env:ENTIRE_PLUGIN_CONFIG_DIR = Join-Path $entireTaskRoot 'config'
$env:ENTIRE_PLUGIN_STATE_DIR = Join-Path $entireTaskRoot 'state'
$env:ENTIRE_PLUGIN_CACHE_DIR = Join-Path $entireTaskRoot 'cache'
$env:TEMP = Join-Path (Get-Location).Path 'temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:PATH = (Join-Path $env:LOCALAPPDATA 'entire/plugins/bin') + [IO.Path]::PathSeparator + $env:PATH
entire brain setup --no-backfill --no-daemon --no-agent-hooks --agent none
entire brain connect
```

Setup and connection were executed. Historical extraction and paid backfill were not enabled. The native installer reports that daemon management is unsupported on Windows; a persistent periodic watcher is not claimed. Use `entire brain memories sync --json` for explicit hosted synchronization. Keep durable decisions linked to GitHub/Linear, then remove temporary data at task completion. A new checkout or cleanup requires rebuilding the local index and connection using the commands above.

A repository-specific operator decision was synchronized to hosted Brain: `fact:caf0b112667ce75e214884be`. The native sync response returned one fact in the remote feed and retained it locally (`feed_facts=1`, `feed_kept=1`). This authored decision has no session attribution and is not a captured checkpoint.

## GitHub and Entire gates

The effective main-branch rules, including inherited rulesets, were consulted. By the operator's explicit decision, GitHub now requires an up-to-date branch (`strict_required_status_checks_policy=true`), and Entire's blocking Up to Date gate uses `allow_behind_if_mergeable=false`.

The blocking Checks gate names the following required GitHub checks explicitly and uses `require_all_success=false`:

- `Build Pages artifact`
- `Dependency Review`
- `Run zizmor`

Human Review is disabled because GitHub requires zero human approvals. Existing Agent Review settings and severity thresholds are preserved. The retired Depot gate was removed. Gate settings retain no bypass, disabled automatic merge, enabled publication of the Entire check to GitHub, and the existing branch-deletion policy.

GitHub continues enforcing signatures, resolved review conversations, security, CodeQL, licensing and its other native controls. Entire gate configuration does not replace them. Do not alter signing, bypass protection or change auto-merge to resolve a failed check.

## Evidence and remaining verification

- **Configured and confirmed:** native hooks, Brain/Graph setup and connection; gate definitions and GitHub freshness policy were read back after changes.
- **Configuration only:** the project MCP entry is available to new Codex sessions; this does not prove that an already-running IDE host reloaded it.
- **Not yet proved for this delivery:** capture of a repository-scoped session that changes a real file, a signed commit with an Entire-Checkpoint trailer, its normal push, and remote retrieval of that checkpoint. Prove this during real work; never import another repository's conversation or manufacture a test-only change.
- **Separate verification:** a successful gate configuration readback is not an approved Trail, passing CI, successful merge or application deployment.

After a real captured change, inspect its signed commit and use `entire checkpoint explain <checkpoint-id> --repo gh/LCV-Ideas-Software/.github --json` to retrieve the actual remote checkpoint. Record the commit, checkpoint and Trail evidence in LCV-477. Never publish credentials, customer data or unredacted images in session history.

## Windows console limitation

Entire subprocesses can create visible terminal windows on this Windows host. A read-only reproduction recorded a Git console even when the parent was started without a window. A PowerShell `-WindowStyle Hidden` wrapper did not eliminate the observed windows. No hook workaround has been applied or validated. Track the diagnosis in LCV-477; preserve hook input/output, exit codes and capture when evaluating an official fix. This is separate from configuration and hosted-memory synchronization.

## Official references

- [Codex integration](https://docs.entire.com/agents/codex)
- [Native MCP](https://docs.entire.com/cli-reference/mcp)
- [Brain setup](https://docs.entire.com/guides/brain/quickstart)
- [Gates](https://docs.entire.com/guides/trails/gates)
- [GitHub mirror checks](https://docs.entire.com/guides/ci/checks)
- [Checkpoint storage](https://docs.entire.com/guides/checkpoints/checkpoint-storage)

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
5. Never write the `Entire-Checkpoint` trailer by hand. The hook writes it; if it
   is missing, investigate instead of adding it.
6. Push with `git push`, then prove that the checkpoint reached GitHub:
   `git ls-remote origin 'refs/entire/*'` lists the ID from the commit trailer,
   and `entire checkpoint explain <id> --repo gh/<owner>/<repo> --json` answers.
7. Once per pull request, after it is merged, generate a remote dispatch with
   `entire dispatch --repos gh/<owner>/<repo> --since <author time of the PR's first commit> --voice neutral`
   (`gh pr view <number> --json commits -q '.commits[0].authoredDate'`): checkpoints
   are created at commit time, before the PR exists. The window can also include
   other work merged in the same period;
   and give it a title: the CLI has no title option, so take the newest setup
   for this repository from `entire api --to cell /api/v1/me/dispatch-setups`
   and run `entire api --to cell -X PATCH /api/v1/me/dispatch-setups/<setup-id> -f "name=<repo> — PR #<number>: <PR title>"`.
   Every dispatch must have a title. Post its markdown as a comment on the pull
   request, with the checkpoint IDs and the title. Entire allows one generation
   per minute per account: after a rate-limit
   answer, wait 60 seconds and retry once. The dispatch must cover the PR's own
   checkpoint IDs, read from its commit trailers; "No checkpoints" for this
   window means step 6 failed;
   never create an artificial commit to fill a dispatch.
8. Report configuration, executed-and-proven evidence, and pending items
   separately.
