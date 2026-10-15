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

### As built

**Decision: a Seatbelt profile around the whole `claude` process, not Claude Code's built-in sandbox.** Researched against the current docs and `claude --help` (v2.1.296):

| Option | Verdict |
|---|---|
| Claude Code's built-in sandbox (`--settings` with `sandbox.*`) | Rejected as the boundary. It wraps shell commands only. Its Read, Edit, Write and WebFetch tools, MCP servers and hooks run outside it, `denyRead` does not stop the Read tool, and reads are open by default (`~/.ssh` is readable until you list it). Useful as a second layer later, not as the wall |
| `sandbox-exec` (Seatbelt) profile around the spawn | **Chosen.** Covers the model process, its file tools and every child. Default deny, so the policy is an allow-list. Deprecated by Apple in the man page but still what Claude Code itself uses on macOS |
| Container per run | Not built. Stronger, but needs Docker/Colima running and a way to reach the macOS keychain login |

Code: `packages/core/src/sandbox.ts` (profile, environment scrub, memory watchdog, denial collection, config), `packages/core/src/netproxy.ts` (host allow-list proxy). `ClaudeCodeRunner` calls `prepareSandbox()` for every run; `runBead`, `reviewBead`, `requestPrecomment` and `reviewExternalPr` pass `sandboxFor(ctx, ...)` on the `RunRequest` so events land in the audit log. A runner option (`runner.sandbox = cfg`), `Ctx.sandbox` or `RunRequest.sandbox.config` override `config.toml`. Any new seat that spawns an agent (the planning side) must pass `...sandboxFor(ctx, { goalId, seat })` on its `RunRequest`; without it the run still sandboxes, but its events are not logged.

**Config** (`~/.config/octet/config.toml`):

```toml
[sandbox]
mode = "auto"            # off | auto | required
allow_hosts = ["registry.npmjs.org", "*.pypi.org"]   # on top of the model API hosts
extra_read_paths = ["~/.cargo", "~/.rustup"]          # toolchains outside the usual places
extra_write_paths = ["~/.cache/pnpm"]                 # build caches; use sparingly
memory_mb = 4096         # 0 = no ceiling
```

- `required`: if `sandbox-exec` is missing or cannot be applied (for example Octet itself runs inside another sandbox), the run throws `Sandbox is required ... Refusing to run the agent unprotected` and the bead fails. It never falls back.
- `auto`: sandbox when possible. Otherwise run unprotected and log a `sandbox.unavailable` event whose message says so.
- `off`: no sandbox, no events. An unknown mode is a config error, never `off`.
- **Default is `auto`.** I chose it because a real `claude`, logged in on this machine, ran under the profile end to end (see "Evidence"). On a machine without `sandbox-exec` (Linux, Windows) `auto` means *unprotected*; set `required` there once a Linux backend exists, or if you want a hard guarantee on macOS.

**What the profile allows** (everything else is denied):

