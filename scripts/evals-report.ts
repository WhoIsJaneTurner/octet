// Prints eval results over time:   pnpm evals:report [results.jsonl]
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = process.argv[2] ?? join(process.env.OCTET_DATA ?? join(homedir(), '.local', 'share', 'octet'), 'evals', 'results.jsonl');
if (!existsSync(file)) {
  console.log(`No results yet at ${file}. Run: pnpm evals`);
  process.exit(0);
}
interface Row { at: string; promptHash: string; model: string; live: boolean; task: string; ok: boolean; ms: number; checks: { name: string; ok: boolean }[] }
const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
const tasks = [...new Set(rows.map((r) => r.task))];
console.log(`${rows.length} result(s) in ${file}\n`);
console.log(['when'.padEnd(20), 'prompts'.padEnd(13), 'model'.padEnd(12), ...tasks.map((t) => t.slice(0, 14).padEnd(15))].join(' '));
const runs = new Map<string, Row[]>();
for (const r of rows) runs.set(`${r.at.slice(0, 16)}|${r.promptHash}|${r.model}`, [...(runs.get(`${r.at.slice(0, 16)}|${r.promptHash}|${r.model}`) ?? []), r]);
for (const [key, rs] of runs) {
  const [at, hash, model] = key.split('|');
  console.log([at!.replace('T', ' ').padEnd(20), hash!.padEnd(13), (model ?? '').slice(0, 11).padEnd(12), ...tasks.map((t) => {
    const r = rs.find((x) => x.task === t);
    return (r ? (r.ok ? 'pass' : `FAIL(${r.checks.filter((c) => !c.ok).length})`) : '-').padEnd(15);
  })].join(' '));
}
