import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkConfigDoc, checkIdentitiesDoc, checkProjectsDoc, checkTomlText, loadLimits, loadProjects, loadReview, parseIdentities, parseToml,
} from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'octet-cfg-'));
const write = (name: string, text: string): string => {
  const f = join(dir, name);
  writeFileSync(f, text);
  return f;
};

test('a valid config.toml loads and sets the values', () => {
  const f = write('ok.toml', '[limits]\nmax_engineers = 5\nrun_timeout_minutes = 30\n[review]\nauto = true\nmax_rounds = 3\n[planning]\nmax_beads = 8\n');
  assert.equal(loadLimits(f).maxEngineers, 5);
  assert.equal(loadLimits(f).runTimeoutMs, 30 * 60_000);
  assert.deepEqual(loadReview(f), { auto: true, autoMerge: false, maxRounds: 3, goalReview: true });
});

test('a wrong type is an error naming the file, section and key', () => {
  const f = write('bad.toml', '[limits]\nmax_engineers = "three"\n[review]\nauto = "yes"\n');
  assert.throws(() => loadLimits(f), (e: Error) => {
    assert.ok(e.message.includes(f));
    assert.match(e.message, /\[limits\] max_engineers: expected a positive whole number, got "three"/);
    assert.match(e.message, /\[review\] auto: expected true or false/);
    return true;
  });
  assert.throws(() => loadLimits(write('zero.toml', '[limits]\nmax_engineers = 0\n')), /max_engineers/);
  assert.throws(() => loadReview(write('flt.toml', '[review]\nmax_rounds = 1.5\n')), /max_rounds/);
});

test('unknown keys and sections are warnings, not errors, and suggest the likely key', () => {
  const issues = checkConfigDoc(parseToml('[limits]\nmax_engineer = 2\nmax_engineers = 2\n[bogus]\nx = 1\n', 'c'));
  assert.deepEqual(issues.map((i) => i.level), ['warn', 'warn']);
  assert.match(issues[0]!.message, /did you mean "max_engineers"/);
  assert.match(issues[1]!.message, /unknown section/);
  // The file still loads.
  assert.equal(loadLimits(write('typo.toml', '[limits]\nmax_engineer = 2\n')).maxEngineers, 3);
});

test('a section that is not a table, and bad TOML, are errors that name the file', () => {
  assert.throws(() => loadLimits(write('notab.toml', 'limits = 3\n')), /\[limits\]: expected a table/);
  assert.throws(() => loadLimits(write('syntax.toml', '[limits\n')), /syntax\.toml: invalid TOML/);
});

test('nested intake sections are known', () => {
  assert.deepEqual(checkConfigDoc(parseToml('[intake.github]\nenabled = true\nlabel = "octet"\npoll_seconds = 300\nallowed_authors = ["a"]\n', 'c')), []);
  assert.match(checkConfigDoc(parseToml('[intake.github]\npoll_seconds = "x"\n', 'c'))[0]!.where, /intake\.github\] poll_seconds/);
});

test('projects.toml: types are checked, unknown keys warn, valid files keep loading', () => {
  assert.deepEqual(checkProjectsDoc(parseToml('[projects.a]\npath = "/x"\nidentity = "i"\nvault = "/v"\nvault_git = true\nautonomy = "manual"\n', 'p')), []);
  const issues = checkProjectsDoc(parseToml('[projects.a]\npath = 3\nidentity = "i"\nvualt = "/v"\nautonomy = "wild"\n', 'p'));
  assert.deepEqual(issues.map((i) => [i.level, i.where]), [
    ['error', '[projects.a] path'], ['warn', '[projects.a] vualt'], ['error', '[projects.a] autonomy'],
  ]);
  const good = write('projects.toml', '[projects.a]\npath = "/x"\nidentity = "i"\n');
  assert.equal(loadProjects(good)[0]!.name, 'a');
  assert.throws(() => loadProjects(write('projects2.toml', '[projects.a]\npath = 3\nidentity = "i"\n')), /projects2\.toml \[projects\.a\] path/);
});

test('identities.toml: wrong types are errors, the example shape still parses', () => {
  const good = '[identities.a]\nname="A"\nemail="a@x"\nssh_key="/k"\ngh_user="u"\nowners=["o"]\nsigning_key="/s"\n';
  assert.deepEqual(checkIdentitiesDoc(parseToml(good, 'i')), []);
  assert.equal(parseIdentities(good)[0]!.signingKey, '/s');
  assert.throws(() => parseIdentities(good.replace('owners=["o"]', 'owners="o"'), 'ids.toml'), /ids\.toml \[identities\.a\] owners: expected a list of strings/);
  assert.equal(checkTomlText('identities', '[identities.a]\nnmae = "x"\n', 'i')[0]!.level, 'warn');
  assert.equal(checkTomlText('config', '[limits', 'c')[0]!.level, 'error');
});
