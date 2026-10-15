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

### 2.4 As built (roadmap step 13)

All in `packages/core/src` as new files, tested without any model or external service. Edits to existing files are listed at the end.

**Pinned revisions** (constants in code, so a bump is one edit):

| Standard | Pinned | Where |
|---|---|---|
| Agent Client Protocol | `protocolVersion` 1, schema v1.25.0 (released 2026-10-09). A v2 alpha exists and is not targeted | `ACP_PROTOCOL_VERSION`, `ACP_SCHEMA_REVISION` in `acp.ts` |
| Model Context Protocol | specification revision 2026-07-28 (the "current" revision on modelcontextprotocol.io when written). Octet does not speak MCP: it decides which servers an agent is launched with, and the agent negotiates the revision with each server | `MCP_SPEC_REVISION` in `mcp-policy.ts` |
| OpenTelemetry GenAI semantic conventions | `open-telemetry/semantic-conventions-genai` at commit `f3c6d0c` (2026-10-14), `gen-ai-agent-spans.md` and `gen-ai-spans.md`, status Development, referencing core semconv v1.44.0. The conventions have moved out of the main semantic-conventions repository | `SEMCONV_REVISION` in `otel-attrs.ts` |
| OTLP | OTLP/HTTP with a JSON body: `POST {endpoint}/v1/traces`, hex trace and span ids, int64 as decimal strings | `otel.ts` |

**Config** (`~/.config/octet/config.toml`, parsed by `parseInterop` in `interop-config.ts`; mistakes such as an unknown seat, or an allow-list naming an undefined server, fail at startup with a message naming the key):

```toml
[agents]                      # seat -> command that speaks ACP on stdio; absent or "claude" = Claude Code
reviewer = "my-agent --acp"   # a string (split like a shell would, but no shell is used) or an array

[mcp.servers.docs]            # servers Octet may hand to an agent
command = "docs-mcp"          # or: type = "http", url = "https://...", headers = { ... }
args = ["--stdio"]
env = { DOCS_ROOT = "/srv/docs" }
tools = ["search"]            # optional: pin tool names; omitted = the whole server
read_only = true              # only servers marked so are available to read-only seats (Reviewer)
[mcp.allow]                   # seat -> server names; default none
engineer = ["docs"]

[telemetry]
otlp_endpoint = "http://127.0.0.1:4318"   # unset = nothing is exported
capture_content = false                    # prompts, outputs, tool arguments and results: off unless true
[telemetry.headers]                        # optional, e.g. an auth header for the collector
```

**ACP adapter** (`acp.ts`; policy in `agent-policy.ts`). `AcpRunner` implements `AgentRunner`. It spawns the command in its own process group (SIGTERM, then SIGKILL after 5 s, and a group kill again on exit, like `ClaudeCodeRunner`), sends `initialize` with `protocolVersion` 1, refuses an agent that answers with another version, calls `session/new` with the worktree as `cwd` and the seat's allow-listed stdio MCP servers, then runs one `session/prompt` (persona and assignment in one text block, since ACP has no system-prompt field). `agent_message_chunk` text streams to `onChunk` and becomes `RunResult.output`. `RunRequest.signal` and `timeoutMs` kill the group; an agent that never answers `initialize` fails after 30 s. Requests from the agent are answered under these rules, and every decision is reported to the observer and lands in the audit log as `agent.permission`:

- `fs/read_text_file`, `fs/write_text_file`: absolute paths only, resolved through symlinks, refused if they leave the worktree. Writes are refused for read-only seats and anywhere under `.git` (a hook would run when Octet later commits).
- `terminal/*`: offered only to seats that may write. A command line containing `git push`, `gh pr`, `gh repo` or `gh auth` is refused; the patterns are derived from `DENIED_TOOLS`, so the two lists cannot drift. The match is deliberately broad (`git commit -m "push"` is refused too). Agent-supplied environment variables apply except `LD_*`, `DYLD_*`, `GIT_SSH*`, `GIT_ASKPASS`, `SSH_*`. Commands run with the same token-free environment as the agent.
- `session/request_permission`: the same checks on the tool call's title, `rawInput`, locations and `kind`. Read-only seats may only `read`, `search`, `think`; writers may also `edit`, `delete`, `move`, `execute`; `fetch`, `switch_mode` and `other` are always refused. Octet only ever selects an `allow_once` option, never `allow_always`.
- Any other method gets "method not found" and is logged.

