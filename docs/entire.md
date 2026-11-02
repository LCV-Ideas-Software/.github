# Entire in `.github`

Verified configuration: 28 October 2026. Tracking: [LCV-477](https://linear.app/lcv-ideas-software/issue/LCV-477).

## Agent integration

Entire CLI 0.12.2, Brain 0.3.0 and Graph 0.6.0 were verified locally. In the repository, native Antigravity (`.agents/hooks.json`), Claude Code (`.claude/settings.json`), Codex (`.codex/hooks.json`), Copilot CLI (`.github/hooks/entire.json`) and Git hooks are configured for session and checkpoint capture; execution evidence is distinguished below. Because Antigravity (`agy`) runs hooks through `cmd.exe` on Windows and POSIX `sh` elsewhere—and `entire doctor` / `entire status` require `.agents/hooks.json` to match the host shell—the committed `.agents/hooks.json` is intentionally Windows-specific (`where.exe entire >nul 2>nul & if errorlevel 1 (ver>nul) else (...)`) for the Windows operator workstation; on macOS or Linux, run `entire agent add antigravity` to regenerate `.agents/hooks.json` for `sh`. Per-user workstation files outside the repository (`~/.gemini/antigravity-cli/settings.json` for the `entire hooks antigravity title-tee` token feed written by `entire agent add antigravity`, and `~/.gemini/config/mcp_config.json` for the user-level `entire mcp` registration) must be configured on each machine individually, whereas `.codex/config.toml` provides the repository-scoped read-only `entire mcp` entry for Codex; MCP retrieval does not replace capture. Start a new agent session (`agy`, `claude`, `codex` or `copilot`) inside this repository or its linked worktree, not the parent workspace.

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
- **Configuration only:** the project MCP entry (`.codex/config.toml`) is available to new Codex sessions, and the per-user Antigravity files (`~/.gemini/antigravity-cli/settings.json` and `~/.gemini/config/mcp_config.json`) apply only on workstations where those user-level steps were performed; this does not prove that an already-running IDE host reloaded them or that another machine has the per-user files.
- **Not yet proved for this delivery:** capture of a repository-scoped session that changes a real file, a signed commit with an Entire-Checkpoint trailer, its normal push, and remote retrieval of that checkpoint. Prove this during real work; never import another repository's conversation or manufacture a test-only change.
- **Separate verification:** a successful gate configuration readback is not an approved Trail, passing CI, successful merge or application deployment.

After a real captured change, inspect its signed commit and use `entire checkpoint explain <checkpoint-id> --repo gh/LCV-Ideas-Software/.github --json` to retrieve the actual remote checkpoint. Run it from a clone of another repository: inside this repository's own clone the command reads the local copy and answers even when Entire never received the checkpoint (measured on 2 November 2026, ADMIAPP-54). When the pull request is merged with squash, end the squash message with the `Entire-Checkpoint` lines the hook wrote, as the agent instructions describe. Record the commit, checkpoint and Trail evidence in LCV-477. Never publish credentials, customer data or unredacted images in session history.

## Windows background-worker correction

The Windows background-worker issue was reproduced and corrected locally on 27 October 2026, with explicit operator authorization, in the build `0.12.2-lcv.windows-console.1`, based on upstream v0.12.2. Since 30 October 2026 the installed CLI is `0.12.2-lcv.roadmap.1`, a strictly local build of v0.12.2 (`c4f103d8`) made by Codex and recorded in LCV-500: the Windows console fix (#2926/#2972), the worktree attribution hardening (#2979), the Windows test and lock parts of #2754, local fixes to the push queue, logging, transcript limits, redaction and personal data, and a reproducible build with SBOM and licenses. It does not resolve [upstream issue #2980](https://github.com/entireio/cli/issues/2980), whose cause LCV-500 left inconclusive. Workers now retain a headless console that Git children inherit; no hook-hiding wrapper was added. The regression failed before the patch and passed afterward, the execx package passed, and both the built CLI and installed shim completed the observed status command with zero visible windows. The operator confirmed that the interruptions stopped. [Upstream issue #2926](https://github.com/entireio/cli/issues/2926) contains the full patch, context and limits. This is a local correction, not an official release or proof of the full upstream test suite; a reinstall can replace it. LCV-477 records the installed binary hash and operator confirmation.

## Official references

- [Antigravity integration](https://docs.entire.com/agents/antigravity)
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
