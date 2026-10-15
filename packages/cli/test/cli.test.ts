import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { completionScript, parseUsage } from '../src/completion.ts';
import { installLauncher, launcherText } from '../src/install.ts';

const MAIN = new URL('../src/main.ts', import.meta.url);
const USAGE = (readFileSync(MAIN, 'utf8').match(/const USAGE = `([\s\S]*?)`;/) ?? [])[1] ?? '';

test('the USAGE text in main.ts parses into the real command tree', () => {
  const t = parseUsage(USAGE);
  assert.ok(t.words.size >= 12, `found ${[...t.words.keys()].join(', ')}`);
  for (const g of ['identity', 'project', 'ask', 'request', 'goal', 'bead', 'approval', 'pr', 'audit', 'status', 'doctor', 'install', 'completion']) {
    assert.ok(t.words.has(g), `missing ${g}`);
  }
  assert.deepEqual([...t.words.get('approval')!].sort(), ['approve', 'deny', 'list']);
  assert.deepEqual([...t.words.get('completion')!].sort(), ['bash', 'zsh']);
  assert.ok(t.flags.get('bead run')!.has('--fake'));
  assert.ok(t.flags.get('project add')!.has('--identity'));
});

test('every command in the real USAGE appears in both completion scripts', () => {
  const t = parseUsage(USAGE);
  for (const shell of ['bash', 'zsh']) {
    const script = completionScript(shell, USAGE);
    for (const [group, subs] of t.words) {
      assert.ok(script.includes(group), `${shell}: ${group}`);
      for (const s of subs) assert.ok(script.includes(s), `${shell}: ${group} ${s}`);
    }
  }
});

test('a command added to USAGE shows up in completion without touching the generator', () => {
  const script = completionScript('bash', `${USAGE}\n  frobnicate now|later --loud      do a thing\n`);
  assert.match(script, /frobnicate\) subs='later now'; flags='--help --loud'/);
});

test('generated scripts are valid shell and complete real words', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-comp-'));
  const bashFile = join(dir, 'octet.bash');
  writeFileSync(bashFile, completionScript('bash', USAGE));
  execFileSync('bash', ['-n', bashFile]);
  const run = (words: string[], cword: number) => spawnSync('bash', ['-c',
    `source ${bashFile}; COMP_WORDS=(${words.join(' ')}); COMP_CWORD=${cword}; _octet; echo "\${COMPREPLY[*]}"`], { encoding: 'utf8' }).stdout.trim();
  assert.match(run(['octet', 'bea'], 1), /^bead$/);
  assert.match(run(['octet', 'bead', 'ru'], 2), /^run$/);
  assert.match(run(['octet', 'bead', 'run', 'x', '--f'], 4), /^--fake$/);
  assert.match(run(['octet', 'approval', ''], 2), /approve/);
  const zshFile = join(dir, '_octet');
  writeFileSync(zshFile, completionScript('zsh', USAGE));
  const zsh = spawnSync('zsh', ['-n', zshFile], { encoding: 'utf8' });
  if (!zsh.error) assert.equal(zsh.status, 0, zsh.stderr); // zsh is not installed on every CI runner
  assert.throws(() => completionScript('fish', USAGE), /Use: octet completion zsh\|bash/);
});

test('install creates the launcher in a temp dir, is idempotent, and never overwrites', () => {
  const home = mkdtempSync(join(tmpdir(), 'octet-home-'));
  const bin = join(home, '.local', 'bin');
  const main = '/some/where/main.ts';
  const first = installLauncher(bin, home, '/usr/bin', '/bin/zsh', main);
  assert.equal(first.status, 'created');
  assert.equal(readFileSync(join(bin, 'octet'), 'utf8'), launcherText(main));
  assert.equal(statSync(join(bin, 'octet')).mode & 0o111, 0o111, 'executable');
  assert.ok(first.lines.some((l) => l.includes('export PATH="$HOME/.local/bin:$PATH"')));
  assert.ok(first.lines.some((l) => l.includes('~/.zshrc')));
  assert.equal(first.onPath, false);

  const second = installLauncher(bin, home, `/usr/bin:${bin}`, '/bin/zsh', main);
  assert.equal(second.status, 'exists');
  assert.equal(second.onPath, true);
  assert.ok(!second.lines.some((l) => l.includes('export PATH')));

  writeFileSync(join(bin, 'octet'), '#!/bin/sh\necho mine\n');
  const third = installLauncher(bin, home, '/usr/bin', '', main);
  assert.equal(third.status, 'differs');
  assert.match(readFileSync(join(bin, 'octet'), 'utf8'), /echo mine/);
  assert.equal(existsSync(join(home, '.zshrc')), false, 'no rc file is created or edited');
});

test('the launcher actually runs the CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'octet-home-'));
  const bin = join(home, 'bin');
  installLauncher(bin, home, '', '', fileURLToPath(MAIN));
  const out = execFileSync(join(bin, 'octet'), ['completion', 'bash'], { encoding: 'utf8', env: { ...process.env, OCTET_HOME: home, OCTET_DATA: home } });
  assert.match(out, /complete -F _octet octet/);
});
