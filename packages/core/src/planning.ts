import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LIMITS, DEFAULT_PLANNING } from './config.ts';
import { OctetError } from './errors.ts';
import { commitAll } from './git.ts';
import { childEnv } from './identity.ts';
import { addBead, createGoal, projectInstructions, type Ctx } from './orchestrate.ts';
import { loadPersona } from './personas.ts';
import {
  effectiveSize, extractJson, renderPlan, renderScout, topoOrder, validateChair, validatePlan, validateScout, type ChairAssessment, type Plan,
  type PlanBead, type PlanLimits, type RequestSize, type ScoutReport, type Validated,
} from './plan.ts';
import { getProject, type Project } from './project.ts';
import type { SeatId } from './seats.ts';
import { newId, type Approval, type Bead, type Clarification, type Goal, type PlanRecord, type Request } from './store.ts';
import { openVault, Vault } from './vault.ts';

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/**
 * Quotes untrusted text for a prompt. The markers are what the personas tell the model to treat as data,
 * so any marker-like text inside is defanged: it cannot close the block early.
 */
export function dataBlock(label: string, text: string): string {
  const safe = text.replaceAll('<<<', '<‹<').replaceAll('>>>', '>›>');
  return `<<<DATA ${label}>>>\n${safe}\n<<<END DATA>>>`;
}

const planLimits = (ctx: Ctx): PlanLimits => ({
  maxBeads: ctx.planning?.maxBeads ?? DEFAULT_PLANNING.maxBeads,
  maxPoints: ctx.planning?.maxPoints ?? DEFAULT_PLANNING.maxPoints,
});

function projectOf(ctx: Ctx, name: string) {
  const project = getProject(ctx.projects, name);
  const identity = ctx.identities.find((i) => i.id === project.identity);
  if (!identity) throw new OctetError(`Project "${name}" names unknown identity "${project.identity}"`);
  return { project, identity };
}

/** The planning seats run read-only in the goal's worktree with the project identity's environment. */
async function ask(
  ctx: Ctx,
  a: { seat: SeatId; goal: Goal; prompt: string; persona?: SeatId },
): Promise<{ output: string; exitCode: number }> {
  const { identity } = projectOf(ctx, a.goal.project);
  const r = await ctx.runner.run({
    seat: a.seat, cwd: a.goal.worktree, prompt: a.prompt, systemPrompt: loadPersona(a.persona ?? a.seat),
    env: childEnv(identity), readOnly: true, timeoutMs: (ctx.limits ?? DEFAULT_LIMITS).runTimeoutMs,
  });
  return { output: r.output, exitCode: r.exitCode };
}

/**
 * Runs a seat and validates its JSON reply. A bad reply gets exactly one retry with the validator's errors
 * attached; a second failure fails the step visibly. Free text is never parsed for intent.
 */
export async function runStructured<T>(
  ctx: Ctx,
  a: { seat: SeatId; goal: Goal; prompt: string; validate: (raw: unknown) => Validated<T> },
): Promise<{ value: T; warnings: string[] }> {
  let prompt = a.prompt;
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await ask(ctx, { seat: a.seat, goal: a.goal, prompt });
    let errors: string[];
    if (r.exitCode !== 0) errors = [`The agent exited with code ${r.exitCode}: ${r.output.slice(-500)}`];
    else {
      try {
        const v = a.validate(extractJson(r.output));
        if (v.ok) return { value: v.value, warnings: v.warnings };
        errors = v.errors;
      } catch (e) {
        errors = [(e as Error).message];
      }
    }
    lastErrors = errors;
    ctx.store.log({ kind: 'planning.retry', goalId: a.goal.id, seat: a.seat, data: { attempt: attempt + 1, errors } });
    prompt = `${a.prompt}\n\n## Your previous reply was rejected\n${errors.map((e) => `- ${e}`).join('\n')}\n\nReply again with the corrected JSON object only.`;
  }
  throw new OctetError(`The ${a.seat} did not produce a valid reply after one retry: ${lastErrors.join('; ')}`);
}

