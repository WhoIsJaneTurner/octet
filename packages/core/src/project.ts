import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { OctetError } from './errors.ts';
import { expandHome, getIdentity, type Identity } from './identity.ts';
import { projectsFile } from './paths.ts';

export interface Project {
  name: string;
  path: string;
  identity: string;
}

export function loadProjects(file: string = projectsFile()): Project[] {
  if (!existsSync(file)) return [];
  const doc = parse(readFileSync(file, 'utf8')) as {
    projects?: Record<string, { path?: string; identity?: string }>;
  };
  return Object.entries(doc.projects ?? {}).map(([name, t]) => {
    if (!t.path) throw new OctetError(`projects.${name}: missing "path"`);
    if (!t.identity) {
      throw new OctetError(`projects.${name}: missing "identity". Octet has no default identity.`);
    }
    return { name, path: expandHome(t.path), identity: t.identity };
  });
}

export function addProject(
  p: { name: string; path: string; identity: string },
  identities: Identity[],
  file: string = projectsFile(),
): Project {
  getIdentity(identities, p.identity);
  const path = resolve(expandHome(p.path));
  if (!existsSync(resolve(path, '.git'))) throw new OctetError(`${path} is not a git repository`);
  const existing = loadProjects(file);
  if (existing.some((e) => e.name === p.name)) throw new OctetError(`Project "${p.name}" already exists`);
  const next = [...existing, { name: p.name, path, identity: p.identity }];
  mkdirSync(dirname(file), { recursive: true });
  const projects = Object.fromEntries(next.map((e) => [e.name, { path: e.path, identity: e.identity }]));
  writeFileSync(file, stringify({ projects }) + '\n');
  return { name: p.name, path, identity: p.identity };
}

export function getProject(list: Project[], name: string): Project {
  const found = list.find((p) => p.name === name);
  if (!found) {
    throw new OctetError(`Unknown project "${name}". Known: ${list.map((p) => p.name).join(', ') || '(none)'}`);
  }
  return found;
}
