export type BeadSize = 'xs' | 's' | 'm';
const SIZES: readonly string[] = ['xs', 's', 'm'];
const SIZE_POINTS: Record<BeadSize, number> = { xs: 1, s: 2, m: 4 };

export interface PlanBead {
  /** Plan-local id, e.g. "b1". Becomes a real bead id only at decomposition. */
  id: string;
  title: string;
  objective: string;
  /** Files expected to change. Advisory. */
  files: string[];
  acceptance: string[];
  outOfScope: string[];
  dependsOn: string[];
  size: BeadSize;
  /** Why this bead may edit a file another unordered bead also edits. Without it, shared files are an error. */
  sharedFilesNote?: string;
}

export interface Plan {
  approach: string;
  notDoing: string[];
  risks: string[];
  verification: string[];
  /** The Chair's assumptions, approved along with the plan. */
  assumptions: string[];
  beads: PlanBead[];
}

export interface ScoutReport {
  summary: string;
  relevantFiles: { path: string; why: string }[];
  conventions: string[];
  buildAndTest: string[];
  risks: string[];
  /** Mandatory: what the Scout could not determine. */
  unknowns: string[];
}

export interface PlanLimits {
  maxBeads: number;
  /** Sum of bead sizes (xs=1, s=2, m=4) a single goal may reach. */
  maxPoints: number;
}
export const DEFAULT_PLAN_LIMITS: PlanLimits = { maxBeads: 12, maxPoints: 36 };

export type Validated<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).map((x) => x.trim()).filter(Boolean) : null;

/** Unsafe or non-repo-relative path? */
export function badPath(p: string): string | null {
  if (!p.trim()) return 'is empty';
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return 'is absolute';
  const parts = p.split(/[\\/]/);
  if (parts.includes('..')) return 'escapes the repository';
  if (parts[0] === '.git' || parts[0] === '.octet') return 'is inside .git or .octet';
  return null;
}

/** Pulls the first JSON object out of a model reply: a fenced block, or the outermost braces. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter((c): c is string => !!c && c.trim().startsWith('{'));
  let lastErr = 'no JSON object found in the reply';
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (e) { lastErr = (e as Error).message; }
  }
  throw new Error(`Reply is not valid JSON: ${lastErr}`);
}

/**
 * The rules from planning-side §4.6. Errors are specific because they are sent back to the model for its one retry.
 * Unknown fields are ignored; missing ones are rejected. Accepts snake_case or camelCase for multiword keys.
 */