**Attribution.** One `agent.handshake` event per run records protocol and version, launch command, agent name, title and version, the agent's reported capabilities (capped at 4,000 characters), the session id and, for Claude Code, the model and the MCP servers it connected. A failed handshake (version mismatch, no answer) is recorded with an `error`. Events are attributed to the goal and bead by matching the run's `cwd` to a bead or goal worktree.

**Per-seat selection.** `RoutingRunner` dispatches by `req.seat`, so `Ctx.runner` stays one object. `selectRunner(config, seat, fallback)` returns the ACP runner for a seat named in `[agents]`, else the fallback. `buildRunner({ store, fake? })` is what the daemon and CLI call: Claude Code by default, ACP per seat, all wrapped in `ObservedRunner`, with a `shutdown()` that flushes spans.

**MCP policy** (`mcp-policy.ts`). With no `[mcp]` table nothing changes: the launch still carries `--strict-mcp-config --mcp-config {"mcpServers":{}}`. With an allow-list, `mcpFor` builds the `--mcp-config` JSON and the matching `--allowedTools` entries (`mcp__server__tool` for pinned tools, `mcp__server` for a whole server; headless runs cannot ask, so an MCP tool is usable only if listed). Read-only seats get only servers marked `read_only`. Tool descriptions are untrusted: Octet never reads or forwards them (the agent fetches them from the server); only names written in the config are allowed; every string a server or agent supplies that Octet stores or exports (names, titles, capability blobs) is stripped of control characters and capped (`untrusted()` in `observe.ts`).

**What Claude Code exposes (checked, not assumed).** `claude -p --output-format stream-json --verbose` (Claude Code 2.1.296) prints one JSON object per line: `system`/`init` (`session_id`, `model`, `claude_code_version`, `mcp_servers[{name,status}]`, `tools[]`), `assistant` messages whose `content` holds `text` or `tool_use {id, name, input}` blocks, `user` messages with `tool_result {tool_use_id, content, is_error?}` blocks, and a final `result` (`result` text, `is_error`, `usage`, `total_cost_usd`). An MCP tool is named `mcp__<server>__<tool>`, so MCP calls with their arguments are observable and are logged as `mcp.tool_call` and `mcp.tool_result` events. Gaps:

- A call is seen when the assistant message completes, before its result. This is a record, not a gate: enforcement is the allow-list and `--allowedTools`. The one active check: if `init` lists an MCP server that is not on the seat's allow-list, the run is killed and `agent.permission` records `mcp/connect` as denied.
- Server-level `--allowedTools mcp__server` (no tool name) was not exercised live; the pinned form `mcp__server__tool` was. Prefer `tools = [...]`.
- Tool descriptions are not in the audit log, and tool results appear on spans only with content capture on.
- ACP does not say whether a tool is an MCP tool, so ACP tool calls produce spans but no `mcp.tool_call` audit events. What an ACP agent does with its own tools never passes through Octet.
- Stream-json is read only when something consumes it (a telemetry endpoint, or a non-empty MCP allow-list for the seat). Otherwise Claude Code is launched exactly as before, with plain text output.

