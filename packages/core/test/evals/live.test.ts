// Calls the real model. Off unless OCTET_EVALS=1:   pnpm evals
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ClaudeCodeRunner, dataHome } from '../../src/index.ts';
import { record, runTask, type EvalResult } from './harness.ts';
import { TASKS } from './tasks.ts';

const on = process.env.OCTET_EVALS === '1';
const results: EvalResult[] = [];

for (const task of TASKS) {
  test(`eval: ${task.name}`, { skip: !on && 'set OCTET_EVALS=1 to run (calls the real model)', timeout: 15 * 60_000 }, async () => {
    const r = await runTask(task, new ClaudeCodeRunner());
    results.push(r);
    const failed = r.checks.filter((c) => !c.ok);
    assert.deepEqual(failed, [], `${task.name}: ${failed.map((c) => `${c.name} (${c.detail ?? ''})`).join('; ')}`);
  });
}

after(() => {
  if (on && results.length) record(results, process.env.OCTET_EVALS_OUT ?? join(dataHome(), 'evals', 'results.jsonl'), { model: process.env.OCTET_EVAL_MODEL ?? 'default', live: true });
});