export function validatePlan(raw: unknown, limits: PlanLimits = DEFAULT_PLAN_LIMITS): Validated<Plan> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['The plan must be a JSON object'] };
  const pick = (o: Obj, snake: string, camel: string) => (o[snake] !== undefined ? o[snake] : o[camel]);

  const approach = typeof raw.approach === 'string' ? raw.approach.trim() : '';
  if (!approach) errors.push('"approach" is required and must be a non-empty string');
  const lists: Record<'notDoing' | 'risks' | 'verification' | 'assumptions', string[]> = { notDoing: [], risks: [], verification: [], assumptions: [] };
  const listKeys: [keyof typeof lists, string, boolean][] = [
    ['notDoing', 'not_doing', true], ['risks', 'risks', true], ['verification', 'verification', true], ['assumptions', 'assumptions', false],
  ];
  for (const [camel, snake, required] of listKeys) {
    const v = pick(raw, snake, camel);
    if (v === undefined && !required) continue;
    const l = strList(v);
    if (!l) errors.push(`"${snake}" must be an array of strings`);
    else lists[camel] = l;
  }
  if (!lists.notDoing.length && !errors.some((e) => e.includes('not_doing'))) errors.push('"not_doing" must state at least one thing deliberately left out');
  if (!lists.verification.length && !errors.some((e) => e.includes('verification'))) errors.push('"verification" must say how a human or CI checks that it worked');

  const beads: PlanBead[] = [];
  if (!Array.isArray(raw.beads) || raw.beads.length === 0) errors.push('"beads" must be a non-empty array');
  else {
    if (raw.beads.length > limits.maxBeads) errors.push(`Too many beads (${raw.beads.length}); the limit is ${limits.maxBeads}. Merge or drop some`);
    raw.beads.forEach((b: unknown, i: number) => {
      const at = `beads[${i}]`;
      if (!isObj(b)) return void errors.push(`${at} must be an object`);
      const id = typeof b.id === 'string' ? b.id.trim() : '';
      const title = typeof b.title === 'string' ? b.title.trim() : '';
      const objective = typeof b.objective === 'string' ? b.objective.trim() : '';
      if (!id || !/^[\w-]+$/.test(id)) errors.push(`${at}.id must be a short plain id like "b1"`);
      if (!title) errors.push(`${at}.title is required`);
      if (!objective) errors.push(`${at} (${id || title}) needs a non-empty "objective"`);
      const files = strList(b.files ?? []);
      if (!files) errors.push(`${at}.files must be an array of strings`);
      for (const f of files ?? []) {
        const why = badPath(f);
        if (why) errors.push(`${at}.files: "${f}" ${why}; use paths relative to the repository root`);
      }
      const acceptance = strList(b.acceptance);
      if (!acceptance?.length) errors.push(`${at} (${id || title}) needs at least one checkable "acceptance" statement`);
      const oos = strList(pick(b, 'out_of_scope', 'outOfScope') ?? []);
      if (!oos) errors.push(`${at}.out_of_scope must be an array of strings`);
      const deps = strList(pick(b, 'depends_on', 'dependsOn') ?? []);
      if (!deps) errors.push(`${at}.depends_on must be an array of strings`);
      const size = typeof b.size === 'string' ? b.size : '';
      if (size === 'l' || size === 'xl') errors.push(`${at} (${id || title}) is sized "${size}"; split it into beads no larger than "m"`);
      else if (!SIZES.includes(size)) errors.push(`${at}.size must be one of xs, s, m`);
      const note = pick(b, 'shared_files_note', 'sharedFilesNote');
      beads.push({
        id, title, objective, files: files ?? [], acceptance: acceptance ?? [], outOfScope: oos ?? [],
        dependsOn: deps ?? [], size: (SIZES.includes(size) ? size : 'm') as BeadSize,
        ...(typeof note === 'string' && note.trim() ? { sharedFilesNote: note.trim() } : {}),
      });
    });

    const ids = new Set<string>();
    for (const b of beads) {
      if (b.id && ids.has(b.id)) errors.push(`Duplicate bead id "${b.id}"`);
      ids.add(b.id);
    }
    const titles = new Set<string>();
    for (const b of beads) {
      const t = b.title.toLowerCase();
      if (b.title && titles.has(t)) errors.push(`Two beads are titled "${b.title}"; titles must be unique`);
      titles.add(t);
    }
    for (const b of beads) {
      for (const d of b.dependsOn) {
        if (!ids.has(d)) errors.push(`Bead "${b.id}" depends on "${d}", which does not exist`);
        if (d === b.id) errors.push(`Bead "${b.id}" depends on itself`);
      }
    }
    const cycle = findCycle(beads);
    if (cycle) errors.push(`Dependency cycle: ${cycle.join(' -> ')}`);

    const points = beads.reduce((n, b) => n + SIZE_POINTS[b.size], 0);
    if (points > limits.maxPoints) errors.push(`Total size is ${points} points; the ceiling is ${limits.maxPoints}. Cut scope or split into separate goals`);

    // Two beads on the same file with no ordering between them will conflict at merge time. That is an error unless
    // one of them says why it is fine (then it is shown at the gate as a warning).
    for (let i = 0; i < beads.length; i++) {
      for (let j = i + 1; j < beads.length; j++) {
        const a = beads[i]!, b = beads[j]!;
        const shared = a.files.filter((f) => b.files.includes(f));
        if (shared.length && !reaches(beads, a.id, b.id) && !reaches(beads, b.id, a.id)) {
          const note = a.sharedFilesNote ?? b.sharedFilesNote;
          if (note) warnings.push(`Conflict risk, justified: "${a.id}" and "${b.id}" both touch ${shared.join(', ')} (${note})`);
          else errors.push(`Beads "${a.id}" and "${b.id}" both edit ${shared.join(', ')} with no dependency between them; add depends_on so one follows the other, or give one a "shared_files_note" explaining why they can run in parallel`);
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { approach, ...lists, beads }, warnings };
}

function reaches(beads: PlanBead[], from: string, to: string, seen = new Set<string>()): boolean {
  if (seen.has(from)) return false;
  seen.add(from);
  const b = beads.find((x) => x.id === from);
  return !!b && b.dependsOn.some((d) => d === to || reaches(beads, d, to, seen));
}

function findCycle(beads: PlanBead[]): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of beads.find((b) => b.id === id)?.dependsOn ?? []) {
      const c = beads.some((b) => b.id === d) ? visit(d) : null;
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const b of beads) {
    const c = visit(b.id);
    if (c) return c;
  }
  return null;
}

