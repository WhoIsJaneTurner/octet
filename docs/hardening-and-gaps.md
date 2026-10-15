# Hardening, correctness gaps and known issues

Everything not on the planning side that still needs doing, plus bugs and rough edges found during the first build session. Section references from [roadmap.md](roadmap.md) point here.

## 1. Builder sandboxing (L)

**Gap.** Engineers run Claude Code headless with `--permission-mode acceptEdits` and a denied-tools list (`DENIED_TOOLS` in `packages/core/src/runner.ts`: `git push`, `gh pr`, `gh repo`, `gh auth`). That blocks the obvious paths but is a deny-list. The agent can still run arbitrary shell commands in its worktree, read files outside it, and reach the network.

**Target.** An allow-list sandbox around the whole agent process.

| Control | Approach |
|---|---|
| Filesystem | Confine writes to the bead worktree plus a scratch directory. Read access to the worktree, system libraries and the toolchain only. Never `~/.ssh`, `~/.config/octet`, other worktrees or other repos |
| Network | Off by default. Allow-list hosts when a bead needs package installs |
| Credentials | The agent environment already excludes tokens; verify with a test that dumps its environment |
| Processes | Time limit per run (default 20 minutes) and a memory ceiling; kill the process group on timeout |

**Options on macOS**, in rough order of effort: Claude Code's own sandbox and permission settings (check `claude --help` and its settings reference for the current options before building anything), `sandbox-exec` profiles, a container per run (Docker or an equivalent).

**Tests.** A fixture "hostile engineer" runner that tries to read `~/.ssh`, write outside the worktree and call out to the network. Each attempt must fail and be logged.

## 2. Interoperability and observability (L)

### 2.1 Second agent adapter, via ACP

`AgentRunner` (`runner.ts`) has one real implementation. Add an adapter for the Agent Client Protocol (JSON-RPC over stdio, version negotiation, streamed updates) so other coding agents can be used per seat. Requirements:

- A per-seat `agent` setting in config; default stays Claude Code.
- The adapter enforces the same denials: no push, no PR commands.
- Capability handshake recorded in the audit log (agent name and version), so a run is attributable.

### 2.2 MCP policy

Builders currently run with MCP disabled (`--strict-mcp-config` with an empty config). If planning seats or builders later need MCP tools:

- Per-seat allow-list of servers in config. Default none.
- Treat tool descriptions as untrusted input.
- Log every tool call with arguments in the audit chain.
- Pin the MCP spec revision you target.

### 2.3 OpenTelemetry

Emit traces using the GenAI conventions: `invoke_agent {seat}` per run with `execute_tool` children where the adapter reports tool calls. Keep attribute names behind one module because the conventions were still marked "Development". Content capture off by default. Export to a local OTLP endpoint only if one is configured.

## 3. Run control and recovery (M)

Done in session two: cancel, timeout, persisted output, heartbeat-based orphan detection, and a bead never stays `running` when the runner throws. Remaining items are listed at the end.

| Gap | Fix (done) |
|---|---|
| Cannot cancel a running agent | `RunRequest.signal`; `ClaudeCodeRunner` spawns the agent in its own process group, sends SIGTERM to the group, then SIGKILL after 5 s. `cancelBead` (core), `POST /api/beads/:id/cancel`, `octet bead cancel <bead>`, UI button and `x` key. Ctrl-C on `octet bead run` cancels cleanly. A cancel from another process is set in the database and honoured at the owner's next heartbeat (5 s). The bead becomes `failed`, the event is `bead.cancelled` with `reason: cancelled`, and the worktree is kept for a re-run |
| Run timeout | `[limits] run_timeout_minutes` in `config.toml` (default 20). Event `bead.failed` with `reason: timeout` |
| Engineer output lost on restart | Every run appends to `<data>/runs/<bead>/<n>.log`, capped at 2 MB. The `/output` route falls back to the latest log when the in-memory copy is empty |
| CLI-started runs invisible to the daemon | `bead_runs` table: pid, host, start, heartbeat, end reason, cancel flag. The daemon's `running` list and the engineer cap now come from the database, so CLI runs show up |
| Orphan recovery only at daemon start | `reconcileRunning` treats a `running` bead as live only with an open run whose heartbeat is under 30 s old and (on this host) whose pid exists. It runs at daemon start, every 15 s in the daemon, and before every `runBead` and `cancelBead`. It no longer fails runs that another live process owns |
| Runner or git throws mid-run | `runBead` now marks the bead `failed`, closes the run and logs `bead.failed` with `reason: error` |

**Closed in session three**

