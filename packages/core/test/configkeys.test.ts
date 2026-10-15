import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkConfigDoc, loadGithubHosts, loadIntake, loadLimits, loadPlanning, loadReview } from '../src/index.ts';
import { parse } from 'smol-toml';

// Every key the loaders read must be known to the validator, or users get "unknown key" warnings for real settings.
const FULL = `
[limits]
max_engineers = 2
max_active_goals = 4
run_timeout_minutes = 30
[review]
auto = true
auto_merge = false
max_rounds = 3
goal_review = false
[planning]
max_beads = 8
max_points = 20
max_runs_factor = 4
max_retries = 0
cap_wait_minutes = 15
bump_files = 5
[github]
hosts = ["ghe.example.com"]
[intake.github]
enabled = true
label = "octet"
poll_seconds = 120
allowed_authors = ["me"]
projects = ["demo"]
[intake.jira]
enabled = true
site = "https://x.atlassian.net"
poll_seconds = 120
allowed_transitions = ["In Review"]
[intake.jira.projects.demo]
jql = "project = X"
[intake.chat]
enabled = true
allowed_users = ["U1"]
command = "/octet"
project = "demo"
inbox_url = "http://127.0.0.1:4747/"
`;

test('every documented config key is known to the validator and read by its loader', () => {
  assert.deepEqual(checkConfigDoc(parse(FULL) as Record<string, unknown>), []);
  const f = join(mkdtempSync(join(tmpdir(), 'octet-cfg-')), 'config.toml');
  writeFileSync(f, FULL);
  assert.deepEqual(loadLimits(f), { maxEngineers: 2, maxActiveGoals: 4, runTimeoutMs: 30 * 60_000 });
  assert.equal(loadReview(f).goalReview, false);
  assert.deepEqual(loadPlanning(f), { maxBeads: 8, maxPoints: 20, maxRunsFactor: 4, maxRetries: 0, capWaitMinutes: 15, bumpFiles: 5 });
  assert.deepEqual(loadGithubHosts(f), ['ghe.example.com']);
  assert.equal(loadIntake(f).chat.command, '/octet');
});
