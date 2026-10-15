#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  addBead, addProject, approveBead, buildRunner, cancelBead, createGoal, dbFile, decideApproval, getIdentity,
  ghToken, loadIdentities, loadLimits, loadProjects, loadReview, OctetError, rejectRequest, routeRequest, runsDir, submitRequest, refreshAllPrs, requestDelivery, requestPrecomment, reviewBead, reviewExternalPr, runBead, sshWhoAmI, Store, type Ctx,
} from '@octet/core';

const USAGE = `octet <command>

  identity list                     show configured identities
  identity doctor                   verify each identity's SSH key and gh login
  project add <name> <path> --identity <id>
  project list
  ask <project> <title> [--body <text>]   file a request (a project is required here)
  request list                      requests and where they stand
  request route <id> <project>      pick the project for an unrouted request
  request reject <id> <reason>      decline a request; nothing else is created
  goal new <project> <title>
  goal list
  bead add <goal> <title> --brief <text> [--after <bead>]...
  bead run <bead> [--fake]          build a bead with an Engineer
  bead cancel <bead>                stop a running engineer (works while the daemon or another shell runs it)
  bead review <bead>                have the Reviewer read the diff and give a verdict
  bead approve <bead>               merge a reviewed bead into its goal branch
  goal deliver <goal>               ask to push + open a PR (nothing is sent yet)
  approval list                     delivery approvals
  approval approve|deny <id>        decide one; approve pushes and opens the PR
  pr status                         PRs this tool opened: review state and checks
  pr prereview <goal>               draft an automated comment for your teammate (asks you first)
  pr review <url> --identity <id>   read someone else's PR and give you a verdict (posts nothing)
  audit verify                      check the audit log's hash chain
  status                            goals, beads and recent events

There is no default identity: every project must name one.`;

/** Runners built by makeCtx; flushed once when the command finishes so buffered trace spans are sent. */
const runners: { shutdown(): Promise<void> }[] = [];