**OpenTelemetry** (`otel-attrs.ts`, `otel.ts`, `observed-runner.ts`). `ObservedRunner` wraps any runner. Per run it emits one `invoke_agent {seat}` span (kind CLIENT) with `gen_ai.operation.name`, `gen_ai.agent.name` (the seat), `gen_ai.provider.name` (`anthropic`, the ACP command's basename, or what the agent reports) and `gen_ai.request.model`; at the end `gen_ai.agent.version`, `gen_ai.conversation.id` (the agent's session id), `gen_ai.usage.input_tokens` / `output_tokens` (Claude Code; input includes cached tokens) and, on failure, `error.type` (`timeout`, `cancelled`, `agent_exit_nonzero`, `exception`) with ERROR status. Octet's own attributes: `octet.goal.id`, `octet.bead.id`, `octet.seat`, `octet.exit_code`, `octet.cost.usd`. Each reported tool call is an `execute_tool {name}` child (`gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type` = `extension` for MCP, `function` otherwise); for ACP the name is the tool `kind`, because titles carry paths and commands. All names live in `otel-attrs.ts`. Content (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`) is written only with `capture_content = true`; a test asserts the prompt, persona, arguments and results are absent from the wire by default. The exporter (`OtlpHttpExporter`: global `fetch`, no dependencies) exists only if `otlp_endpoint` is set. It queues finished spans (at most 2,048, oldest dropped), sends batches of up to 64 every 5 s in the background with a 5 s timeout, never throws, and `shutdown()` flushes (the daemon on SIGINT, the CLI when a command finishes). A dead, failing or hanging collector costs the run nothing; tests cover all three.

**Not verified.**

- No real third-party ACP agent was run (none installed). `AcpRunner` is tested against a scripted agent written from the pinned schema, so a real agent may exercise paths the fixture does not. Known simplifications: `authenticate` is not implemented (the agent must already be logged in); `session/cancel` is not sent (abort kills the process group); `req.model` is ignored (ACP has no standard model selection); only text prompt content is sent; HTTP MCP servers are not passed to ACP agents; the `toolCall` in `session/request_permission` is read defensively because the schema page only shows `toolCallId` there.
- The ACP policy gates what the protocol lets the agent ask of the client. An agent can still write files or run commands itself, outside the protocol. Real confinement is the sandbox in §1.
- No real OTLP backend has received the spans; the JSON follows the OTLP/HTTP spec but was checked only against a local capture server. gRPC and protobuf are not supported.
- Claude Code's stream-json was run live once, to capture event shapes: a single `claude -p --model haiku` prompt in a temp directory, with `--strict-mcp-config`, a local echo MCP server and `--allowedTools mcp__echo__echo`. The trimmed transcript is `packages/core/test/fixtures/claude-mcp-stream.jsonl`; the default suite replays it through a stand-in `claude` script.
- The account-level connector leak in §8.2 is not explained by this work; `--strict-mcp-config` plus the `init` check make a recurrence detectable.

**Edits to existing files** (small, localized): `runner.ts` (optional `RunRequest.observer`; `ClaudeCodeRunner` takes an options object with `command`, `mcp`, `observe`, `captureResults`; defaults leave behaviour unchanged), `index.ts` (exports), `packages/daemon/src/main.ts` and `packages/cli/src/main.ts` (build the runner with `buildRunner`; flush on exit). `config.ts` is untouched; the new tables are parsed in `interop-config.ts`.

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

**Still open in this section**

| Gap | Fix |
|---|---|
| No goal-level failure state | `goals.status = 'failed'` exists but nothing sets it. Set it when the scheduler escalates a goal and you choose to abandon it; add an `abandon` action that cleans up worktrees |
| No cleanup | Worktrees and branches remain after a goal is done or abandoned. On `done`/`abandoned`, remove bead and goal worktrees (keep branches until the PR merges), with an `octet gc` command for stragglers |
| Temp directories leak | `reviewExternalPr` creates a temp directory per call and never removes it. Remove in a `finally` |
| Reviews cannot be cancelled | Same mechanism (signal plus heartbeat) applies to Reviewer runs; not wired yet |
| Output redaction | Run logs are written raw; see the security backlog |

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