| Control | Policy |
|---|---|
| Reads | System paths (`/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/opt/homebrew`, `/private/etc`, a few `/private/var/db` entries), every `PATH` directory outside the home directory, the prefix of the node running Octet, the package `claude` is installed in, the worktree, the repository's git directory, the macOS keychain files, `~/.claude`, plus `extra_read_paths`. The existence and size of any path is visible (`file-read-metadata`); contents are not |
| Writes | The worktree (not for read-only seats), a fresh scratch directory per run (`TMPDIR` and `CLAUDE_CODE_TMPDIR` point at it; deleted afterwards), `~/.claude` and `~/.claude.json`, plus `extra_write_paths`. In a linked worktree, git gets `objects/`, the worktree's private git dir and its own branch ref and reflog, so `git add` and `git commit` work. `hooks/`, `config`, `HEAD`, `commondir`, the `.git` pointer file and every other branch stay read-only: an agent cannot plant a hook that Octet's own `git commit` would later run, or move the worktree to another branch |
| Never, whatever else says so | `OCTET_HOME`, `OCTET_DATA` (database and audit log), `~/.config/octet`, `~/.local/share/octet`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.npmrc`, `~/.netrc`. Other worktrees, the repository root and other repositories are simply not in the allow-list. `~/.claude/projects`, `history.jsonl`, `file-history`, `sessions` and friends are **write-only**: the agent can add its own transcript but cannot read other sessions' |
| Network | Outbound connections are denied except to one loopback port: an allow-list CONNECT proxy that Octet starts per run. `HTTPS_PROXY` and friends point at it. It allows `api.anthropic.com`, `platform.claude.com`, `console.anthropic.com` and `allow_hosts` (exact names or `*.suffix`), refuses plain HTTP, and refuses hosts that resolve to loopback, private or link-local addresses. Direct connections, including to `127.0.0.1` services such as the Octet daemon, are denied by the kernel. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is set so telemetry and update checks do not need more hosts |
| Credentials | The agent gets the caller's environment minus anything named like a credential (`*TOKEN*`, `*SECRET*`, `*PASSW*`, `*API_KEY*`, `*_KEY`, `*SESSION*`, `AUTH*` but not `GIT_AUTHOR_*`), `AWS_*`, `OCTET_*` (except `OCTET_IDENTITY`), `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND` (it names a private key path) and `GNUPGHOME`. Kept on purpose: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`, because the agent cannot call the model without its own credential. A test dumps the sandboxed environment and checks all of this |
| Processes | The existing timeout and process-group kill, plus a memory ceiling (`memory_mb`, default 4096). macOS cannot enforce a per-process memory rlimit, so this is a watchdog: every 2 seconds it sums resident memory of the process group and kills the group when over, reporting `memoryExceeded` and a `sandbox.memory_exceeded` event |

**Audit.** Each run logs `sandbox.started` (hosts, ceiling, scratch dir). The proxy logs `sandbox.network_denied` per refused host. After the run, the kernel's denials are read back from the unified log (the profile stamps every denial with a per-run tag) and logged as one `sandbox.denied` event with the operation, target, process and count of each refusal, so a read of `~/.ssh/...` or a write outside the worktree shows up with its path. This is best effort: it waits about 1.5 seconds for the log to settle and records nothing if `/usr/bin/log` is unavailable. The benign background denials every macOS process produces (`/dev/dtracehelper`, a few Mach lookups) appear too; the list is capped at 100 entries.

**Evidence.**

- `packages/core/test/sandbox.test.ts` (skips cleanly where `sandbox-exec` is absent). The hostile engineer is a stand-in `claude` on `PATH`, run through the real runner and profile with a fake `HOME` holding canary files. Denied and checked: read of a `~/.ssh` canary, the Octet config and database canaries, another session's transcript, another worktree, another repo, the repository root; listing `~/.ssh` and another worktree; writes outside the worktree, into another worktree, into `HOME`, onto the SSH canary, into `.git/hooks`, `.git/config`, another branch's ref, the worktree's `HEAD`, and the `.git` pointer file; `git checkout` of another branch; a connection to a local HTTP server on `127.0.0.1` (directly and through the proxy; the server records zero hits); a connection to a non-allowed host (`evil.example.com`) and to a raw external IP. Controls that must still work: write in the worktree and in scratch, `git add`, `git commit`. Afterwards every canary is byte-identical with an unchanged mtime and nothing was created outside the worktree. The audit events are asserted, including the canary paths in `sandbox.denied` and `evil.example.com` in `sandbox.network_denied`.
- Also tested: environment contents, read-only seat, memory ceiling kill, `required` refusing to run (agent never executes), `auto` fallback event, config parsing, proxy tunnelling and SSRF refusal, `runBead` end to end with events in a verifying audit chain.
- **Live, real `claude` (v2.1.296), logged in on this machine.** `OCTET_LIVE=1 node --test packages/core/test/sandbox.test.ts` runs one prompt ("create hello.txt containing ok") under `mode = "required"`; it passed (about 10 s). During development the same profile was run on tiny prompts as engineer and as read-only reviewer (the Read tool read a file in the worktree).
- What the real login needed, found by removing each grant and watching for `Not logged in`: Claude Code keeps its OAuth login in the macOS keychain, so the profile must allow reading `~/Library/Keychains` (read-only is enough) and the Mach service `com.apple.SecurityServer`. It also writes a per-user temp directory (`/tmp/claude-<uid>`) unless `CLAUDE_CODE_TMPDIR` points elsewhere, which Octet sets to the scratch directory so the agent never sees other sessions' temp files.