function makeCtx(fake: boolean): Ctx {
  const store = new Store(dbFile());
  const bundle = buildRunner({ store, fake });
  runners.push(bundle);
  return {
    store,
    identities: loadIdentities(),
    projects: loadProjects(),
    runner: bundle.runner,
    limits: loadLimits(),
    review: loadReview(),
    runsDir: runsDir(),
  };
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      identity: { type: 'string' },
      brief: { type: 'string' },
      body: { type: 'string' },
      after: { type: 'string', multiple: true },
      fake: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [group, cmd, ...rest] = positionals;
  if (values.help || !group) return void console.log(USAGE);

  if (group === 'identity') {
    const ids = loadIdentities();
    if (cmd === 'list') {
      for (const i of ids) console.log(`${i.id.padEnd(10)} ${i.ghUser.padEnd(18)} ${i.email}`);
      return;
    }
    if (cmd === 'doctor') {
      let bad = 0;
      for (const i of ids) {
        const who = sshWhoAmI(i);
        const sshOk = who?.toLowerCase() === i.ghUser.toLowerCase();
        let tokenOk = true;
        try { ghToken(i); } catch { tokenOk = false; }
        if (!sshOk || !tokenOk) bad++;
        console.log(`${sshOk && tokenOk ? 'ok  ' : 'FAIL'} ${i.id}: ssh=${who ?? 'no auth'} (want ${i.ghUser}), gh token=${tokenOk ? 'yes' : 'no'}`);
      }
      process.exitCode = bad ? 1 : 0;
      return;
    }
  }

  if (group === 'project') {
    if (cmd === 'add') {
      const [name, path] = rest;
      if (!name || !path) throw new OctetError('usage: project add <name> <path> --identity <id>');
      const ids = loadIdentities();
      getIdentity(ids, values.identity);
      const p = addProject({ name, path, identity: values.identity! }, ids);
      return void console.log(`added ${p.name} -> ${p.path} as ${p.identity}`);
    }
    if (cmd === 'list') {
      for (const p of loadProjects()) console.log(`${p.name.padEnd(16)} ${p.identity.padEnd(10)} ${p.path}`);
      return;
    }
  }

  if (group === 'ask') {
    // `ask` has no subcommand: the first word is the project, the rest is the title.
    const [project, ...title] = [cmd, ...rest];
    if (!project || !title.length) throw new OctetError('usage: ask <project> <title> [--body <text>]');
    const { request } = submitRequest(makeCtx(true), {
      source: 'cli', project, title: title.join(' '), body: values.body ?? '', requester: process.env.USER ?? 'cli',
    });
    return void console.log(`request ${request.id} [${request.status}] -> ${request.project}`);
  }

  if (group === 'request') {
    const ctx = makeCtx(true);
    if (cmd === 'list') {
      for (const r of ctx.store.listRequests()) {
        console.log(`${r.id.padEnd(12)} ${r.status.padEnd(9)} ${r.source.padEnd(6)} ${(r.project ?? '(unrouted)').padEnd(14)} ${r.title}${r.rejectReason ? `  [rejected: ${r.rejectReason}]` : ''}`);
      }
      return;
    }
    if (cmd === 'route') {
      const [id, project] = rest;
      if (!id || !project) throw new OctetError('usage: request route <id> <project>');
      const r = routeRequest(ctx, id, project);
      return void console.log(`request ${r.id}: routed to ${r.project}`);
    }
    if (cmd === 'reject') {
      const [id, ...reason] = rest;
      if (!id || !reason.length) throw new OctetError('usage: request reject <id> <reason>');
      return void console.log(`request ${rejectRequest(ctx, id, reason.join(' ')).id}: rejected`);
    }
  }

  if (group === 'goal') {
    if (cmd === 'new') {
      const [project, ...title] = rest;
      if (!project || !title.length) throw new OctetError('usage: goal new <project> <title>');
      const ctx = makeCtx(true);
      const g = createGoal(ctx, { project, title: title.join(' ') });
      return void console.log(`goal ${g.id}\n  branch   ${g.branch}\n  worktree ${g.worktree}`);
    }
    if (cmd === 'deliver') {
      const [id] = rest;
      if (!id) throw new OctetError('usage: goal deliver <goal>');
      const a = requestDelivery(makeCtx(true), id);
      const s = a.summary;
      console.log(`approval ${a.id} is waiting for you. If approved, Octet will:\n  push ${String(s.branch)} to ${String(s.remote)}\n  as ${String(s.identity)} (${String(s.account)}), then open a PR into ${String(s.base)}\n${String(s.diffstat)}\nDecide with: octet approval approve ${a.id}   (or deny)`);
      return;
    }
    if (cmd === 'list') {
      for (const g of new Store(dbFile()).listGoals()) console.log(`${g.id.padEnd(30)} ${g.status.padEnd(8)} ${g.title}`);
      return;
    }
  }

  if (group === 'bead') {
    if (cmd === 'add') {
      const [goalId, ...title] = rest;
      if (!goalId || !title.length || !values.brief) throw new OctetError('usage: bead add <goal> <title> --brief <text>');
      const b = addBead(makeCtx(true), { goalId, title: title.join(' '), brief: values.brief, dependsOn: values.after ?? [] });
      return void console.log(`bead ${b.id}  ${b.title}`);
    }
    if (cmd === 'run') {
      const [id] = rest;
      if (!id) throw new OctetError('usage: bead run <bead> [--fake]');
      // Ctrl-C stops the agent cleanly and records the cancel instead of orphaning the run.
      const ac = new AbortController();
      process.once('SIGINT', () => ac.abort());
      const b = await runBead(makeCtx(Boolean(values.fake)), id, (t) => process.stdout.write(t), { signal: ac.signal });
      console.log(`\nbead ${b.id}: ${b.status}`);
      process.exitCode = b.status === 'in_review' ? 0 : 1;
      return;
    }
    if (cmd === 'cancel') {
      const [id] = rest;
      if (!id) throw new OctetError('usage: bead cancel <bead>');
      cancelBead(makeCtx(true), id);
      return void console.log(`cancel requested for ${id}; the process running it stops within a few seconds`);
    }
    if (cmd === 'review') {
      const [id] = rest;
      if (!id) throw new OctetError('usage: bead review <bead> [--fake]');
      const r = await reviewBead(makeCtx(Boolean(values.fake)), id);
      console.log(`${r.feedback}\n\nverdict: ${r.verdict}; bead is now ${r.bead.status}`);
      return;
    }
    if (cmd === 'approve') {
      const [id] = rest;
      if (!id) throw new OctetError('usage: bead approve <bead>');
      return void console.log(`bead ${approveBead(makeCtx(true), id).id}: merged`);
    }
  }

  if (group === 'approval') {
    const store = new Store(dbFile());
    if (cmd === 'list') {
      for (const a of store.listApprovals()) console.log(`${a.id.padEnd(12)} ${a.status.padEnd(9)} ${a.goalId}  ${String(a.summary.remote)}`);
      return;
    }
    if ((cmd === 'approve' || cmd === 'deny') && rest[0]) {
      const a = decideApproval({ ...makeCtx(true), store }, rest[0], cmd);
      return void console.log(`approval ${a.id}: ${a.status}`);
    }
  }

  if (group === 'pr') {
    if (cmd === 'status') {
      const ctx = makeCtx(true);
      try { refreshAllPrs(ctx); } catch (e) { console.error(`refresh failed: ${(e as Error).message}`); }
      for (const p of ctx.store.listPrs()) {
        console.log(`${p.state.padEnd(7)} review=${(p.reviewDecision || 'none').padEnd(18)} checks=${p.checks.padEnd(8)} ${p.url}`);
      }
      return;
    }
    if (cmd === 'prereview' && rest[0]) {
      const a = await requestPrecomment(makeCtx(Boolean(values.fake)), rest[0]);
      return void console.log(`approval ${a.id} is waiting for you. Draft comment:\n\n${String(a.summary.body)}\n\nPost it with: octet approval approve ${a.id}   (or deny)`);
    }
    if (cmd === 'review' && rest[0]) {
      if (!values.identity) throw new OctetError('usage: pr review <url> --identity <id>  (there is no default identity)');
      const r = await reviewExternalPr(makeCtx(Boolean(values.fake)), { url: rest[0], identity: values.identity });
      return void console.log(`${r.feedback}\n\nverdict: ${r.verdict}  (nothing was posted)`);
    }
  }

  if (group === 'audit' && cmd === 'verify') {
    const c = new Store(dbFile()).verifyChain();
    console.log(c.ok ? `audit chain ok: ${c.checked} events, head ${c.head.slice(0, 12)}` : `AUDIT CHAIN BROKEN at event ${String(c.brokenAt)}: ${String(c.reason)}`);
    process.exitCode = c.ok ? 0 : 1;
    return;
  }

  if (group === 'status') {
    const store = new Store(dbFile());
    for (const g of store.listGoals()) {
      console.log(`${g.id}  [${g.status}]  ${g.title}  (${g.branch})`);
      for (const b of store.listBeads(g.id)) console.log(`  ${b.id}  ${b.status.padEnd(10)} ${b.title}`);
    }
    return;
  }

  console.error(USAGE);
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof OctetError ? `octet: ${e.message}` : e);
  process.exitCode = 1;
}).finally(() => Promise.all(runners.map((r) => r.shutdown())));