const slugOf = (p: PlanRecord): string => p.vaultPath.replace(/^plans\//, '');

function vaultFor(ctx: Ctx, projectName: string): Vault {
  const { project, identity } = projectOf(ctx, projectName);
  return openVault(project, identity);
}

// ---------------------------------------------------------------------------------------------
// Architect and the plan gate
// ---------------------------------------------------------------------------------------------

function architectPrompt(ctx: Ctx, req: Request, goal: Goal, vault: Vault, assumptions: string[], feedback?: string, scout?: string, scoutFiles: string[] = []): string {
  const related = vault.relatedPlans({ title: req.title, files: scoutFiles }, 3);
  const pinned = vault.pinnedLessons();
  const rules = projectInstructions(goal.worktree);
  const limits = planLimits(ctx);
  return [
    `# Plan this request for project "${goal.project}"`,
    `Limits: at most ${limits.maxBeads} beads; sizes xs, s or m only.`,
    '', '## The request', dataBlock('request title', req.title), dataBlock('request body', req.body || '(no details given)'),
    ...(assumptions.length ? ['', '## Assumptions made so far (shown to the human with the plan)', ...assumptions.map((a) => `- ${a}`)] : []),
    ...(scout ? ['', '## Scout report', dataBlock('scout report', scout)] : []),
    ...(rules ? ['', '## Project instructions (AGENTS.md)', dataBlock('AGENTS.md', rules)] : []),
    ...(pinned.length ? ['', '## House rules (pinned notes)', ...pinned.map((l) => dataBlock(`lesson ${l.name}`, l.text))] : []),
    ...(related.length ? ['', '## Earlier plans that look related (for context only)',
      ...related.map((r) => dataBlock(`earlier plan ${r.slug} [${r.status}]`, `${r.title}\n${r.approach}\nFiles: ${r.files.join(', ')}`))] : []),
    ...(feedback ? ['', '## The human rejected the previous plan with this feedback; address it', feedback] : []),
  ].join('\n');
}

function planSummary(plan: Plan, rec: PlanRecord, warnings: string[]): Record<string, unknown> {
  return {
    action: 'Approve this plan and create its beads', planId: rec.id, version: rec.version, hash: rec.contentHash,
    vaultPath: rec.vaultPath, approach: plan.approach, assumptions: plan.assumptions, notDoing: plan.notDoing,
    risks: plan.risks, verification: plan.verification, warnings,
    beads: plan.beads.map((b) => ({
      id: b.id, title: b.title, size: b.size, dependsOn: b.dependsOn, files: b.files, objective: b.objective, acceptance: b.acceptance,
    })),
  };
}

/** Saves a validated plan as the next version, files an approval for it and marks the goal ready. */
function propose(ctx: Ctx, a: { goal: Goal; req: Request | undefined; vault: Vault; slug: string; plan: Plan; warnings: string[]; version: number; note: string }): PlanRecord {
  const { project, identity } = projectOf(ctx, a.goal.project);
  const planId = newId('plan');
  const saved = a.vault.savePlan(a.slug, a.plan, {
    planId, goalId: a.goal.id, project: project.name, identity: identity.id, version: a.version, status: 'awaiting_approval',
    title: a.goal.title, requestPath: a.req ? `requests/${a.slug}.md` : null,
  });
  const rec = ctx.store.insertPlan({
    id: planId, goalId: a.goal.id, requestId: a.req?.id ?? null, version: a.version, status: 'awaiting_approval',
    vaultPath: `plans/${a.slug}`, contentHash: saved.hash,
  });
  ctx.store.log({ kind: 'plan.saved', goalId: a.goal.id, seat: 'architect', data: { plan: rec.id, version: a.version, hash: saved.hash, redacted: saved.redacted } });
  if (saved.redacted) ctx.store.log({ kind: 'vault.redacted', goalId: a.goal.id, data: { plan: rec.id, count: saved.redacted } });
  a.vault.appendDecision(a.slug, `Plan v${a.version} proposed (${a.note}); waiting for approval. Hash ${saved.hash.slice(0, 12)}.`, `plan: awaiting approval v${a.version} (${a.slug})`);
  ctx.store.insertApproval({ kind: 'plan', goalId: a.goal.id, summary: planSummary(a.plan, rec, a.warnings) });
  ctx.store.setGoalStatus(a.goal.id, 'plan_ready');
  if (a.req) ctx.store.updateRequest(a.req.id, { status: 'planned' });
  return rec;
}

const nextVersion = (ctx: Ctx, goalId: string): number => Math.max(0, ...ctx.store.listPlans(goalId).map((p) => p.version)) + 1;

/** Failure leaves the goal in `planning`, logs why and asks you; re-running `planRequest` tries again. */
function planningFailed(ctx: Ctx, goal: Goal, e: unknown): never {
  const message = (e as Error).message;
  ctx.store.log({ kind: 'planning.failed', goalId: goal.id, seat: 'architect', data: { message } });
  ctx.store.escalate({ goalId: goal.id, reason: 'planning_failed', message });
  throw e;
}

/** Thrown by `planRequest` when the Chair needs answers first. Planning resumes when they are given. */
export class ClarificationNeeded extends OctetError {
  readonly clarification: Clarification;
  constructor(c: Clarification) {
    super(`The Chair has ${c.questions.length} question(s) before planning can start: ${c.questions.join(' | ')}`);
    this.clarification = c;
  }
}

const MAX_CLARIFY_ROUNDS = 2;

function chairPrompt(req: Request, goal: Goal, rounds: number): string {
  const rules = projectInstructions(goal.worktree);
  return [
    `# Assess this request for project "${goal.project}"`,
    '', dataBlock('request title', req.title), dataBlock('request body', req.body || '(no details given)'),
    ...(rules ? ['', dataBlock('AGENTS.md', rules)] : []),
    ...(rounds >= MAX_CLARIFY_ROUNDS ? ['', `You have already asked ${rounds} rounds of questions. Do not ask again: proceed and list what you assumed.`] : []),
  ].join('\n');
}

/** Chair: ask only when the answer would change what gets built; otherwise proceed with stated assumptions. */
async function chairAssess(ctx: Ctx, req: Request, goal: Goal): Promise<ChairAssessment> {
  const rounds = ctx.store.listClarifications(req.id).length;
  const { value } = await runStructured(ctx, { seat: 'chair', goal, validate: validateChair, prompt: chairPrompt(req, goal, rounds) });
  // Enough rounds: fold the unanswered questions into assumptions instead of asking forever.
  const out: ChairAssessment = value.action === 'clarify' && rounds >= MAX_CLARIFY_ROUNDS
    ? { ...value, action: 'proceed', assumptions: [...value.assumptions, ...value.questions.map((q) => `Unclear, assumed the simplest reading: ${q}`)], questions: [] }
    : value;
  const eff = effectiveSize(out.size, `${req.title}\n${req.body}`, ctx.planning?.bumpFiles ?? DEFAULT_PLANNING.bumpFiles);
  // Only a decision to proceed is remembered. Questions are not: once answered, the Chair looks again with the answers.
  if (out.action === 'proceed') ctx.store.log({ kind: 'chair.assessed', goalId: goal.id, seat: 'chair', data: { ...out, effectiveSize: eff.size, bumped: eff.reason, round: rounds } });
  return { ...out, size: eff.size };
}

/** The last stored assessment for a goal (a re-plan after feedback reuses it instead of asking again). */
function priorAssessment(ctx: Ctx, goalId: string): ChairAssessment | undefined {
  const e = ctx.store.lastGoalEvent('chair.assessed', goalId);
  if (!e) return undefined;
  const d = e.data as ChairAssessment & { effectiveSize: RequestSize };
  return { action: 'proceed', title: d.title, size: d.effectiveSize, questions: [], assumptions: d.assumptions };
}

/** Scout: reads the repository and reports what is true, including what it could not determine. */
async function scoutRun(ctx: Ctx, req: Request, goal: Goal, vault: Vault, slug: string, chair: ChairAssessment): Promise<ScoutReport> {
  const rules = projectInstructions(goal.worktree);
  const prompt = [
    `# Investigate before planning, for project "${goal.project}"`,
    chair.size === 'large' ? 'Be thorough: this request spans several areas.' : 'Keep it short: this is a small change.',
    '', dataBlock('request title', req.title), dataBlock('request body', req.body || '(no details given)'),
    ...(chair.assumptions.length ? ['', '## Assumptions so far', ...chair.assumptions.map((a) => `- ${a}`)] : []),
    ...(rules ? ['', dataBlock('AGENTS.md', rules)] : []),
  ].join('\n');
  const { value } = await runStructured(ctx, { seat: 'scout', goal, validate: validateScout, prompt });
  const saved = vault.saveScout(slug, value, { goalId: goal.id, title: goal.title });
  ctx.store.insertScout({ goalId: goal.id, vaultPath: `plans/${slug}`, contentHash: saved.hash });
  ctx.store.log({ kind: 'scout.saved', goalId: goal.id, seat: 'scout', data: { hash: saved.hash, files: value.relevantFiles.length, unknowns: value.unknowns.length, redacted: saved.redacted } });
  return value;
}

/** A trivial change skips the Scout and Architect: one bead, still shown at the plan gate as a one-line plan. */
function trivialPlan(req: Request, assumptions: string[]): Plan {
  return {
    approach: req.title,
    assumptions,
    notDoing: ['Anything beyond what the request asks for'],
    risks: [],
    verification: ['Read the diff and run the project\'s tests'],
    beads: [{
      id: 'b1', title: req.title, objective: req.body.trim() || req.title, files: [],
      acceptance: ['The change described in the request is made', 'Existing tests still pass'], outOfScope: [], dependsOn: [], size: 's',
    }],
  };
}

/**
 * Turns a routed request into a stored, approvable plan: Chair (ask or proceed, size), Scout (unless trivial),
 * Architect (or a one-bead plan when trivial). Creates the goal (status `planning`) on the first call; calling again
 * after a failure, a plain denial or answered questions continues from the same goal. Throws `ClarificationNeeded`
 * when the Chair has questions.
 */
export async function planRequest(ctx: Ctx, requestId: string, opts: { feedback?: string } = {}): Promise<PlanRecord> {
  const req = ctx.store.getRequest(requestId);
  if (!req) throw new OctetError(`Unknown request "${requestId}"`);
  if (req.status !== 'routed' && req.status !== 'planning') throw new OctetError(`Request ${requestId} is ${req.status}; only a routed request can be planned`);
  if (!req.project) throw new OctetError(`Request ${requestId} has no project; route it first`);
  const { project, identity } = projectOf(ctx, req.project);
  const vault = openVault(project, identity); // fails before anything is created if planning is off for the project

  let goal = req.goalId ? ctx.store.getGoal(req.goalId) : undefined;
  if (goal && ctx.store.listPlans(goal.id).some((p) => p.status === 'awaiting_approval')) {
    throw new OctetError(`Goal ${goal.id} already has a plan waiting for approval`);
  }
  if (goal && ctx.store.listClarifications(req.id).some((c) => !c.answers)) {
    throw new OctetError(`The Chair is still waiting for your answers on request ${requestId}`);
  }
  if (!goal) {
    goal = createGoal(ctx, { project: project.name, title: req.title, status: 'planning' });
    ctx.store.updateRequest(req.id, { status: 'planning', goalId: goal.id });
    ctx.store.log({ kind: 'request.planning', goalId: goal.id, seat: 'chair', data: { request: req.id } });
  } else {
    ctx.store.setGoalStatus(goal.id, 'planning');
    ctx.store.updateRequest(req.id, { status: 'planning' });
  }
  const current = ctx.store.getRequest(req.id)!; // answers may have been appended to the body
  const prior = ctx.store.listPlans(goal.id);
  const slug = prior.length ? slugOf(prior[0]!) : vault.planSlug(req.title);
  const saved = vault.saveRequest(slug, current);
  if (saved.redacted && !prior.length) ctx.store.log({ kind: 'vault.redacted', goalId: goal.id, data: { request: req.id, count: saved.redacted } });
  ctx.store.resolveEscalationsFor(goal.id);

  try {
    let chair = priorAssessment(ctx, goal.id);
    if (!chair) {
      const assessed = await chairAssess(ctx, current, goal);
      if (assessed.action === 'clarify') {
        const clar = ctx.store.insertClarification({ requestId: req.id, goalId: goal.id, round: ctx.store.listClarifications(req.id).length + 1, questions: assessed.questions });
        ctx.store.log({ kind: 'chair.clarify', goalId: goal.id, seat: 'chair', data: { clarification: clar.id, questions: clar.questions } });
        throw new ClarificationNeeded(clar);
      }
      chair = assessed;
    }

    if (chair.size === 'trivial') {
      ctx.store.log({ kind: 'planning.trivial', goalId: goal.id, seat: 'chair', data: { reason: 'one-bead plan, no Scout or Architect' } });
      return propose(ctx, { goal, req: current, vault, slug, plan: trivialPlan(current, chair.assumptions), warnings: [], version: nextVersion(ctx, goal.id), note: 'trivial change, single bead' });
    }

    let scout: ScoutReport | undefined;
    if (vault.has(`plans/${slug}/scout.json`)) scout = vault.readJson<ScoutReport>(`plans/${slug}/scout.json`);
    else scout = await scoutRun(ctx, current, goal, vault, slug, chair);

    const limits = { ...planLimits(ctx), ...(chair.size === 'small' ? { maxBeads: Math.min(3, planLimits(ctx).maxBeads) } : {}) };
    const { value: plan, warnings } = await runStructured(ctx, {
      seat: 'architect', goal, validate: (raw) => validatePlan(raw, limits),
      prompt: architectPrompt(ctx, current, goal, vault, chair.assumptions, opts.feedback, renderScout(scout, goal.title), scout.relevantFiles.map((f) => f.path)),
    });
    // The Chair's assumptions are approved with the plan even if the Architect did not repeat them.
    plan.assumptions = [...new Set([...chair.assumptions, ...plan.assumptions])];
    return propose(ctx, { goal, req: current, vault, slug, plan, warnings, version: nextVersion(ctx, goal.id), note: opts.feedback ? 'revised after feedback' : 'first draft' });
  } catch (e) {
    if (e instanceof ClarificationNeeded) throw e;
    return planningFailed(ctx, goal, e);
  }
}

/** Records your answers on the request and the vault. Planning resumes with `planRequest`. */
export function answerClarification(ctx: Ctx, clarificationId: string, answers: string[]): Request {
  const c = ctx.store.getClarification(clarificationId);
  if (!c) throw new OctetError(`Unknown clarification "${clarificationId}"`);
  if (c.answers) throw new OctetError(`Clarification ${clarificationId} was already answered`);
  if (answers.length !== c.questions.length || answers.some((a) => !a.trim())) throw new OctetError(`Answer all ${c.questions.length} question(s)`);
  const req = ctx.store.getRequest(c.requestId)!;
  const qa = c.questions.map((q, i) => `Q: ${q}\nA: ${answers[i]!.trim()}`).join('\n\n');
  if (!ctx.store.answerClarification(c.id, answers.map((a) => a.trim()))) throw new OctetError(`Clarification ${clarificationId} was already answered`);
  ctx.store.updateRequest(req.id, { body: `${req.body}${req.body ? '\n\n' : ''}## Answers to the Chair's questions (round ${c.round})\n${qa}` });
  ctx.store.log({ kind: 'chair.answered', goalId: c.goalId, data: { clarification: c.id, request: req.id } });
  return ctx.store.getRequest(req.id)!;
}

function pendingPlanApproval(ctx: Ctx, planId: string): Approval | undefined {
  return ctx.store.listApprovals().find((a) => a.kind === 'plan' && a.status === 'pending' && (a.summary as { planId?: string }).planId === planId);
}

function awaiting(ctx: Ctx, planId: string): { plan: PlanRecord; goal: Goal; vault: Vault; slug: string } {
  const plan = ctx.store.getPlan(planId);
  if (!plan) throw new OctetError(`Unknown plan "${planId}"`);
  if (plan.status !== 'awaiting_approval') throw new OctetError(`Plan ${planId} is ${plan.status}, not awaiting approval`);
  const goal = ctx.store.getGoal(plan.goalId)!;
  return { plan, goal, vault: vaultFor(ctx, goal.project), slug: slugOf(plan) };
}

/** Closes a plan's pending approval and marks the plan rejected, in the database and the vault. */
function closeRejected(ctx: Ctx, plan: PlanRecord, goal: Goal, vault: Vault, why: string): void {
  const appr = pendingPlanApproval(ctx, plan.id);
  if (appr) ctx.store.decideApproval(appr.id, 'denied');
  ctx.store.setPlanStatus(plan.id, 'rejected');
  ctx.store.log({ kind: 'plan.rejected', goalId: goal.id, seat: 'architect', data: { plan: plan.id, version: plan.version, hash: plan.contentHash, feedback: why } });
  vault.updatePlanMeta(slugOf(plan), plan.version, { status: 'rejected' });
  vault.appendDecision(slugOf(plan), `Plan v${plan.version} rejected${why ? `: ${why}` : ''}.`);
  vault.commit(`plan: rejected v${plan.version} (${slugOf(plan)})`);
  // Back to planning: the request can be planned again.
  ctx.store.setGoalStatus(goal.id, 'planning');
  if (plan.requestId) ctx.store.updateRequest(plan.requestId, { status: 'planning' });
}

/** Reject with feedback: the Architect plans again, and the next version waits for approval. */
export async function rejectPlan(ctx: Ctx, planId: string, feedback: string): Promise<PlanRecord> {
  if (!feedback.trim()) throw new OctetError('Feedback is required so the Architect knows what to change');
  const { plan, goal, vault } = awaiting(ctx, planId);
  closeRejected(ctx, plan, goal, vault, feedback.trim());
  if (!plan.requestId) throw new OctetError(`Plan ${planId} has no request to re-plan from`);
  return planRequest(ctx, plan.requestId, { feedback: feedback.trim() });
}

/**
 * Edit at the gate: the human changes the plan, it is re-validated, saved as a new version and approved
 * separately. The old version becomes superseded.
 */
export function editPlan(ctx: Ctx, planId: string, raw: unknown): PlanRecord {
  const { plan, goal, vault, slug } = awaiting(ctx, planId);
  const v = validatePlan(raw, planLimits(ctx));
  if (!v.ok) throw new OctetError(`The edited plan is not valid: ${v.errors.join('; ')}`);
  const appr = pendingPlanApproval(ctx, plan.id);
  if (appr) ctx.store.decideApproval(appr.id, 'denied');
  ctx.store.setPlanStatus(plan.id, 'superseded');
  vault.updatePlanMeta(slug, plan.version, { status: 'superseded' });
  vault.appendDecision(slug, `Plan v${plan.version} edited by the human; superseded.`);
  ctx.store.log({ kind: 'plan.edited', goalId: goal.id, data: { plan: plan.id, version: plan.version } });
  const req = plan.requestId ? ctx.store.getRequest(plan.requestId) : undefined;
  return propose(ctx, { goal, req, vault, slug, plan: v.value, warnings: v.warnings, version: nextVersion(ctx, goal.id), note: 'edited by the human' });
}

/** Called from `decideApproval` for plan approvals. Approve creates the beads; deny rejects the plan without a re-run. */
export function decidePlanApproval(ctx: Ctx, approvalId: string, decision: 'approve' | 'deny'): Approval {
  const approval = ctx.store.getApproval(approvalId)!;
  const planId = (approval.summary as { planId: string }).planId;
  if (approval.status !== 'pending') throw new OctetError(`Approval ${approvalId} was already decided`);
  const { plan, goal, vault, slug } = awaiting(ctx, planId);

  if (decision === 'deny') {
    closeRejected(ctx, plan, goal, vault, '');
    ctx.store.escalate({ goalId: goal.id, reason: 'plan_rejected', message: 'The plan was rejected without feedback. Re-plan the request with feedback, or abandon the goal.' });
    return ctx.store.getApproval(approvalId)!;
  }

  // The plan on disk must be exactly what was saved (and shown) before approval counts.
  const onDisk = vault.currentHash(slug, plan.version);
  if (onDisk !== plan.contentHash) tampered(ctx, goal, plan, onDisk);

  ctx.store.decideApproval(approvalId, 'approved');
  ctx.store.setPlanStatus(plan.id, 'approved');
  ctx.store.log({ kind: 'plan.approved', goalId: goal.id, seat: 'warden', data: { plan: plan.id, version: plan.version, hash: plan.contentHash } });
  vault.updatePlanMeta(slug, plan.version, { status: 'approved', approved_at: new Date().toISOString() });
  vault.appendDecision(slug, `Plan v${plan.version} approved. Hash ${plan.contentHash.slice(0, 12)}.`);
  vault.commit(`plan: approved v${plan.version} (${slug})`);
  ctx.store.setGoalStatus(goal.id, 'active');
  vault.anchorHead(ctx.store.chainHead(), `plan ${plan.id} approved`);
  decomposePlan(ctx, plan.id);
  return ctx.store.getApproval(approvalId)!;
}

/** The file on disk is not the plan that was saved. Stop the goal and say so. */
function tampered(ctx: Ctx, goal: Goal, plan: PlanRecord, onDisk: string | null): never {
  const message = onDisk === null
    ? `The file for plan ${plan.id} v${plan.version} is missing from the vault.`
    : `The plan on disk is not the plan that was saved (expected hash ${plan.contentHash.slice(0, 12)}, found ${onDisk.slice(0, 12)}). It was changed outside Octet.`;
  ctx.store.log({ kind: 'plan.tamper', goalId: goal.id, data: { plan: plan.id, version: plan.version, expected: plan.contentHash, found: onDisk } });
  ctx.store.setGoalPaused(goal.id, true);
  ctx.store.escalate({ goalId: goal.id, reason: 'plan_tamper', message });
  throw new OctetError(`${message} Nothing was approved or created. The goal is paused.`);
}

// ---------------------------------------------------------------------------------------------
// Marshal: decomposition
// ---------------------------------------------------------------------------------------------

/** The assignment an engineer receives: explicit objective, files, acceptance, exclusions and verification. */
export function briefFor(b: PlanBead, plan: Plan): string {
  const list = (l: string[]) => l.map((x) => `- ${x}`).join('\n');
  return [
    `Objective: ${b.objective}`,
    ...(b.files.length ? ['', 'Files likely involved (advisory):', list(b.files)] : []),
    '', 'Acceptance criteria:', list(b.acceptance),
    ...(b.outOfScope.length ? ['', 'Out of scope (do not do these):', list(b.outOfScope)] : []),
    '', 'How the whole goal will be verified (so you can check your part):', list(plan.verification),
    '', `Overall approach (context): ${plan.approach}`,
  ].join('\n');
}

/**
 * Marshal, part one: turns an approved plan into beads. Re-hashes the plan first; a mismatch stops the goal.
 * Idempotent: a plan that already has beads returns them instead of creating more.
 */
export function decomposePlan(ctx: Ctx, planId: string): Bead[] {
  const rec = ctx.store.getPlan(planId);
  if (!rec) throw new OctetError(`Unknown plan "${planId}"`);
  if (rec.status !== 'approved') throw new OctetError(`Plan ${planId} is ${rec.status}; only an approved plan can be decomposed`);
  const goal = ctx.store.getGoal(rec.goalId)!;
  const existing = ctx.store.listBeads(goal.id).filter((b) => b.planId === rec.id);
  if (existing.length) return existing;

  const { project, identity } = projectOf(ctx, goal.project);
  const vault = openVault(project, identity);
  const slug = slugOf(rec);
  const { plan, hash } = vault.readPlan(slug, rec.version);
  if (hash !== rec.contentHash) tampered(ctx, goal, rec, hash);
  // Defence in depth: the file hashed right, but make sure it still passes today's rules.
  const again = validatePlan(plan, planLimits(ctx));
  if (!again.ok) throw new OctetError(`Approved plan no longer validates: ${again.errors.join('; ')}`);

  const made: Bead[] = [];
  const realId = new Map<string, string>();
  for (const b of topoOrder(plan.beads)) {
    const bead = addBead(ctx, {
      goalId: goal.id, title: b.title, brief: briefFor(b, plan), dependsOn: b.dependsOn.map((d) => realId.get(d)!),
      planId: rec.id, planItem: b.id,
    });
    realId.set(b.id, bead.id);
    made.push(bead);
  }
  ctx.store.log({ kind: 'plan.decomposed', goalId: goal.id, seat: 'marshal', data: { plan: rec.id, beads: made.map((b) => ({ id: b.id, item: b.planItem })) } });
  vault.appendDecision(slug, `Plan v${rec.version} decomposed into ${made.length} bead(s): ${made.map((b) => b.id).join(', ')}.`);
  vault.updatePlanMeta(slug, rec.version, { beads: made.map((b) => b.id) }, `plan: decomposed v${rec.version} (${slug})`);

  if (project.vaultInRepo) copyPlanIntoRepo(ctx, project, goal, slug, plan, rec);
  return made;
}

/** Optional: the approved plan travels with the PR as a normal commit on the goal branch. */
function copyPlanIntoRepo(ctx: Ctx, project: Project, goal: Goal, slug: string, plan: Plan, rec: PlanRecord): void {
  const { identity } = projectOf(ctx, project.name);
  const dir = join(goal.worktree, 'docs', 'plans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), renderPlan(plan, goal.title));
  const done = commitAll(goal.worktree, `Add approved plan: ${goal.title}\n\nOctet plan ${rec.id} v${rec.version}`, childEnv(identity));
  if (done) ctx.store.log({ kind: 'plan.copied_to_repo', goalId: goal.id, seat: 'marshal', data: { path: `docs/plans/${slug}.md` } });
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

export interface PlanCheck { ok: boolean; checked: number; problems: { plan: string; problem: string }[] }

/**
 * Checks every plan against the hash recorded at save time and, for approved plans, against the hash in the
 * `plan.approved` audit event. A plan whose file changed since approval shows up here.
 */
export function verifyPlans(ctx: Ctx): PlanCheck {
  const problems: PlanCheck['problems'] = [];
  const approvedHash = new Map<string, string>();
  for (const e of ctx.store.eventsOfKind('plan.approved')) {
    const d = e.data as { plan: string; hash: string };
    approvedHash.set(d.plan, d.hash);
  }
  const plans = ctx.store.listPlans().filter((p) => p.status === 'approved' || p.status === 'awaiting_approval');
  for (const p of plans) {
    const goal = ctx.store.getGoal(p.goalId);
    const project = goal && ctx.projects.find((x) => x.name === goal.project);
    if (!project?.vault) { problems.push({ plan: p.id, problem: 'its project has no vault configured' }); continue; }
    const found = existsSync(project.vault) ? new Vault(project.vault).currentHash(slugOf(p), p.version) : null;
    if (found === null) problems.push({ plan: p.id, problem: 'plan file is missing from the vault' });
    else if (found !== p.contentHash) problems.push({ plan: p.id, problem: 'plan file changed after it was saved' });
    if (p.status === 'approved') {
      const a = approvedHash.get(p.id);
      if (!a) problems.push({ plan: p.id, problem: 'approved plan has no plan.approved event in the audit log' });
      else if (a !== p.contentHash) problems.push({ plan: p.id, problem: 'database hash differs from the hash in the audit log' });
    }
  }
  return { ok: problems.length === 0, checked: plans.length, problems };
}