| Gap | Fix (done) |
|---|---|
| No goal-level failure state | `abandonGoal` (core), `POST /api/goals/:id/abandon`, `octet goal abandon <goal>`, and an ABANDON GOAL button (with a confirm) on the board. It sets `goals.status = 'failed'` first, so the scheduler stops; cancels running engineers and reviews and waits for them to stop; denies any pending approval for the goal (a delivery can never be approved later) and marks awaiting plans rejected; removes the bead and goal worktrees; resolves the goal's escalations; logs `goal.abandoned`. Branches are kept. A `delivered` goal is refused: Octet never touches a PR, so close it on GitHub. A bead of an abandoned goal refuses to run. If an agent has not stopped within 15 s its worktree is kept and `octet gc` collects it later |
| No cleanup | A merged PR (`refreshPr` sets the goal `done`) now removes the goal's worktrees too (`cleanupGoal`, event `goal.cleaned`). `octet gc` (`GET`/`POST /api/gc`) lists worktrees under `.octet/worktrees` that belong to a merged bead, a done or abandoned goal, or nothing in the database; it is a dry run unless you pass `--yes`. Branches are never deleted by Octet |
| Temp directories leak | `reviewExternalPr` removes its temp directory in a `finally` |
| Reviews cannot be cancelled | A review is now a run: it has a `bead_runs` row (`kind = 'review'`) with a heartbeat and a cancel flag, so `cancelBead` on an `in_review` bead (API, CLI, UI button and `x` key) stops it from any process. The bead stays `in_review`; the event is `review.cancelled`. The scheduler does not restart a review you cancelled: it raises a `review_cancelled` escalation instead, and clears it once there is a verdict. A second review of the same bead is refused while one is running |
| Output redaction | Run logs go through `RunLogWriter` (`runlog.ts`): text is held until a complete line (and a complete private-key block), redacted with `redact`, and only then written, so a token split across two chunks is still caught. `Store.log` runs `redactDeep` on every event's data before hashing and inserting, so the audit chain covers what is stored; when something was hit the event gains a `redacted` count and a `run.redacted` event records the log's count. The drafted pre-review PR comment is redacted before it can be approved. **Not covered:** the live stream to the UI (`/output`, SSE) is raw text that is never persisted; `octet pr review` prints the Reviewer's text to your terminal unredacted; approvals other than the pre-review comment are not redacted |

## 4. Git correctness (M)

- **Merge conflicts.** `approveBead` merges the bead branch into the goal worktree. If it conflicts, `mergeBranch` throws, `bead.merge.failed` is logged, and the goal worktree may be left mid-merge. Needed: abort the merge cleanly (`git merge --abort`), mark the bead `conflict`, and route it (Marshal asks the engineer to rebase and resolve with the conflict shown, or escalates to you after one attempt).
- **Stale base.** A bead branches from the goal branch when it starts. If other beads merge meanwhile, its diff is against an old base. Before review, rebase or merge the current goal branch into the bead branch and re-run checks; a conflict follows the path above.
- **Same-file beads.** The plan validator flags beads that share a file with no dependency; once conflict handling exists, make it an error unless the Architect justifies it.
- **Goal-level review.** Reviewing each bead does not review the combined change. Add a Reviewer pass over the whole goal diff before delivery, as a gate that can send work back (today the equivalent exists only as the optional PR comment).
- **Delivery idempotency.** If the push succeeded and PR creation failed, a retry pushes again (harmless) and tries to create a second PR. Detect an existing open PR for the branch and adopt it.
- **Default branch detection** falls back to the current branch when `origin/HEAD` is missing. Prefer asking the remote, and refuse to guess when ambiguous.
- **Remote formats.** The owner guard understands GitHub SSH and HTTPS URLs only. Add GitHub Enterprise hosts if needed; keep GitLab out of scope until requested.
- **Large diffs.** Reviewer input is truncated at 60,000 characters with a marker. A truncated review must not be able to produce an automatic approval: treat truncation as `inconclusive` for auto-merge purposes.

## 5. Cost and usage (S to M)

**Done in session three**

