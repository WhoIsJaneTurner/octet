# Octet roadmap: what is left to build

Status as of the end of the second build session (every step in §2 is built). Start here, then read the detail docs:

| Doc | Covers |
|---|---|
| [planning-side.md](planning-side.md) | Chair, Scout, Architect, Marshal, the scheduler loop, autonomy levels |
| [intake-sources.md](intake-sources.md) | Requests from the UI, GitHub issues, Jira and chat |
| [plan-vault.md](plan-vault.md) | Plans, reports and outcomes stored as a vault of files |
| [hardening-and-gaps.md](hardening-and-gaps.md) | Safety, interoperability, correctness gaps, known bugs, packaging and tests |
| [orchestrator-reference.md](orchestrator-reference.md) | The standards-backed design Octet is measured against |

Effort sizes are rough: **S** is under half a day, **M** is one to two days, **L** is three days or more.

---

## 1. What exists today

Everything below is implemented and tested (about 320 unit and integration tests, plus gated live suites). Items marked "real run" were also exercised against the real Claude Code, and where noted GitHub; anything built against fakes only is called out in its row or in the step list below.

| Area | State |
|---|---|
| Identities | Named profiles (author, one SSH key, one `gh` login), no default, remote-owner guard, per-process environment rebuild, `identity doctor` |
| Work model | Goal (branch + worktree) → beads (worktree each, dependencies) → engineer run → review → merge. States: `todo`, `running`, `in_review`, `changes_requested`, `conflict`, `merged`, `failed`. A goal's own states: `planning`, `plan_ready`, `active`, `delivered`, `done`, `failed` |
| Engineer | Real Claude Code run, headless, inside a macOS Seatbelt sandbox (write confinement, no secrets, host allow-list, memory ceiling), MCP off unless allow-listed, push and PR commands denied, repo `AGENTS.md` passed as data (real run) |
| Reviewer | Read-only AI review with `APPROVE` or `CHANGES_REQUESTED`; rejections go back to the engineer; capped rounds then escalates; optional `auto` and `auto_merge` (real run) |
| Warden | Deterministic policy: one writer, one merger, one deliverer; wrong-account push refused |
| Courier | Delivery request, approval, push, PR, all write-ahead logged; PR state tracking; optional labelled pre-review comment (real run against GitHub) |
| Audit | SHA-256 hash chain, verify via CLI, API and UI |
| Caps | Concurrent engineers (3) and active goals (3), set in `config.toml` |
| Recovery | Heartbeat table; orphaned `running` beads are failed by a periodic sweep, not only at start. Cancel (UI, API, CLI, Ctrl-C; engineers and reviewers), run timeout, per-run log files (redacted), goal abandon and `octet gc`, token and cost per run with an optional daily ceiling |
| Daemon | Loopback HTTP and SSE, per-session token, Host-header check, PR polling every 90 s, one-daemon lock, scheduler, intake polling, projects.toml hot reload |
| Interop | ACP adapter per seat, MCP allow-lists per seat (tool calls audited), OpenTelemetry GenAI traces over OTLP/HTTP when configured |
| Ops | `octet doctor`, config validation, `octet install`, shell completion, commit signing per identity, CI workflow, `pnpm check`, gated browser smoke test |
| Intake | `requests` table (dedup on source + external ref, 20,000-char body cap), UI form, `octet ask`, route and decline from the inbox, all audited. Planning does not read them yet |
| Planning | Vault per project (plain files, atomic, locked, redacted, optional git with audit-head anchoring). Architect writes a validated JSON plan; plan gate in the inbox (approve, reject with feedback, edit); hash recorded in the audit chain and re-checked before beads are made; Marshal decomposition |
| Scheduler | Durable-state loop in the daemon: runs, reviews, retries, escalations, run ceiling, pause, autonomy per project (`manual`, `plan-gated`, `auto-to-pr`). Only touches goals made from an approved plan |
| UI | Green-screen React app: council, board, inbox (requests, questions, plans, escalations, approvals, intake), log, diff viewer, usage, projects and identity setup, help overlay |
| CLI | `identity`, `project`, `goal` (incl. `abandon`), `bead` (incl. `edit`, `delete`), `approval`, `pr`, `audit`, `gc`, `usage`, `status` |

### Seats

| Seat | Runtime |
|---|---|
| Engineer, Reviewer | Built |
| Warden, Courier | Built (deterministic code, no model) |
| Architect | Built (read-only, structured output, one retry) |
| Marshal | Built as code: decomposition and the scheduler. The optional model refinement pass is not built |
| Chair | Built: proceed-or-ask (at most three questions, two rounds), size with code-side bumping, trivial changes become a one-bead plan |
| Scout | Built: read-only, mandatory `unknowns`, report stored in the vault and fed to the Architect |

---

## 2. Recommended build order

Each step is shippable on its own and leaves the product working.

