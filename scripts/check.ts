#!/usr/bin/env node
// Dependency-free source hygiene check, run by `pnpm check` and CI.
// Enforces: no tabs, no trailing whitespace, a final newline, and no console.log in packages/core/src
// (the core library returns data; printing belongs to the CLI and daemon).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|html|toml|yaml|yml)$/;
const SKIP = new Set(['pnpm-lock.yaml']);

export interface Finding {
  file: string;
  line: number;
  message: string;
}

/** Findings for one file's text. `file` decides which rules apply. */
export function checkText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (l.includes('\t')) out.push({ file, line: i + 1, message: 'tab character' });
    if (/[ \t\r]+$/.test(l)) out.push({ file, line: i + 1, message: 'trailing whitespace' });
    if (file.startsWith('packages/core/src/') && /\bconsole\.log\(/.test(l)) {
      out.push({ file, line: i + 1, message: 'console.log in packages/core/src' });
    }
  });
  if (text.length && !text.endsWith('\n')) out.push({ file, line: lines.length, message: 'missing final newline' });
  return out;
}

/** Every file git knows about (tracked, or untracked and not ignored), relative to the repo root. */
function files(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter((f) => f && TEXT.test(f) && !SKIP.has(f));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const findings = files(root).flatMap((f) => {
    try {
      return checkText(f, readFileSync(join(root, f), 'utf8'));
    } catch {
      return []; // listed by git but deleted in the working tree
    }
  });
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.message}`);
  console.log(findings.length ? `\n${findings.length} problem(s)` : 'check ok');
  process.exitCode = findings.length ? 1 : 0;
}
