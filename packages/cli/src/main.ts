#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  addBead, addProject, approveBead, cancelBead, ClaudeCodeRunner, createGoal, dbFile, decideApproval, editPlan, FakeRunner, getIdentity,
  ghToken, loadIdentities, loadLimits, loadProjects, loadPlanning, loadReview, OctetError, openVault, planRequest, rejectPlan, rejectRequest, renderPlan, updateProject, verifyPlans, routeRequest, runsDir, submitRequest, refreshAllPrs, requestDelivery, requestPrecomment, reviewBead, reviewExternalPr, runBead, sshWhoAmI, Store, type Ctx,
} from '@octet/core';
import { abandonGoal, deleteBead, doctorIdentities, editBead, gc, loadUsage, usageCeiling } from '@octet/core';

const USAGE = `octet <command>

  identity list                     show configured identities
  identity doctor                   verify each identity's SSH key and gh login
  project add <name> <path> --identity <id> [--vault <dir>] [--vault-git] [--vault-in-repo] [--autonomy <level>]
  project set <name> [--vault <dir>] [--vault-git] [--vault-in-repo] [--autonomy manual|plan-gated|auto-to-pr]
  project list
  ask <project> <title> [--body <text>]   file a request (a project is required here)
  request list                      requests and where they stand
  request route <id> <project>      pick the project for an unrouted request
  request reject <id> <reason>      decline a request; nothing else is created
  request plan <id>                 have the Architect write a plan (needs a project vault)
  plan list                         plans and where they stand
  plan show <id>                    print a plan
  plan approve <id>                 approve it; the Marshal creates its beads
  plan reject <id> <feedback>       send it back; the Architect plans again
  plan edit <id> --file <json>      replace the plan with your edit (saved as a new version)
  goal pause|resume <goal>          stop or restart the scheduler for a goal
  goal abandon <goal>               give up on a goal: stop its agents, remove its worktrees (branches stay)
  gc [--yes]                        list leftover worktrees; with --yes, delete them
  usage                             tokens and estimated cost per day, goal and bead
  escalation list|resolve <id>      things the scheduler needs you for
  goal new <project> <title>
  goal list
  bead add <goal> <title> --brief <text> [--after <bead>]...
  bead run <bead> [--fake]          build a bead with an Engineer
  bead cancel <bead>                stop a running engineer or reviewer (works while the daemon or another shell runs it)
  bead edit <bead> [--title <t>] [--brief <text>]   change a bead that has not run yet
  bead delete <bead>                delete a bead that has not run and that no other bead waits on
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

function makeCtx(fake: boolean): Ctx {
  return {
    store: new Store(dbFile()),
    identities: loadIdentities(),
    projects: loadProjects(),
    runner: fake ? new FakeRunner() : new ClaudeCodeRunner(),
    limits: loadLimits(),
    review: loadReview(),
    planning: loadPlanning(),
    usage: loadUsage(),
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
      title: { type: 'string' },
      yes: { type: 'boolean' },
      body: { type: 'string' },
      vault: { type: 'string' },
      'vault-git': { type: 'boolean' },
      'vault-in-repo': { type: 'boolean' },
      autonomy: { type: 'string' },
      file: { type: 'string' },
      after: { type: 'string', multiple: true },
      fake: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [group, cmd, ...rest] = positionals;
  if (values.help || !group) return void console.log(USAGE);
  const projectOpts = () => ({
    ...(values.vault ? { vault: values.vault } : {}), ...(values['vault-git'] ? { vaultGit: true } : {}),
    ...(values['vault-in-repo'] ? { vaultInRepo: true } : {}), ...(values.autonomy ? { autonomy: values.autonomy } : {}),
  });

  if (group === 'identity') {
    const ids = loadIdentities();
    if (cmd === 'list') {
      for (const i of ids) console.log(`${i.id.padEnd(10)} ${i.ghUser.padEnd(18)} ${i.email}`);
      return;
    }
    if (cmd === 'doctor') {
      let bad = 0;
      for (const h of await doctorIdentities(ids)) {
        if (!h.ok) bad++;
        console.log(`${h.ok ? 'ok  ' : 'FAIL'} ${h.id}: ssh=${h.sshUser ?? 'no auth'} (want ${h.ghUser}), gh token=${h.tokenOk ? 'yes' : 'no'}`);
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
      const p = addProject({ name, path, identity: values.identity!, ...projectOpts() }, ids);
      return void console.log(`added ${p.name} -> ${p.path} as ${p.identity}`);
    }
    if (cmd === 'set') {
      const [name] = rest;
      if (!name) throw new OctetError('usage: project set <name> [--vault <dir>] [--vault-git] [--vault-in-repo] [--autonomy <level>]');
      const p = updateProject(name, projectOpts());
      return void console.log(`${p.name}: vault=${p.vault ?? '(none: planning off)'} git=${Boolean(p.vaultGit)} in-repo=${Boolean(p.vaultInRepo)} autonomy=${p.autonomy ?? 'plan-gated'}`);
    }
    if (cmd === 'list') {
      for (const p of loadProjects()) console.log(`${p.name.padEnd(16)} ${p.identity.padEnd(10)} ${(p.autonomy ?? 'plan-gated').padEnd(11)} ${p.vault ? 'vault' : 'no vault'.padEnd(5)}  ${p.path}`);
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
    if (cmd === 'plan') {
      const [id] = rest;
      if (!id) throw new OctetError('usage: request plan <id>');
      console.log('The Architect is reading the repository and writing a plan. This can take a few minutes...');
      const rec = await planRequest(makeCtx(Boolean(values.fake)), id);
      return void console.log(`plan ${rec.id} v${rec.version} is waiting for you (hash ${rec.contentHash.slice(0, 12)}).\nRead it: octet plan show ${rec.id}\nThen: octet plan approve ${rec.id}   or   octet plan reject ${rec.id} "what to change"`);
    }
    if (cmd === 'reject') {
      const [id, ...reason] = rest;
      if (!id || !reason.length) throw new OctetError('usage: request reject <id> <reason>');
      return void console.log(`request ${rejectRequest(ctx, id, reason.join(' ')).id}: rejected`);
    }
  }

  if (group === 'plan') {
    const ctx = makeCtx(Boolean(values.fake));
    if (cmd === 'list') {
      for (const p of ctx.store.listPlans()) console.log(`${p.id.padEnd(13)} v${p.version} ${p.status.padEnd(18)} ${p.goalId}`);
      return;
    }
    const [id, ...more] = rest;
    if (!id) throw new OctetError(`usage: plan ${cmd ?? '<command>'} <id>`);
    const rec = ctx.store.getPlan(id);
    if (!rec) throw new OctetError(`Unknown plan "${id}"`);
    const goal = ctx.store.getGoal(rec.goalId)!;
    const project = ctx.projects.find((p) => p.name === goal.project)!;
    const vault = openVault(project, ctx.identities.find((i) => i.id === project.identity)!);
    const slug = rec.vaultPath.replace(/^plans\//, '');
    if (cmd === 'show') {
      const { plan } = vault.readPlan(slug, rec.version);
      console.log(`${renderPlan(plan, goal.title)}\nstatus: ${rec.status}   hash: ${rec.contentHash.slice(0, 12)}   file: ${vault.path(`${rec.vaultPath}/plan.v${rec.version}.md`)}`);
      return;
    }
    if (cmd === 'approve') {
      const a = ctx.store.listApprovals().find((x) => x.kind === 'plan' && x.status === 'pending' && (x.summary as { planId?: string }).planId === id);
      if (!a) throw new OctetError(`Plan ${id} has no pending approval (status: ${rec.status})`);
      decideApproval(ctx, a.id, 'approve');
      const beads = ctx.store.listBeads(rec.goalId).filter((b) => b.planId === id);
      return void console.log(`plan ${id} approved; ${beads.length} bead(s) created:\n${beads.map((b) => `  ${b.id}  ${b.title}`).join('\n')}\nThe daemon's scheduler will run them; or: octet bead run <bead>`);
    }
    if (cmd === 'reject') {
      if (!more.length) throw new OctetError('usage: plan reject <id> <feedback>');
      console.log('The Architect is planning again...');
      const next = await rejectPlan(ctx, id, more.join(' '));
      return void console.log(`plan ${next.id} v${next.version} is waiting for you. Read it: octet plan show ${next.id}`);
    }
    if (cmd === 'edit') {
      if (!values.file) throw new OctetError('usage: plan edit <id> --file <plan.json>');
      const next = editPlan(ctx, id, JSON.parse(readFileSync(values.file, 'utf8')));
      return void console.log(`saved as plan ${next.id} v${next.version}; it needs approval: octet plan approve ${next.id}`);
    }
  }

  if (group === 'escalation') {
    const store = new Store(dbFile());
    if (cmd === 'list') {
      for (const e of store.listEscalations(true)) console.log(`${e.id.padEnd(11)} ${e.reason.padEnd(20)} ${e.goalId}${e.beadId ? `/${e.beadId}` : ''}  ${e.message}`);
      return;
    }
    if (cmd === 'resolve' && rest[0]) {
      if (!store.resolveEscalation(rest[0])) throw new OctetError(`No open escalation "${rest[0]}"`);
      return void console.log(`resolved ${rest[0]}`);
    }
  }

  if (group === 'goal') {
    if ((cmd === 'pause' || cmd === 'resume') && rest[0]) {
      const store = new Store(dbFile());
      if (!store.getGoal(rest[0])) throw new OctetError(`Unknown goal "${rest[0]}"`);
      store.setGoalPaused(rest[0], cmd === 'pause');
      store.log({ kind: cmd === 'pause' ? 'goal.paused' : 'goal.resumed', goalId: rest[0] });
      return void console.log(`goal ${rest[0]}: ${cmd}d`);
    }
    if (cmd === 'abandon') {
      const [id] = rest;
      if (!id) throw new OctetError('usage: goal abandon <goal>');
      const r = await abandonGoal(makeCtx(true), id);
      return void console.log(`goal ${id}: abandoned. Stopped ${r.cancelled.length} agent(s), removed ${r.removed.length} worktree(s); branches are kept.${r.stillRunning.length ? `\nStill running (worktrees kept; run \`octet gc\` later): ${r.stillRunning.join(', ')}` : ''}`);
    }
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
      if (r.cancelled) return void console.log(`review of ${id} was cancelled; the bead is still ${r.bead.status}`);
      console.log(`${r.feedback}\n\nverdict: ${r.verdict}; bead is now ${r.bead.status}`);
      return;
    }
    if (cmd === 'edit') {
      const [id] = rest;
      if (!id || (values.title === undefined && values.brief === undefined)) throw new OctetError('usage: bead edit <bead> [--title <t>] [--brief <text>]');
      const b = editBead(makeCtx(true), id, { ...(values.title !== undefined ? { title: values.title } : {}), ...(values.brief !== undefined ? { brief: values.brief } : {}) });
      return void console.log(`bead ${b.id}: updated`);
    }
    if (cmd === 'delete') {
      const [id] = rest;
      if (!id) throw new OctetError('usage: bead delete <bead>');
      deleteBead(makeCtx(true), id);
      return void console.log(`bead ${id}: deleted`);
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

  if (group === 'gc') {
    const r = gc(makeCtx(true), { apply: values.yes === true });
    if (!r.stragglers.length) return void console.log('nothing to clean up');
    for (const s of r.stragglers) console.log(`${r.removed.includes(s.path) ? 'removed' : 'found  '} ${s.path}  (${s.reason})`);
    for (const f of r.failed) console.log(`FAILED  ${f.path}: ${f.message}`);
    if (!values.yes) console.log('\nThis was a dry run. Delete these with: octet gc --yes   (branches are never deleted)');
    process.exitCode = r.failed.length ? 1 : 0;
    return;
  }

  if (group === 'usage') {
    const ctx = makeCtx(true);
    const u = ctx.store.usageSummary();
    const money = (n: number) => `$${n.toFixed(2)}`;
    const row = (label: string, t: { runs: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }) =>
      `${label.padEnd(34)} ${String(t.runs).padStart(4)} runs  ${money(t.costUsd).padStart(8)}  in ${t.inputTokens}  out ${t.outputTokens}  cache-read ${t.cacheReadTokens}`;
    console.log(row('today', u.today));
    const hold = usageCeiling(ctx);
    if (hold) console.log(`  ceiling reached: ${hold}`);
    else if (ctx.usage?.dailyCostUsd !== undefined || ctx.usage?.dailyRuns !== undefined) console.log(`  ceiling: ${ctx.usage.dailyCostUsd !== undefined ? money(ctx.usage.dailyCostUsd) : 'no cost limit'}, ${ctx.usage.dailyRuns ?? 'no'} runs per day`);
    for (const d of u.byDay) console.log(row(`  ${d.day}`, d));
    for (const g of ctx.store.listGoals()) if (u.byGoal[g.id]) {
      console.log(row(`goal ${g.id}`, u.byGoal[g.id]!));
      for (const b of ctx.store.listBeads(g.id)) if (u.byBead[b.id]) console.log(row(`  ${b.id} ${b.title}`.slice(0, 34), u.byBead[b.id]!));
    }
    console.log('\nCosts are Claude Code\'s own estimate at list prices, not a bill.');
    return;
  }

  if (group === 'audit' && cmd === 'verify') {
    const ctx = makeCtx(true);
    const c = ctx.store.verifyChain();
    console.log(c.ok ? `audit chain ok: ${c.checked} events, head ${c.head.slice(0, 12)}` : `AUDIT CHAIN BROKEN at event ${String(c.brokenAt)}: ${String(c.reason)}`);
    const p = verifyPlans(ctx);
    console.log(p.ok ? `plans ok: ${p.checked} checked against their recorded hashes` : `PLANS DO NOT MATCH THEIR RECORDS:\n${p.problems.map((x) => `  ${x.plan}: ${x.problem}`).join('\n')}`);
    process.exitCode = c.ok && p.ok ? 0 : 1;
    return;
  }

  if (group === 'status') {
    const store = new Store(dbFile());
    for (const g of store.listGoals()) {
      console.log(`${g.id}  [${g.status}${g.paused ? ', paused' : ''}]  ${g.title}  (${g.branch})`);
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
});
