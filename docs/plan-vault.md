# The plan vault

Where plans, scout reports, decisions and outcomes live. A vault is a directory of plain files, readable by a human, diffable, and optionally a git repository of its own.

This design comes from the requirement "plans follow a vault" and is written generically. It does not copy any existing system.

## 1. Goals

- **Plans survive.** A restart, a new session or a context reset never loses a plan.
- **Human-readable and editable.** Markdown with front matter, openable in any editor or Obsidian-style tool.
- **Traceable.** From a PR you can reach the plan, the request and the review history, and the reverse.
- **Tamper-evident.** An approved plan cannot be changed afterwards without it showing.
- **Reusable.** Past plans and outcomes help later planning.
- **Private by default.** A vault can hold sensitive project detail. It is never pushed anywhere unless you configure that.

## 2. Location and configuration

A vault is per project, so each identity's work stays separate.

```toml
# ~/.config/octet/projects.toml
[projects.myapp]
path = "~/code/myapp"
identity = "wijt"
vault = "~/vaults/myapp"          # required to use planning; Octet creates it if missing
vault_git = true                  # commit vault changes, using this project's identity
vault_in_repo = false             # also copy approved plans to <repo>/docs/plans/ (see §8)
```

Defaults if unset: no vault, and planning is disabled for the project (it fails with a clear message rather than writing somewhere unexpected).

## 3. Layout

```
<vault>/
  README.md                      generated: what this vault is
  index.md                       generated: table of plans, newest first
  requests/
    2026-10-12-add-rate-limiting.md
  plans/
    2026-10-12-add-rate-limiting/
      request.md                 the request as received (verbatim, plus source and requester)
      scout.md                   Scout report rendered from JSON
      plan.v1.md                 rendered plan, version 1
      plan.v1.json               machine copy, the source of truth
      plan.v2.md                 revised after rejection or edit
      decisions.md               append-only: approvals, rejections, feedback, escalations
      outcome.md                 written after delivery: see §6
  lessons/
    caching.md                   optional topic notes, human or Octet authored
```

Naming: `YYYY-MM-DD-slug`; collisions get a numeric suffix.

## 4. File format

Every Markdown file starts with front matter that Octet reads and writes.

```markdown
---
octet: plan
id: plan-3fa91c
goal: add-rate-limiting-93fb2f
project: myapp
identity: wijt
version: 1
status: approved            # draft | awaiting_approval | approved | rejected | superseded
request: requests/2026-10-12-add-rate-limiting.md
created: 2026-10-12T21:04:11Z
approved_at: 2026-10-12T21:10:40Z
content_hash: 8c1f…         # SHA-256 of plan.v1.json
beads: [bead-9fa1e4, bead-3c9b23]
pr: https://github.com/…/pull/12
---
```

- The JSON file is the **source of truth**; the Markdown is rendered from it by code. Never ask a model to write the Markdown, so the two cannot drift.
- Links between files use relative paths, and `[[wiki-links]]` are tolerated for human edits but never relied on by Octet.
- IDs in front matter match the database ids.

## 5. Integrity and the audit chain

1. When a plan version is saved, Octet computes the SHA-256 of `plan.vN.json` and logs `plan.saved` with that hash. This lands in the existing hash-chained event log.
2. Approval logs `plan.approved` with the same hash.
3. Before the Marshal creates beads from a plan, it re-hashes the file and compares it to the approved hash. A mismatch stops the goal with an escalation: the plan on disk is not the plan you approved.
4. `octet audit verify` additionally checks every approved plan against its recorded hash.
5. Approved plans are never edited in place. A change is a new version (`plan.v2.*`), which must be approved again; the old one becomes `superseded`.

### Anchoring the head hash

The audit chain cannot detect truncation of its tail from inside the database. If `vault_git = true`, commit the chain head into the vault on every plan approval and delivery (a one-line `audit-head.txt`). Git history then acts as the external anchor, and a vault with a remote makes it stronger. This closes the gap noted in the reference doc.

## 6. Outcomes and lessons

After a goal is delivered or abandoned, Octet writes `outcome.md` from recorded data, not from model prose:

- What was planned versus what merged (bead list with final status).
- Review rounds per bead, escalations, retries.
- Files actually changed versus the plan's expected files.
- PR link, final review decision, checks.
- Elapsed time and, once available, token and cost totals.

Octet may then ask the Reviewer or Architect for a short **retro** (three bullets: what went well, what to do differently, what to tell the next planner). It is appended and clearly marked as model-written.

### Reuse

- The Scout and Architect receive a list of **related prior plans** from the same project: matched first by files touched, then by keywords in the title. Start with plain text search; add embeddings only if search proves inadequate.
- Prior plans and lessons are passed **as data**, inside the untrusted-data section of the prompt, like repository text. They inform; they do not instruct.
- A `lessons/` note can be flagged `pinned: true` to be included in every plan for the project (house rules such as "never touch the migrations directory without a migration").

## 7. Operations

- **Writes are atomic:** write to a temp file in the same directory, then rename.
- **One writer:** the daemon. The CLI calls through the same library code. File locking via a lock file with PID for the rare case both run.
- **Git:** one commit per state change (`plan: saved v1`, `plan: approved v1`, `outcome: …`), authored by the project's identity, never pushed automatically. A `vault_remote` setting is a later, approval-gated feature.
- **Size limits:** a plan over 200 KB is rejected; request bodies are capped at intake.
- **Secrets:** requests and Scout reports can contain pasted secrets. Run the existing redaction idea over text before writing it (patterns for common token formats); warn rather than silently drop.
- **Backups:** if `vault_git` is on, the vault is its own backup. Otherwise document a copy step.

## 8. Plans in the project repo (optional)

`vault_in_repo = true` copies the *approved* `plan.vN.md` into `<repo>/docs/plans/<slug>.md` on the goal branch, so the plan travels with the PR and a human reviewer can read it. It is a normal commit by the Marshal within the goal worktree, reviewed like any other change.

Trade-off: it puts planning detail into the repository's history. Default off for work where plans contain more than the code does.

## 9. Implementation checklist

- [ ] `vault.ts`: `openVault(project)`, `savePlan`, `saveScout`, `appendDecision`, `writeOutcome`, `verifyPlans`
- [ ] Atomic write helper and lock file
- [ ] Renderer: plan JSON to Markdown, scout JSON to Markdown, index and README
- [ ] Front matter reader and writer (a tiny YAML subset; do not add a heavy dependency)
- [ ] Hash recording in events; `plan.saved` and `plan.approved`; verify on Marshal start
- [ ] `octet audit verify` extension
- [ ] Git commits with the project identity; head hash anchoring
- [ ] Related-plan search (title, files, keywords)
- [ ] Redaction pass
- [ ] Tests: atomicity, tamper detection (edit an approved plan file, expect escalation), versioning and supersede, front matter round trip, related-plan search

## 10. Open decisions

1. **Vault location default.** One vault per project (recommended) or one shared vault with a folder per project. Per project keeps identities separate.
2. **Git remote for the vault.** Useful as an anchor and a backup, but it publishes planning detail. Keep it off until you decide.
3. **Plans in the repo** (§8): off by default.
4. **Embeddings for related-plan search.** Defer.
