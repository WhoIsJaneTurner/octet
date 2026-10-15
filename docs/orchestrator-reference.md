# A Well-Built Agent Orchestrator: Reference Design

A generalized specification for a local or self-hosted orchestrator that coordinates many AI agents on real work, with Octet as the worked example. It states the principles, the architecture, the controls and a conformance checklist, and cites the standards and published practice each one rests on.

**How to read the evidence.** Claims tagged **[S]** rest on a published specification or primary engineering post. Claims tagged **[P]** rest on practitioner or vendor write-ups and should be treated as good practice, not as a standard. Claims tagged **[O]** are this document's own design opinion. Several of the standards below are young. Where a spec's status is unsettled, that is noted so you verify before depending on it.

---

## 1. Purpose and scope

An orchestrator turns a request into delegated work, runs that work through agents safely, and returns results a human can trust. It does not itself do the work. It owns five things:

1. **Decomposition:** splitting a goal into units an agent can finish.
2. **Dispatch:** giving each unit to an agent with exactly the context and authority it needs.
3. **Isolation:** keeping concurrent work from colliding.
4. **Control:** deciding what each agent may do, and who must approve what.
5. **Record:** a durable, inspectable account of what happened and why.

Out of scope: the model itself, the editor, and the tools agents call. The orchestrator connects to these through open protocols (section 8).

---

## 2. Design principles

