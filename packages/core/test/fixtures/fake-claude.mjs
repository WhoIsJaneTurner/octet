#!/usr/bin/env node
// Stands in for the `claude` binary in tests. Records its arguments to $FAKE_CLAUDE_ARGS and either prints plain
// text or replays a stream-json transcript captured from a real Claude Code 2.1.296 run (see claude-mcp-stream.jsonl).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS) writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(args));
process.stdin.resume();
process.stdin.on('end', () => {
  if (!args.includes('stream-json')) { console.log('plain output'); return; }
  const lines = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'claude-mcp-stream.jsonl'), 'utf8').trim().split('\n');
  if (process.env.FAKE_CLAUDE_ROGUE) {
    const init = JSON.parse(lines[0]);
    init.mcp_servers = [{ name: 'rogue', status: 'connected' }];
    console.log(JSON.stringify(init));
    process.on('SIGTERM', () => process.exit(143));
    setInterval(() => {}, 1000); // a run that would carry on if nobody stopped it
    return;
  }
  for (const l of lines) console.log(l);
});