- **Capture.** `ClaudeCodeRunner` now runs `claude -p --output-format stream-json --verbose` (prompt still on stdin). `ClaudeStream` (`claude-stream.ts`) turns the lines into the same plain text as before (assistant text as it arrives, one `> Tool detail` line per tool call, nothing for init or tool results), so live output keeps working and now shows progress during a run, not only the final answer. The closing `result` message supplies the final answer (`RunResult.output`, which the Reviewer's verdict is parsed from) and `RunResult.usage` (a new optional field). A result with `is_error: true` makes a zero exit code a failure. A line that is not JSON is passed through untouched. `--output-format json` was not used: it prints once at the end, so nothing would stream.
- **Store.** Migration 4 adds `kind` (`engineer` or `review`), `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `num_turns` and `model` to `bead_runs`. `Store.usageSummary()` totals per bead, goal and local day; review runs count too. Parsing is defensive: any missing or malformed field is skipped, and a run with no usage still counts as a run.
- **UI and CLI.** Tab `5 usage` (today, by day, by goal and bead), a cost line on each bead, `$x.xx today` in the header, and `octet usage`. The figures are Claude Code's own estimate at list prices; on a subscription plan they are not what you are charged.
- **Ceiling.** `[usage] daily_cost_usd` and `daily_runs` in `config.toml`, both optional. When today's total reaches either, the scheduler (`tick`, via `usageHold`) starts no new engineer or reviewer runs; merges and deliveries still happen, a `usage.ceiling_reached` event is logged once a day, and the UI shows the hold. A run you start with the button is not blocked. The per-goal run ceiling from the planning doc was already built into the scheduler (`run_ceiling`).

**Claude Code 2.1.296: observed output shape** (`claude -p "reply ok" --output-format stream-json --verbose --include-partial-messages`, one live run). One JSON object per line: `system/init`, `system/status`, `stream_event` records (only with `--include-partial-messages`), one `assistant` message per content block (`message.content[]` holds `text` or `tool_use` blocks, with its own `message.usage`), a `rate_limit_event`, and a final `result`. `--output-format json` prints just that final `result` object. Its fields, as observed:

```
type "result", subtype "success", is_error false, result "ok", stop_reason "end_turn", terminal_reason "completed"
total_cost_usd 0.0403806, num_turns 1, duration_ms 1681, duration_api_ms 1632, session_id, uuid
usage { input_tokens 2, output_tokens 4, cache_read_input_tokens 22366, cache_creation_input_tokens 9525,
        cache_creation { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }, server_tool_use { web_search_requests, web_fetch_requests },
        service_tier, inference_geo, iterations [...], output_tokens_details { thinking_tokens }, speed }
modelUsage { "<model>": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, contextWindow,
                          maxOutputTokens, canonicalModel, provider, costBasis "list" } }