**P1. Prefer code over model for control flow.** Anthropic distinguishes *workflows* (LLMs and tools orchestrated through predefined code paths) from *agents* (LLMs dynamically directing their own process), and advises finding the simplest solution possible and adding complexity only when needed **[S]** ([Building effective agents](https://www.anthropic.com/research/building-effective-agents)). The 12-factor-agents methodology reaches the same place: most production agents are primarily deterministic software with LLM steps inserted at key decision points, not open-ended loops **[P]** ([12-Factor Agents](https://github.com/sahanatvessel/12-factor-agents)). *Applied:* the orchestrator's state machine, scheduling and policy are ordinary code. Models are used for judgment inside steps.

**P2. Orchestrator-workers fits unpredictable decomposition.** A central model breaks a task down at runtime and delegates to workers; the surrounding control flow is still developer-written code **[S/P]**. It suits multi-file code changes where the sub-steps cannot be known in advance.

**P3. Give each agent its own small context.** Subagents with separate context windows let work proceed in parallel without polluting one another, and the lead should persist its plan to memory because long runs can exceed the context window **[S]** ([How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)). 12-factor agents likewise names "own your context window" and "small, focused agents" as core factors **[P]**. *Applied:* every worker starts fresh with a written assignment, not a shared transcript.

**P4. Delegation briefs must be explicit.** The multi-agent post found that the lead must write detailed, unambiguous task descriptions covering objective, output format, tools and task boundaries, and that agents misjudge how much effort a task deserves **[S]**. *Applied:* a brief is a required, structured field, and the orchestrator scales effort rules (for example, one worker versus several) in code.

**P5. Be honest about cost and fit.** The same post reports multi-agent runs using roughly fifteen times the tokens of a chat interaction and being less effective for tightly interdependent tasks such as much coding work **[S]**. *Applied:* parallelize only independent units, express dependencies explicitly, and cap concurrency.

**P6. Enforce policy outside the model.** Controls that live in code cannot be talked out of firing; controls that live in a prompt can **[P]** ([Arthur: human-in-the-loop governance](https://www.arthur.ai/column/human-in-the-loop-governance-for-ai-agents)). *Applied:* permission checks, approvals and identity rules are deterministic, and a model may only summarize a pending decision for a human.

**P7. Least privilege, per task.** Both OWASP's agentic risk list and NIST-linked guidance converge on task-bounded access, runtime policy checks and short-lived credentials over standing entitlements **[P]** ([OWASP Agentic Top 10 overview](https://cycode.com/blog/owasp-top-10-agentic-applications/), [CSA on NIST's agent standards initiative](https://labs.cloudsecurityalliance.org/research/csa-research-note-nist-ai-agent-standards-initiative-complia/)). *Applied:* each role gets only the tools and credentials its job needs, and only for as long as it needs them.

**P8. Derive, don't store, display state.** Persist durable facts (what each agent last reported, what has merged) and compute labels like "needs input" at read time **[O]**. This prevents status from drifting out of sync with reality and makes recovery after a crash straightforward.

---

## 3. Reference architecture

```
        ┌─────────────── UI / CLI / chat (clients) ───────────────┐
        │   live view, approvals, diffs, audit, controls          │
        └───────────────────────────┬─────────────────────────────┘
                                    │  local API + event stream
┌───────────────────────────────────▼─────────────────────────────┐
│ DAEMON                                                          │
│  Planner/Scheduler ── Policy Engine (deterministic) ── Audit    │
│       │                      │                           log    │
│  Session Manager ── Workspace Manager ── Identity Resolver      │
│       │                      │                                  │
│  Agent Adapters        Git / worktrees          Store (SQLite)  │
└───────┬──────────────────────┬──────────────────────────────────┘
        │ stdio / JSON-RPC     │ isolated checkouts
   ┌────▼─────┐          ┌─────▼────────┐
   │ Agents   │          │ Tools (MCP)  │
   └──────────┘          └──────────────┘
```

### 3.1 Components

| Component | Responsibility | Octet today |
|---|---|---|
| **Planner / Scheduler** | Turns goals into units, tracks dependencies, enforces concurrency caps | Manual bead creation, dependency check in `runBead` |
| **Session manager** | Launches, supervises, resumes and stops agent processes | `ClaudeCodeRunner` behind an `AgentRunner` interface |
| **Workspace manager** | One isolated checkout per unit, cleaned up on completion | git worktrees under `.octet/` |
| **Policy engine** | Allow / deny / ask for every action, by role and context | `warden.ts` |
| **Identity resolver** | Maps each project to exactly one credential set; no default | `identity.ts` |
| **Store** | Durable facts plus an append-only event log | SQLite with an `events` table |
| **Event stream** | Pushes changes to clients | server-sent events |
| **Adapters** | One per agent type, behind a common interface | one (Claude Code) |

### 3.2 Roles

Separate roles by *authority*, not by prompt. A useful minimum set, and the one Octet uses:

| Role | Authority | Writes code | Model-driven |
|---|---|---|---|
| Intake (Chair) | Creates goals, talks to the human | No | Yes |
| Coordinator (Marshal) | Decomposes, dispatches, merges approved units | No | Yes |
| Planner (Architect) | Writes plans and specs only | No | Yes |
| Investigator (Scout) | Read-only exploration | No | Yes |
| Builder (Engineer) | Edits files inside one worktree | **Yes** | Yes |
| Reviewer | Approves or rejects units | No | Yes |
| Guard (Warden) | Decides allow / deny / ask | No | **No, deterministic** |
| Deliverer (Courier) | The only role that leaves the machine (push, PR) | No | Yes, gated |

The rule that makes this work: **exactly one role can write, exactly one can merge, exactly one can leave the machine.** Everything else is read-only. This is the least-privilege principle (P7) expressed as an org chart **[O]**.

---

## 4. Work model

- **Goal:** one deliverable on its own branch.
- **Unit of work (bead):** small enough for one builder and one reviewer to finish in a single pass.
- **Dependencies:** explicit edges; a unit cannot start until everything it depends on has merged.
- **States:** `todo → running → in_review → (changes_requested ↺ running) → merged`, plus `failed`. Transitions are enforced in code, and illegal ones (merging an unreviewed unit) are errors.
- **Branches:** goal branch from the default branch; unit branch from the goal branch; units merge into the goal branch, and only the deliverer moves the goal branch off the machine.

**Idempotency.** Every state transition and every external side effect should be safe to repeat. Durable-execution systems record each step and skip completed ones on replay, but replay does not remove the need for application-level idempotency keys on external actions, and model calls made outside a step boundary are where re-spend happens **[P]** ([Durable execution for AI agents compared](https://hackernoon.com/durable-execution-for-ai-agents-langgraph-dbos-inngest-and-temporal-compared)). A small event log plus a step wrapper on SQLite covers much of the need before adopting a workflow platform **[P]**. *Recommended:* start with the event log; adopt a durable-execution engine only when runs routinely outlive a daemon restart.

---

## 5. Isolation

1. **Filesystem:** one git worktree per unit. No two agents share a working directory.
2. **Credentials:** the child process environment is rebuilt per task. Inherited tokens and author variables from other identities are stripped, and only the project's identity is injected.
3. **Network and remote:** builders cannot push or open PRs. A guard compares a remote's owner to the project's account before any outbound action.
4. **Host:** the orchestrator's own API listens on loopback only, requires a per-session token, and rejects unexpected `Host` headers to defeat DNS rebinding **[O]**.
5. **Stronger sandboxing** (containers or OS sandboxes for the builder process) is the next tier and is recommended when agents run with broad permission modes.

---

## 6. Security and governance

### 6.1 Threat model

OWASP's Top 10 for Agentic Applications (published December 2025 by the OWASP GenAI Security Project) is the current reference list **[P: described via secondary write-ups; read the primary document]**. Two entries matter most to an orchestrator:

- **Agent goal hijack:** instructions injected into data an agent reads redirect its goal. NIST's CAISI frames this as indirect prompt injection and recommends adaptive, repeated testing, with task-specific results examined alongside aggregates **[P]**.
- **Tool misuse and exploitation (ASI02):** an agent uses a legitimate tool unsafely, through over-privileged tools, poisoned tool descriptions, or chains of tools whose combined effect nobody authorized. Mitigations: least-privilege tool scoping, treating tool descriptions as untrusted input, allowed-combination policies, and logging every call **[P]**.

### 6.2 Controls

| Control | Requirement |
|---|---|
| **Role-based policy** | Deterministic allow / deny / ask per role and action kind; deny by default |
| **Reversibility gating** | Approval is required before irreversible or outward-facing actions, not before every step. Over-gating produces rubber-stamping **[P]** |
| **Gate placement** | Do the preparation first, then ask: agent gathers, validates permissions, proposes, human approves, then execute, verify, log **[P]** |
| **Meaningful approvals** | Show the exact action, target, account and diff, not just a yes/no. Rejections feed back to the agent as feedback **[P]** |
| **Prompt-injection posture** | Treat all repository content, tool output and web content as untrusted data, never as instructions **[P]** |
| **Short-lived credentials** | Prefer per-task, expiring credentials to standing tokens **[P]** |

### 6.3 Audit log

A governance reference lists what to record: model decisions, tool calls with arguments and responses, human approvals and overrides with reviewer identity, outputs, and system state such as agent and model versions; stored append-only with cryptographic integrity checks and restricted access **[P]** ([Governance best practices](https://agentic-ai.readthedocs.io/en/latest/AIGovernance/governance-best-practices/)). Log *before* executing a risky action, since logging afterward documents an incident while logging before can stop it **[P]**. Hash-chain entries so tampering is detectable **[O]**, and where the stakes justify it keep a copy outside the agent's host. Retention depends on your regulatory context; verify it against your own obligations.

---

## 7. Observability

Use OpenTelemetry's GenAI semantic conventions so any backend can read your traces **[S, status: Development]** ([GenAI agent spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans)):

- `invoke_agent {name}`: one agent run, the root of a trace; a sub-agent's run nests under its caller.
- `execute_tool {name}`: one tool call, a child of the agent span.
- Agent attributes include `gen_ai.agent.name`, `gen_ai.agent.id` and `gen_ai.conversation.id`; tool spans carry `gen_ai.tool.name` and a call id; token usage sits on the model-call spans.
- **Content capture is opt-in.** Prompts, completions and tool arguments often contain sensitive data and should not be recorded by default.

These conventions were still marked "Development" as of mid-2026, so attribute names can change; isolate them behind one module. Beyond traces, track the orchestrator's own health: queue depth, time in each state, approval wait time, rework rate (units sent back), and cost per goal.

---

## 8. Interoperability standards

Build adapters to open protocols instead of proprietary hooks, so the orchestrator is not locked to one agent or editor.

| Concern | Standard | Notes |
|---|---|---|
| Agent ↔ tools and data | **Model Context Protocol (MCP)** | HTTP transports should follow the MCP authorization spec (OAuth 2.1 practices, RFC 8707 resource indicators, tokens only for their intended server); stdio transports take credentials from the environment instead **[S]** ([MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)). Several spec revisions exist, so pin the one you target. |
| Client ↔ coding agent | **Agent Client Protocol (ACP)** | JSON-RPC 2.0 over stdio, version negotiation and capability handshake at start, streaming responses; the client launches and drives the agent, and file access goes through protocol methods **[P]** ([ACP overview](https://agentic-ai.readthedocs.io/en/latest/Standards/agent-client-protocol/)). Not to be confused with the unrelated REST-based "Agent Communication Protocol". |
| Agent ↔ agent (across systems) | **Agent2Agent (A2A)** | Agent Card for discovery; task lifecycle `submitted → working → input-required → completed / failed / canceled / rejected`; HTTP, JSON-RPC 2.0 and SSE; Linux Foundation governance **[P]** ([reference implementation](https://github.com/a2aproject/A2A)). Sources disagree on the current spec version, so verify at a2a-protocol.org before implementing. |
| Project instructions | **AGENTS.md** | An open Markdown format giving coding agents project-specific build, test and style instructions; stewarded with MCP under the Linux Foundation's Agentic AI Foundation **[S/P]** ([announcement](https://openai.com/index/agentic-ai-foundation/)). *Applied:* inject the repo's AGENTS.md into every builder's assignment. |
| Telemetry | **OpenTelemetry GenAI** | See section 7. |

A2A's task lifecycle is a good model for your own unit states, since `input-required` is the "waiting on a human" state your UI needs **[O]**.

---

## 9. Identity and multi-account work

Real users work across several accounts. The orchestrator must make the wrong account impossible, not just unlikely **[O]**:

1. **No default identity.** A project without an explicit identity cannot start work.
2. **Identity profile** = author name and email, one SSH key, and one forge login. Applied through environment variables on every child process, never through the user's global git config.
3. **`IdentitiesOnly`.** Force the SSH client to offer only the project's key, otherwise an agent can silently present the wrong one.
4. **Remote ownership guard.** Before starting work and before any push, the remote's owner must match the identity's user or an explicitly listed organization.
5. **Credentials stay with the deliverer.** Builders hold no forge credentials.
6. **Verify on demand.** A `doctor` command checks each key and token against the forge.

---

## 10. Failure handling

| Failure | Behavior |
|---|---|
| Agent exits non-zero or produces no change | Unit marked `failed`, output tail recorded, can be re-run |
| Daemon restarts mid-run | On start, reconcile: running units with no live process become `failed` or are resumed; never silently stay "running" |
| Reviewer rejects | Unit moves to `changes_requested`; feedback is attached to the next assignment |
| Dependency fails | Dependents stay blocked and the reason is visible |
| Merge conflict | Surface to the coordinator or human; never auto-resolve silently |
| Approval pending too long | Time out to a visible state; do not proceed |
| Policy denial | Deny with a reason shown to the human; log it |

---

## 11. Conformance checklist

An orchestrator meets this reference if all of the following hold.

**Architecture**
- [ ] Control flow, scheduling and policy are deterministic code
- [ ] Each worker gets a fresh, bounded context and a structured brief
- [ ] Dependencies are explicit and enforced; concurrency is capped
- [ ] State transitions are validated; illegal ones error

**Isolation**
- [ ] One isolated workspace per unit of work
- [ ] Child environments are rebuilt per task; foreign credentials stripped
- [ ] API is loopback-only with a token and a Host check

**Control**
- [ ] Exactly one role writes, one merges, one leaves the machine
- [ ] Outward actions require approval; approvals show the exact action and target
- [ ] Policy decisions never depend on model output

**Identity**
- [ ] No default identity; a remote-ownership guard runs before work and before push

**Record**
- [ ] Append-only, hash-chained event log written before risky actions
- [ ] OpenTelemetry GenAI traces with content capture off by default
- [ ] Every approval records who approved what and when

**Interoperability**
- [ ] Agent adapters behind one interface; MCP for tools; ACP or equivalent for clients
- [ ] AGENTS.md honored; spec versions pinned

**Resilience**
- [ ] Restart reconciliation; idempotent external actions; visible failure states

---

## 12. Octet gap analysis

What Octet already satisfies and what it does not yet. This is the honest status as of this writing.

| Area | Status |
|---|---|
| Deterministic policy, one writer / one merger / one deliverer | Implemented (`warden.ts`), and unit-tested |
| No default identity, remote-owner guard, per-process environment rebuild | Implemented and tested |
| Worktree isolation, dependency gating, request-changes loop | Implemented and tested, including a real Claude run |
| Loopback API with token and Host check | Implemented and tested |
| Audit log | Implemented: SHA-256 hash-chained, verifiable from the CLI, API and UI header. Risky actions (merge, push, PR) log their intent before running. Tail truncation is detectable only against an externally stored head hash, which is not yet done |
| Approvals for outbound actions | Implemented: the Courier requests delivery, the human sees account, remote, branch and diffstat in the inbox, and push and PR happen only after approval. Deterministic, no model involved. Not yet tested against a real GitHub push |
| Restart reconciliation | Implemented for the daemon: beads left `running` are marked failed and logged on startup, and a re-run reuses the worktree. A CLI-run bead killed while no daemon starts is only recovered at the next daemon start |
| Locked repos and two-person review | Implemented: after delivery the goal is `delivered` and the PR's review decision and checks are tracked read-only. A required human review shows as waiting. An optional automated pre-review comment is posted only after approval, labeled as not an approval. Reviewing a teammate's PR is local and posts nothing. There is deliberately no path for Octet or one of the user's own accounts to satisfy a required review |
| Concurrency caps | Implemented: engineers (default 3) and active goals (default 3), configurable in `config.toml`. Effort scaling is not |
| AGENTS.md | Implemented: the repo's AGENTS.md is passed to builders as data, capped at 8,000 characters |
| OpenTelemetry traces | Implemented (roadmap 13): `invoke_agent` / `execute_tool` spans over OTLP/HTTP JSON, only when an endpoint is configured, content capture off. See hardening §2.4 |
| MCP / ACP / A2A | ACP client adapter and per-seat MCP allow-lists implemented (hardening §2.4), exercised only against fakes and one captured Claude Code run. A2A not started. Builders still run with MCP disabled unless the seat is allow-listed |
| Builder sandboxing beyond a denied-tools list | **Not implemented** (agents run with `acceptEdits`) |
| Architect, Scout, Reviewer, Marshal, Chair agents | Persona prompts exist; **no runtime**. The Courier is deterministic code, not a model |

Suggested order: store the audit head hash outside the database, a real end-to-end delivery test against a private repo, a Reviewer runtime, a second adapter via ACP, then OpenTelemetry and sandboxing.

---

## Sources and caveats

Primary or near-primary: Anthropic's [Building effective agents](https://www.anthropic.com/research/building-effective-agents) and [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) posts; the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization); the [OpenTelemetry GenAI agent spans spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans).

Secondary (treat as guidance): the OWASP agentic list as summarized by [Cycode](https://cycode.com/blog/owasp-top-10-agentic-applications/); NIST's CAISI and IR 8596 draft as summarized by the [Cloud Security Alliance](https://labs.cloudsecurityalliance.org/research/csa-research-note-nist-ai-agent-standards-initiative-complia/); the [12-factor agents](https://github.com/sahanatvessel/12-factor-agents) repository (a mirror of the original by HumanLayer); ACP, A2A, durable-execution and human-in-the-loop write-ups linked inline.

Search results did not include the full primary text of OWASP's list, NIST's drafts, or the A2A spec, so figures and field names from those should be checked against the originals. The OpenTelemetry GenAI and MCP conventions were still evolving, so pin versions.