**Limits: what this does not stop.**

1. **The agent's own model login.** With the keychain reachable, a sandboxed agent can ask the Security server for the `Claude Code-credentials` item (for example `security find-generic-password -w`) and may be able to read its OAuth token. The token is the agent's own and only works against the model API, but it is a credential. Removing this means `claude setup-token` and passing `CLAUDE_CODE_OAUTH_TOKEN` in the environment, then dropping the keychain grants; not done because it changes how you log in.
2. **Data the agent is allowed to read can leave through the allowed hosts.** The model API is reachable by design, and `allow_hosts` entries (an npm registry, say) accept uploads. A hostile agent can send the worktree's contents to them. The sandbox limits *which* secrets it can find, not what it does with what it can.
3. **The repository's git directory is readable**, so an agent can read every branch's history in that repository, and `<repo>/.git/config` (remote URLs, sometimes tokens embedded in them). Other repositories are not readable.
4. **Reads of `~/.claude` other than transcripts are open** (settings, plugins, skills). This matters: `~/.claude/settings.json` can hold secrets in its `env` block. On this machine it carries a bearer header for an OTLP telemetry endpoint, which a sandboxed agent can read (the proxy does refuse that host, and logged the attempt as `sandbox.network_denied` in the live run). Keep secrets out of `settings.json`, or start builders with `--setting-sources project,local` once you are happy to lose your user-level settings for them. Transcripts of other sessions are write-only; anything the agent writes there it cannot read back either, and Claude Code coped in every run tried.
5. **Metadata is visible.** The agent can learn that paths exist (`~/.ssh/id_ed25519` and its size) without reading them.
6. **Kernel and Seatbelt itself.** Sandbox escapes through a kernel bug, or through the Mach services allowed (`opendirectoryd`, `SecurityServer`, `cfprefsd`, `trustd`, `logd`, a few others), are out of scope. `sandbox-exec` is deprecated by Apple.
7. **Local services are unreachable, which can break work**: a test that starts a dev server and calls it over loopback fails, as do tools that need DNS directly (no resolver is allowed; DNS is done by the proxy). Package installs work only for hosts in `allow_hosts` and only for tools that honour `HTTPS_PROXY`.
8. **Toolchains under the home directory** (cargo, pyenv, a pnpm store) are unreadable until listed in `extra_read_paths`/`extra_write_paths`. The first run of a new language will probably need that.
9. **The memory watchdog is a poll**, 2 seconds apart, so a fast allocation can overshoot before it fires. Processes that leave the process group (`setsid`) escape it, though not the filesystem or network rules. There is no CPU or disk ceiling.
10. **Not covered at all**: the Octet daemon and CLI themselves, the Courier and Warden (they run outside the sandbox with real tokens by design), MCP servers (disabled for builders), Linux and Windows (`auto` runs unprotected there, with an event).
11. **Profile fragility.** Seatbelt filters match real paths and need an explicit list of what each tool touches. A new Claude Code release that reads a new path will fail loudly (denials are logged); widen `extra_read_paths` or fix the profile rather than turning the sandbox off.

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
| OpenTelemetry traces | Not started (§2.3) |
| MCP / ACP / A2A | Not started (§2.1, §2.2). A2A is only relevant if Octet ever talks to other orchestrators |
| Builder sandboxing | Built for macOS (§1, "As built"); Linux backend and the listed limits remain |
| Effort scaling | Designed (planning §5), not built |
| Audit head anchoring | Designed (vault §5), not built |
| Chair, Marshal, Architect, Scout | Designed (planning), not built |
