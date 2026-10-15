import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { OctetError } from './errors.ts';
import { expandHome, getIdentity, type Identity } from './identity.ts';
import { projectsFile } from './paths.ts';

/** How far the scheduler may go on its own. No level skips the plan gate or the delivery gate. */
export type Autonomy = 'manual' | 'plan-gated' | 'auto-to-pr';
export const AUTONOMY_LEVELS: readonly Autonomy[] = ['manual', 'plan-gated', 'auto-to-pr'];

export interface Project {
  name: string;
  path: string;
  identity: string;
  /** Directory of plain files holding plans, reports and outcomes. Planning is off for the project without one. */
  vault?: string;
  /** Commit vault changes (as this project's identity) and anchor the audit head there. */
  vaultGit?: boolean;
  /** Also copy approved plans into <repo>/docs/plans/ on the goal branch. */
  vaultInRepo?: boolean;
  /** Defaults to `plan-gated`. */
  autonomy?: Autonomy;
}

export function loadProjects(file: string = projectsFile()): Project[] {
  if (!existsSync(file)) return [];
  const doc = parse(readFileSync(file, 'utf8')) as {
    projects?: Record<string, {
      path?: string; identity?: string; vault?: string; vault_git?: boolean; vault_in_repo?: boolean; autonomy?: string;
    }>;
  };
  return Object.entries(doc.projects ?? {}).map(([name, t]) => {
    if (!t.path) throw new OctetError(`projects.${name}: missing "path"`);
    if (!t.identity) {
      throw new OctetError(`projects.${name}: missing "identity". Octet has no default identity.`);
    }
    if (t.autonomy !== undefined && !AUTONOMY_LEVELS.includes(t.autonomy as Autonomy)) {
      throw new OctetError(`projects.${name}: autonomy must be one of ${AUTONOMY_LEVELS.join(', ')}`);
    }
    return {
      name, path: expandHome(t.path), identity: t.identity,
      ...(t.vault ? { vault: expandHome(t.vault) } : {}),
      ...(t.vault_git ? { vaultGit: true } : {}),
      ...(t.vault_in_repo ? { vaultInRepo: true } : {}),
      ...(t.autonomy ? { autonomy: t.autonomy as Autonomy } : {}),
    };
  });
}

export interface ProjectOptions {
  vault?: string;
  vaultGit?: boolean;
  vaultInRepo?: boolean;
  autonomy?: string;
}

function checkOptions(o: ProjectOptions): Pick<Project, 'vault' | 'vaultGit' | 'vaultInRepo' | 'autonomy'> {
  if (o.autonomy !== undefined && !AUTONOMY_LEVELS.includes(o.autonomy as Autonomy)) {
    throw new OctetError(`autonomy must be one of ${AUTONOMY_LEVELS.join(', ')}`);
  }
  return {
    ...(o.vault ? { vault: resolve(expandHome(o.vault)) } : {}),
    ...(o.vaultGit ? { vaultGit: true } : {}),
    ...(o.vaultInRepo ? { vaultInRepo: true } : {}),
    ...(o.autonomy ? { autonomy: o.autonomy as Autonomy } : {}),
  };
}

function saveProjects(list: Project[], file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const projects = Object.fromEntries(list.map((e) => [e.name, {
    path: e.path, identity: e.identity,
    ...(e.vault ? { vault: e.vault } : {}), ...(e.vaultGit ? { vault_git: true } : {}),
    ...(e.vaultInRepo ? { vault_in_repo: true } : {}), ...(e.autonomy ? { autonomy: e.autonomy } : {}),
  }]));
  writeFileSync(file, stringify({ projects }) + '\n');
}

export function addProject(
  p: { name: string; path: string; identity: string } & ProjectOptions,
  identities: Identity[],
  file: string = projectsFile(),
): Project {
  getIdentity(identities, p.identity);
  const path = resolve(expandHome(p.path));
  if (!existsSync(resolve(path, '.git'))) throw new OctetError(`${path} is not a git repository`);
  const existing = loadProjects(file);
  if (existing.some((e) => e.name === p.name)) throw new OctetError(`Project "${p.name}" already exists`);
  const project: Project = { name: p.name, path, identity: p.identity, ...checkOptions(p) };
  saveProjects([...existing, project], file);
  return project;
}

/** Changes a project's vault or autonomy settings. The path and identity are fixed once set. */
export function updateProject(name: string, patch: ProjectOptions, file: string = projectsFile()): Project {
  const list = loadProjects(file);
  const cur = getProject(list, name);
  const next: Project = { ...cur, ...checkOptions(patch) };
  saveProjects(list.map((e) => (e.name === name ? next : e)), file);
  return next;
}

export const autonomyOf = (p: Project): Autonomy => p.autonomy ?? 'plan-gated';

export function getProject(list: Project[], name: string): Project {
  const found = list.find((p) => p.name === name);
  if (!found) {
    throw new OctetError(`Unknown project "${name}". Known: ${list.map((p) => p.name).join(', ') || '(none)'}`);
  }
  return found;
}
