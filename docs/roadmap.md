# Octet roadmap: what is left to build

Status as of the end of the first build session. Start here, then read the detail docs:

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

Everything below is implemented, tested (113 unit and integration tests) and pushed to `WhoIsJaneTurner/octet`. Items marked "real run" were also exercised against Claude Code and, where noted, GitHub.

| Area | State |
|---|---|
| Identities | Named profiles (author, one SSH key, one `gh` login), no default, remote-owner guard, per-process environment rebuild, `identity doctor` |
| Work model | Goal (branch + worktree) → beads (worktree each, dependencies) → engineer run → review → merge. States: `todo`, `running`, `in_review`, `changes_requested`, `merged`, `failed` |
| Engineer | Real Claude Code run, headless, MCP disabled, push and PR commands denied, repo `AGENTS.md` passed as data (real run) |
| Reviewer | Read-only AI review with `APPROVE` or `CHANGES_REQUESTED`; rejections go back to the engineer; capped rounds then escalates; optional `auto` and `auto_merge` (real run) |
| Warden | Deterministic policy: one writer, one merger, one deliverer; wrong-account push refused |
| Courier | Delivery request, approval, push, PR, all write-ahead logged; PR state tracking; optional labelled pre-review comment (real run against GitHub) |
| Audit | SHA-256 hash chain, verify via CLI, API and UI |
| Caps | Concurrent engineers (3) and active goals (3), set in `config.toml` |
| Recovery | Heartbeat table; orphaned `running` beads are failed by a periodic sweep, not only at start. Cancel (UI, API, CLI, Ctrl-C), run timeout, per-run log files |
| Daemon | Loopback HTTP and SSE, per-session token, Host-header check, PR polling every 90 s |
| Intake | `requests` table (dedup on source + external ref, 20,000-char body cap), UI form, `octet ask`, route and decline from the inbox, all audited. Planning does not read them yet |
| Planning | Vault per project (plain files, atomic, locked, redacted, optional git with audit-head anchoring). Architect writes a validated JSON plan; plan gate in the inbox (approve, reject with feedback, edit); hash recorded in the audit chain and re-checked before beads are made; Marshal decomposition |
| Scheduler | Durable-state loop in the daemon: runs, reviews, retries, escalations, run ceiling, pause, autonomy per project (`manual`, `plan-gated`, `auto-to-pr`). Only touches goals made from an approved plan |
| UI | Green-screen React app: council, board, inbox, log, diff viewer, approvals |
| CLI | `identity`, `project`, `goal`, `bead`, `approval`, `pr`, `audit`, `status` |

### Seats

| Seat | Runtime |
|---|---|
| Engineer, Reviewer | Built |
| Warden, Courier | Built (deterministic code, no model) |
| Architect | Built (read-only, structured output, one retry) |
| Marshal | Built as code: decomposition and the scheduler. The optional model refinement pass is not built |
| Chair, Scout | Personas written; Chair is a stub (`size = small`, no questions) and there is no Scout runtime yet. Step 9 |

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
| 7 | Merge-conflict handling and stale-base rebasing | hardening §4 | M | Needed the moment two beads touch the same file |
| 8 | GitHub issue intake | intake §3 | M | First external source; read-only |
| 9 | Scout + Chair conversational intake (P4) | planning §6 | M | Better plans, fewer wrong guesses |
| 10 | Autonomy levels + planning evals (P5) | planning §8 | M | Makes quality measurable before trusting more autonomy |
| 11 | Jira and chat intake | intake §4, §5 | M each | Need credentials from you |
| 12 | Builder sandboxing | hardening §1 | L | Required before running on code you do not trust |
| 13 | Second agent adapter (ACP), MCP policy, OpenTelemetry | hardening §2 | L | Interoperability and observability |
| 14 | Desktop shell, packaging, CI | hardening §6 | M | Polish |

Steps 1 to 6 are the core. After step 6 the product matches the original picture.

---

## 3. State of this machine (cleanup and loose ends)

Things created during the first session that you may want to tidy.

| Item | Where | Action |
|---|---|---|
| Daemon still running | `127.0.0.1:4747` | `pkill -f packages/daemon/src/main.ts` |
| Test goals and beads | `~/.local/share/octet/octet.db` | Safe to delete the file to reset; it also holds the audit log |
| Throwaway repo | `WhoIsJaneTurner/octet-throwaway` (private), PR #1 | Delete on GitHub when finished. The PR was built from a fake engineer run and is junk by design |
| Local throwaway clone | the session scratchpad | Disposable |
| RILBound branches | `feat/repo-map-doc-d42f25`, `octet/repo-map-doc-d42f25/bead-a12c4a`, `.octet/` | From the RILBound folder: `git worktree remove --force .octet/worktrees/bead-a12c4a`, `git worktree remove --force .octet/worktrees/goal-repo-map-doc-d42f25`, then `git branch -D octet/repo-map-doc-d42f25/bead-a12c4a feat/repo-map-doc-d42f25` |
| CLI launcher | `~/.local/bin/octet` | Add `~/.local/bin` to PATH, or use `pnpm octet` |
| Identity files | `~/.config/octet/identities.toml`, `projects.toml` | Real config, outside the repo, never committed |
| Setup script | `octet/local/` (gitignored) | Holds your account details; keep out of the repo |
| Stale GitHub keys | `bioSandMan` account: `deepsync`, `jane_turner` | Left alone; remove if unused |

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