| # | Work | Doc | Size | Why this order |
|---|---|---|---|---|
| 1 | ~~Cancel a running bead; persist engineer output; orphan detection~~ **Done** (session two; leftovers in hardening §3) | hardening §3 | M | Today you cannot stop an agent, and output vanishes on restart. Fix before more autonomy |
| 2 | ~~Request model + typed intake in the UI and CLI~~ **Done** (session two; nothing consumes requests yet, the Architect in step 4 does) | intake §2 | S | Everything planning-side starts from a request |
| 3 | ~~Plan vault~~ **Done** | vault | M | Plans need somewhere to live before they are generated |
| 4 | ~~Architect + plan gate (P1)~~ **Done** | planning §6 | M | First time a typed request becomes a plan you approve |
| 5 | ~~Marshal decomposition + validation (P2)~~ **Done** (model refinement flag not built) | planning §6 | M | Plan becomes beads |
| 6 | ~~Scheduler loop (P3)~~ **Done**, with autonomy levels | planning §7 | L | The "describe it, approve the plan, come back to a PR" experience |
| 7 | ~~Merge-conflict handling and stale-base rebasing~~ **Done** | hardening §4 | M | Needed the moment two beads touch the same file |
| 8 | ~~GitHub issue intake~~ **Done** (tested against fakes only) | intake §3 | M | First external source; read-only |
| 9 | ~~Scout + Chair (P4)~~ **Done** (parallel Scouts and the free-text chat panel are not built) | planning §6 | M | Better plans, fewer wrong guesses |
| 10 | ~~Autonomy levels + planning evals (P5)~~ **Done** (autonomy shipped with the scheduler in step 6; evals in `packages/core/test/evals/`) | planning §8 | M | Makes quality measurable before trusting more autonomy |
| 11 | ~~Jira and chat intake~~ **Done** (Jira and Slack against fakes and local servers only; no write-back) | intake §4, §5 | M each | Need credentials from you |
| 12 | ~~Builder sandboxing~~ **Done** (macOS Seatbelt around the whole agent, default `auto`; limits listed in hardening §1) | hardening §1 | L | Required before running on code you do not trust |
| 13 | ~~Second agent adapter (ACP), MCP policy, OpenTelemetry~~ **Done** (ACP and OTLP against fakes and local servers only) | hardening §2 | L | Interoperability and observability |
| 14 | ~~Desktop shell, packaging, CI~~ **Done except the desktop shell, which is an unbuilt scaffold** (doctor, config validation, daemon lock, commit signing, PATH installer, completion, CI, check script, browser smoke test; see hardening §6) | hardening §6 | M | Polish |

Steps 1 to 6 are the core. After step 6 the product matches the original picture.

---

## 3. State of this machine (cleanup and loose ends)

| Item | Where | Action |
|---|---|---|
| Test goals and beads | `~/.local/share/octet/octet.db` (backed up as `.bak-vN` before each migration) | Safe to delete to reset; it also holds the audit log |
| Eval results | `~/.local/share/octet/evals/results.jsonl` | Keep for comparing runs; `pnpm evals:report` |
| RILBound branches | `feat/repo-map-doc-d42f25`, `octet/repo-map-doc-d42f25/bead-a12c4a`, `.octet/` | From the RILBound folder: `git worktree remove --force .octet/worktrees/bead-a12c4a`, `git worktree remove --force .octet/worktrees/goal-repo-map-doc-d42f25`, then `git branch -D` both branches. (`octet gc` can find stragglers of its own goals.) |
| CLI launcher | `~/.local/bin/octet` | `pnpm octet install` creates it and prints the PATH line |
| Identity files | `~/.config/octet/identities.toml`, `projects.toml` | Real config, outside the repo, never committed |
| Stale GitHub keys | `bioSandMan` account: `deepsync`, `jane_turner` | Left alone; remove if unused |
| `gh` token scopes | all three logins carry `admin:public_key` | See hardening §7.1 |
| `~/.claude/settings.json` | readable by sandboxed agents; holds an OTLP bearer header on this machine | Move secrets out, or deny the file in the sandbox profile (hardening §1 limits) |

---

## 4. Definition of done for "version 1"

Version 1 is reached when all of these hold on a real repo:

1. A request typed in the UI produces a stored plan, shown in the inbox.
2. Approving the plan creates beads without hand-writing any.
3. Beads run, are reviewed, and merge on their own within the caps, with rework loops that stop and escalate.
4. Delivery stops at your approval and opens a PR under the right account.
5. Nothing is stuck in `running` after a restart, and any run can be cancelled.
6. The audit chain verifies and the plan is recorded in it.
7. A scripted eval suite passes on throwaway repos.

### Status against this list

1. Request to stored plan in the inbox: built; exercised on the real model (evals, end-to-end run).
2. Approval creates beads: built and tested; exercised end to end.
3. Beads run, review and merge on their own within caps, with rework loops that stop and escalate: built and tested with scripted agents; exercised end to end on the real model on a small goal.
4. Delivery stops at your approval and opens a PR under the right account: delivery has run against real GitHub (session one); in session two the scheduler's path stops at the pending approval and was not approved.
5. Nothing stuck in `running`, everything cancellable: built and tested.
6. Audit chain verifies and records the plan: built and tested.
7. Scripted eval suite: `pnpm evals` passes on the real model; its scoring is tested without a model.

Not verified against the real thing: Jira, Slack, GitHub issue polling, GitHub Enterprise, ACP third-party agents, an OTLP backend, Electron shell, the CI workflow on GitHub.
