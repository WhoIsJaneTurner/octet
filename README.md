# Octet

An eight-seat council of AI coding agents, run locally: Chair, Marshal, Architect, Scout, Engineer, Reviewer, Warden, Courier.

You describe what you want. Octet plans it, you approve the plan, agents build and review it in isolated git worktrees, and it stops at a delivery approval before anything is pushed or any PR is opened. Every outward action goes through the Warden, under the project's own GitHub identity, and every decision is written to a hash-chained audit log.

## Quick start

```bash
pnpm install
mkdir -p ~/.config/octet && cp identities.example.toml ~/.config/octet/identities.toml   # then edit
pnpm octet identity doctor                       # every key and gh login resolves to the account you meant
pnpm octet project add myapp ~/code/myapp --identity work --vault ~/vaults/myapp
pnpm octet doctor                                # node, git, gh, claude, config, database, audit chain
pnpm start                                       # daemon + UI on http://127.0.0.1:4747
```

In the UI: **New request** on the council view, then **PLAN** in the inbox. Approve the plan and the scheduler builds, reviews and (per the project's `autonomy`) merges the beads. You approve the delivery.

The same from the terminal:

```bash
pnpm octet ask myapp "Add rate limiting" --body "per IP, 100 req/min"
pnpm octet request plan <request>                # Chair, Scout, Architect; prints the plan to read
pnpm octet plan show <plan> && pnpm octet plan approve <plan>
pnpm octet status
pnpm octet goal deliver <goal>                   # asks; nothing is sent until you approve
pnpm octet approval approve <approval>
```

Manual mode still works: `goal new`, `bead add`, `bead run`, `bead review`, `bead approve`.

## Ideas worth knowing

- **No default identity.** Every project names one (author, SSH key, `gh` login). The Warden refuses a push to a remote the account does not own.
- **Two human gates.** The plan, and delivery. Autonomy per project: `manual`, `plan-gated` (default), `auto-to-pr`. No level skips either gate.
- **Agents are fenced.** Each runs read-only or in its own worktree, inside a macOS sandbox with no secrets, writes confined to the worktree and network limited to an allow-list.
- **Plans are files.** A per-project vault of Markdown and JSON; the approved plan's hash is in the audit chain and is re-checked before beads are made.
- **Request text is data.** Issues, tickets and chat messages are quoted into prompts as untrusted data and can never change a project, an identity or a gate.

## Commands

`pnpm octet --help` lists them all. `octet completion zsh|bash` prints a completion script; `octet install` creates the `octet` launcher.

## Docs

[docs/roadmap.md](docs/roadmap.md) is the place to start: what exists, what is verified against the real thing, and what is not. Then [planning-side](docs/planning-side.md), [plan-vault](docs/plan-vault.md), [intake-sources](docs/intake-sources.md), [hardening-and-gaps](docs/hardening-and-gaps.md) and the [reference design](docs/orchestrator-reference.md).

Requires Node 24+ and pnpm 11. `pnpm test`, `pnpm typecheck`, `pnpm check`. Live suites that call the real model are off by default: `pnpm evals` (planning quality), `OCTET_LIVE=1` (sandbox).