/** Bead ids in an order where every bead follows its dependencies. Assumes the plan validated. */
export function topoOrder(beads: PlanBead[]): PlanBead[] {
  const out: PlanBead[] = [];
  const done = new Set<string>();
  while (out.length < beads.length) {
    const next = beads.filter((b) => !done.has(b.id) && b.dependsOn.every((d) => done.has(d)));
    if (!next.length) throw new Error('Dependency cycle');
    for (const b of next) { out.push(b); done.add(b.id); }
  }
  return out;
}

export function validateScout(raw: unknown): Validated<ScoutReport> {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['The report must be a JSON object'] };
  const pick = (snake: string, camel: string) => (raw[snake] !== undefined ? raw[snake] : raw[camel]);
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) errors.push('"summary" is required');
  const files = pick('relevant_files', 'relevantFiles');
  const relevantFiles: ScoutReport['relevantFiles'] = [];
  if (!Array.isArray(files)) errors.push('"relevant_files" must be an array of {path, why}');
  else files.forEach((f: unknown, i: number) => {
    if (!isObj(f) || typeof f.path !== 'string' || typeof f.why !== 'string') return void errors.push(`relevant_files[${i}] must be {path, why}`);
    const why = badPath(f.path);
    if (why) errors.push(`relevant_files[${i}].path "${f.path}" ${why}`);
    else relevantFiles.push({ path: f.path, why: f.why });
  });
  const conventions = strList(raw.conventions ?? []);
  const buildAndTest = strList(pick('build_and_test', 'buildAndTest') ?? []);
  const risks = strList(raw.risks ?? []);
  const unknowns = strList(raw.unknowns);
  if (!conventions) errors.push('"conventions" must be an array of strings');
  if (!buildAndTest) errors.push('"build_and_test" must be an array of strings');
  if (!risks) errors.push('"risks" must be an array of strings');
  if (!unknowns) errors.push('"unknowns" is mandatory and must be an array of strings (use [] only if nothing at all is unknown, which is rare)');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { summary, relevantFiles, conventions: conventions!, buildAndTest: buildAndTest!, risks: risks!, unknowns: unknowns! }, warnings: [] };
}

const bullets = (l: string[]): string => (l.length ? l.map((x) => `- ${x}`).join('\n') : '_none_');

export function renderPlan(plan: Plan, title: string): string {
  return [
    `# Plan: ${title}`, '',
    '## Approach', plan.approach, '',
    ...(plan.assumptions.length ? ['## Assumptions (approved with the plan)', bullets(plan.assumptions), ''] : []),
    '## Not doing', bullets(plan.notDoing), '',
    '## Risks', bullets(plan.risks), '',
    '## Verification', bullets(plan.verification), '',
    '## Beads',
    ...plan.beads.flatMap((b) => [
      '', `### ${b.id}: ${b.title} (${b.size})`,
      b.dependsOn.length ? `After: ${b.dependsOn.join(', ')}` : 'No dependencies',
      '', b.objective,
      ...(b.files.length ? ['', 'Files: ' + b.files.map((f) => `\`${f}\``).join(', ')] : []),
      ...(b.sharedFilesNote ? ['', `Shared files: ${b.sharedFilesNote}`] : []),
      '', 'Acceptance:', bullets(b.acceptance),
      ...(b.outOfScope.length ? ['', 'Out of scope:', bullets(b.outOfScope)] : []),
    ]), '',
  ].join('\n');
}

export function renderScout(r: ScoutReport, title: string): string {
  return [
    `# Scout report: ${title}`, '', r.summary, '',
    '## Relevant files', r.relevantFiles.length ? r.relevantFiles.map((f) => `- \`${f.path}\`: ${f.why}`).join('\n') : '_none_', '',
    '## Conventions', bullets(r.conventions), '',
    '## Build and test', bullets(r.buildAndTest), '',
    '## Risks', bullets(r.risks), '',
    '## Unknowns (what the Scout could not determine)', bullets(r.unknowns), '',
  ].join('\n');
}