permission_denials [], plus timing and subagent bookkeeping
```

A trimmed copy is the test fixture `packages/core/test/fixtures/claude-stream-ok.jsonl`. Only `usage.*`, `total_cost_usd`, `num_turns`, `modelUsage` (for the model name), `result` and `is_error` are read. `modelUsage[].costBasis: "list"` is why the cost is an estimate. Not verified live: a full engineer run through the daemon with stream-json (the prompt-on-stdin plus stream-json combination is exercised only against a stand-in `claude` script in the tests).

**Still open:** usage for the goal-level pre-review and `octet pr review` (they have no bead, so no run row); effort scaling (planning doc §5), the main lever on cost.

## 6. Product and packaging

### 6.1 UI

- ~~**Project management in the UI.**~~ **Done.** `6 setup` has an add-project form (name, path, identity, vault, vault options, autonomy; `POST /api/projects`), and each project's autonomy can be changed in place (`POST /api/projects/:name`). The daemon notices changes to `projects.toml` (checked on every request and every 2 s, with the last good list kept and the error shown if the file breaks), so a CLI-added project appears without a restart.
- ~~**Identity doctor in the UI.**~~ **Done.** `POST /api/identities/doctor` (on demand only, one at a time, async so it does not block the daemon); the same checks as `octet identity doctor`, which now shares the code (`doctorIdentities`). The ssh probe gained a 10 s connect timeout.
- **Goal and bead management:** ~~edit a bead's brief before it runs, delete a bead that has not started, abandon a goal~~ **Done** (`editBead`, `deleteBead`, `abandonGoal`; edit is allowed for `todo` and `failed` beads, delete only for a bead that has never run and that nothing waits on). **Reordering is not built.**
- ~~**Sidebar selection**~~ **Done.** OPEN buttons on escalations and approvals select the owning goal (and bead); delivered and done goals show their PR link under the goal in the sidebar; abandoned goals show a mark and "(abandoned)" for screen readers.
- ~~**Notifications:**~~ **macOS done.** `[notify] macos = true` in `config.toml`: the daemon calls `osascript` (text passed as arguments, never spliced into the script) when a new approval or escalation appears; what is already waiting at startup is not announced; a missing `osascript` or a throwing notifier never affects a run. Slack later.
- ~~**Keyboard help overlay** (`?`).~~ **Done.** A modal dialog (focus moves in, Esc or `?` closes it, focus returns). Keys `5` and `6` open the usage and setup tabs.
- **Accessibility pass:** focus order, contrast of the dim green on black at small sizes, screen-reader labels for status glyphs (several are set; audit all), and a high-contrast option. The CRT effect already has an off switch; keep respecting `prefers-reduced-motion`.
- **Mobile layout** works down to narrow widths but has not been tuned.
- **Cross-browser:** only Chrome was exercised (session three drove the new UI in headless Chrome over the DevTools protocol: help overlay, bead edit, setup form, identity check, usage tab, OPEN selection, PR link, abandon with confirm; no console errors). That script is not in the repo.

### 6.2 Desktop shell

The original plan was an Electron wrapper. Today the UI runs in a browser tab served by the daemon. Packaging steps when wanted: Electron main process starts the daemon on a random free port, keeps the token in memory, loads the UI, and quits the daemon on exit. Code signing and updates are the expensive part and can wait.

### 6.3 CLI

- Put `octet` on PATH during setup (a launcher exists at `~/.local/bin/octet`; an installer step should add it).
- `octet doctor`: verify Node version, `git`, `gh`, `claude` on PATH, identity health, config file validity, database integrity and audit chain.
- Config validation with helpful errors (currently `parseIdentities` checks required fields only; `config.toml` accepts anything).
- Shell completion.

### 6.4 Data

- **Real migrations.** Schema changes are ad hoc (`ALTER TABLE` guarded by a column check). Add a `schema_version` table and ordered migration functions before the planning tables land.
- **Backups:** copy the database before migrations; document restore.
- **Retention:** the event log grows forever. Add archiving of old events *without* breaking the chain (archive complete segments and keep the segment's closing hash).

### 6.5 Tests and CI

- No CI yet. Add a GitHub Actions workflow: install, typecheck, unit tests, UI build. Node 24 and pnpm 11 are required.
- The daemon tests start real servers on ephemeral ports; fine in CI.
- Real-model tests gated behind an environment variable (`OCTET_LIVE=1`), never run by default.
- Add lint and format (a minimal config; match the existing style).
- A browser smoke test (headless Chrome via `puppeteer-core`, already proven locally) for the main flows. Note: headless Chrome's `--screenshot` flag hangs on pages with an open event stream; drive it with the DevTools protocol instead and wait for specific elements.
- Coverage targets for the Warden and identity modules should be near complete; they are the security boundary.

## 7. Security backlog

| Item | Detail |
|---|---|
| Audit head anchoring | See plan-vault §5. Until done, tail truncation of the event log is undetectable |
| Token handling | The per-session API token is injected into the HTML. Fine on loopback with the Host check; if the daemon ever binds beyond loopback, replace with real auth |
| Secrets in logs | **Mostly done** (see §3): run logs and event data are redacted before they are stored or hashed. Gaps: the live UI stream, terminal output of `octet pr review`, and approval summaries other than the pre-review comment |
| Prompt-injection evals | See planning doc §8; add cases for each intake source |
| Dependency hygiene | Pin versions, run `pnpm audit` in CI, and review the one install-script exception (`esbuild`, disabled in `pnpm-workspace.yaml` because its binary ships separately) |
| Signing | Optional commit signing per identity (`signing_key` is accepted in the identity schema but unused). Implement or remove |
| Identity hygiene | The `bioSandMan` GitHub account holds older keys (`deepsync`, `jane_turner`). Review and remove unused keys |
| Least-privilege tokens | `gh` logins currently carry `repo`, `read:org`, `gist`, `admin:public_key`. Reduce scopes to what Octet uses (`repo`, `read:org`); `admin:public_key` was only needed for setup |

## 8. Known issues found in session one

1. Demo PR #1 on `octet-throwaway` contains output from the fake engineer (a file holding the prompt), not real work. It exists only to prove delivery; the Reviewer correctly rejected it. Delete it.
2. The first run showed Claude's reply mentioning unauthorized connectors; fixed by launching builders with MCP disabled, but it could not be reproduced on demand, so treat the cause as unproven and watch for it.
3. ~~`pr review` and `pr prereview` rely on the PR being reachable with the named identity; a 404 surfaces as a `gh` error, not a friendly message.~~ **Fixed.** `friendlyGhError` (`forge.ts`) turns a missing PR, a login failure and a network failure into plain messages that name the identity; anything else keeps the raw `gh` text.
4. ~~The UI does not show `delivered` goals' PR link in the sidebar, only on the board.~~ **Fixed.**
5. Nothing prevents two daemon processes on the same database; the second will bind another port and the in-memory `running` sets will disagree. Add a lock file.
6. `FakeRunner` writes `engineer-output.txt` into worktrees. Fine for tests; make sure no real flow can ever use it (the `--fake` flag on the daemon and CLI is the only route).

## 9. Reference-doc gaps still open

From [orchestrator-reference.md](orchestrator-reference.md) §12, after the first session:

| Area | Status |
|---|---|
| OpenTelemetry traces | Not started (§2.3) |
| MCP / ACP / A2A | Not started (§2.1, §2.2). A2A is only relevant if Octet ever talks to other orchestrators |
| Builder sandboxing | Not started (§1) |
| Effort scaling | Designed (planning §5), not built |
| Audit head anchoring | Designed (vault §5), not built |
| Chair, Marshal, Architect, Scout | Designed (planning), not built |