- Capture token and cost data from the agent's structured output (check Claude Code's JSON output mode and flags; do not assume the field names) and store per run.
- Show totals per bead, per goal and per day in the UI.
- Enforce the per-goal run ceiling from the planning doc, and an optional daily ceiling that pauses the scheduler.
- Effort scaling (planning doc §5) is the main lever on cost.

## 6. Product and packaging

### 6.1 UI

- **No project management in the UI.** Adding a project needs the CLI, and the daemon loads projects at startup, so a CLI-added project does not appear until restart. The API route `POST /api/projects` exists; add the form, and make the daemon re-read `projects.toml` when it changes.
- **Identity doctor in the UI** (currently CLI only).
- **Goal and bead management:** edit a bead's brief before it runs, delete a bead that has not started, reorder, abandon a goal.
- **Sidebar selection** defaults to the first goal even when you opened the inbox for another; select the goal that owns the item you open.
- **Notifications:** a macOS notification when an approval arrives or a goal needs you (`osascript` is enough). Slack later.
- **Keyboard help overlay** (`?`).
- **Accessibility pass:** focus order, contrast of the dim green on black at small sizes, screen-reader labels for status glyphs (several are set; audit all), and a high-contrast option. The CRT effect already has an off switch; keep respecting `prefers-reduced-motion`.
- **Mobile layout** works down to narrow widths but has not been tuned.
- **Cross-browser:** only Chrome was exercised.

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
| Secrets in logs | Engineer output and event data can include secrets the agent saw. Add a redaction pass before persisting output and events |
| Prompt-injection evals | See planning doc §8; add cases for each intake source |
| Dependency hygiene | Pin versions, run `pnpm audit` in CI, and review the one install-script exception (`esbuild`, disabled in `pnpm-workspace.yaml` because its binary ships separately) |
| Signing | Optional commit signing per identity (`signing_key` is accepted in the identity schema but unused). Implement or remove |
| Identity hygiene | The `bioSandMan` GitHub account holds older keys (`deepsync`, `jane_turner`). Review and remove unused keys |
| Least-privilege tokens | `gh` logins currently carry `repo`, `read:org`, `gist`, `admin:public_key`. Reduce scopes to what Octet uses (`repo`, `read:org`); `admin:public_key` was only needed for setup |

## 8. Known issues found in session one

1. Demo PR #1 on `octet-throwaway` contains output from the fake engineer (a file holding the prompt), not real work. It exists only to prove delivery; the Reviewer correctly rejected it. Delete it.
2. The first run showed Claude's reply mentioning unauthorized connectors; fixed by launching builders with MCP disabled, but it could not be reproduced on demand, so treat the cause as unproven and watch for it.
3. `pr review` and `pr prereview` rely on the PR being reachable with the named identity; a 404 surfaces as a `gh` error, not a friendly message.
4. The UI does not show `delivered` goals' PR link in the sidebar, only on the board.
5. Nothing prevents two daemon processes on the same database; the second will bind another port and the in-memory `running` sets will disagree. Add a lock file.
6. `FakeRunner` writes `engineer-output.txt` into worktrees. Fine for tests; make sure no real flow can ever use it (the `--fake` flag on the daemon and CLI is the only route).

## 9. Reference-doc gaps still open

From [orchestrator-reference.md](orchestrator-reference.md) §12, after the first session:

| Area | Status |
|---|---|
| OpenTelemetry traces | Built (§2.4); not yet seen by a real backend |
| MCP / ACP / A2A | ACP adapter and MCP allow-lists built (§2.4); not yet run against a real third-party ACP agent. A2A is only relevant if Octet ever talks to other orchestrators |
| Builder sandboxing | Not started (§1) |
| Effort scaling | Designed (planning §5), not built |
| Audit head anchoring | Designed (vault §5), not built |
| Chair, Marshal, Architect, Scout | Designed (planning), not built |
