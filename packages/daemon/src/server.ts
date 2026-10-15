import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import {
  addBead, addProject, answerClarification, approveBead, beadDiff, cancelBead, createGoal, decideApproval, editPlan, getProject, loadIdentities, loadLimits, loadPlanning, loadProjects,
  IntakeService, loadGithubHosts, loadIntake, loadReview, openVault, planRequest, rejectPlan, reviewGoal, setGithubHosts, tick, verifyPlans, OctetError, readRunOutput, reconcileRunning, rejectRequest, routeRequest, runsDir, submitRequest, refreshAllPrs, requestChanges, requestDelivery, requestPrecomment, reviewBead, runBead, SEATS, type AgentRunner, type Ctx, type Forge, type IntakeConfig, type IntakeDeps, type Limits, type Store,
} from '@octet/core';

export interface DaemonOptions {
  store: Store;
  runner: AgentRunner;
  forge?: Forge;
  /** Where the built UI lives. Optional so tests can run without it. */
  uiDir?: string;
  port?: number;
  token?: string;
  identitiesFile?: string;
  projectsFile?: string;
  /** Where run logs are kept. Defaults to the data directory. */
  runsDir?: string;
  /** Run the scheduler loop. On by default; it only touches goals created from an approved plan. */
  scheduler?: boolean;
  /** Overrides the limits read from config.toml (tests use this for determinism). */
  limits?: Limits;
  /** Intake sources. Defaults to the `[intake.*]` tables of config.toml; tests inject fakes through `deps`. */
  intake?: { config?: IntakeConfig; deps?: IntakeDeps };
}

export interface Daemon {
  server: Server;
  port: number;
  token: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const MAX_OUTPUT = 200_000;
const MAX_BODY = 1_000_000;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function tokenOk(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const str = (body: Record<string, unknown>, key: string): string => {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${key}" is required`);
  return v;
};

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const token = opts.token ?? randomBytes(24).toString('hex');
  const { store, runner } = opts;
  setGithubHosts(loadGithubHosts());
  const recovered = reconcileRunning(store);
  if (recovered.length) console.warn(`octet: recovered ${recovered.length} interrupted bead(s): ${recovered.join(', ')}`);
  const ctx: Ctx = {
    store, runner, runsDir: opts.runsDir ?? runsDir(), ...(opts.forge ? { forge: opts.forge } : {}), limits: opts.limits ?? loadLimits(), review: loadReview(), planning: loadPlanning(),
    identities: loadIdentities(opts.identitiesFile),
    projects: loadProjects(opts.projectsFile),
  };
  const intake = new IntakeService(ctx, opts.intake?.config ?? loadIntake(), opts.intake?.deps);
  const outputs = new Map<string, string>();
  const clients = new Set<ServerResponse>();
  const running = new Set<string>();
  const reviewing = new Set<string>();
  const planning = new Set<string>();

  const push = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  store.subscribe(() => push('change', {}));

  const state = () => ({
    seats: SEATS,
    identities: ctx.identities.map((i) => ({ id: i.id, ghUser: i.ghUser, email: i.email })),
    projects: ctx.projects,
    goals: store.listGoals(),
    requests: store.listRequests(),
    plans: store.listPlans(),
    clarifications: store.listClarifications().filter((c) => !c.answers),
    escalations: store.listEscalations(true),
    planning: [...planning],
    approvals: store.listApprovals(),
    prs: store.listPrs(),
    limits: ctx.limits,
    audit: store.verifyChain(),
    planAudit: verifyPlans(ctx),
    beads: store.listBeads(),
    events: store.events(200),
    // Runs owned by other processes (the CLI) count too, so the cap and the UI see them.
    running: store.listBeads().filter((b) => b.status === 'running').map((b) => b.id),
    reviewing: [...reviewing],
    review: ctx.review,
    intake: intake.status(),
  });

  const startRun = (beadId: string) => {
    if (running.has(beadId)) throw new HttpError(409, `Bead ${beadId} is already running`);
    running.add(beadId);
    outputs.set(beadId, '');
    void runBead(ctx, beadId, (text) => {
      const next = (outputs.get(beadId) ?? '') + text;
      outputs.set(beadId, next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next);
      push('output', { beadId, text });
    })
      .catch((e: unknown) => {
        store.log({ kind: 'bead.error', beadId, seat: 'engineer', data: { message: (e as Error).message } });
      })
      .finally(() => {
        running.delete(beadId);
        push('change', {});
        if (ctx.review?.auto && store.getBead(beadId)?.status === 'in_review') {
          try { startReview(beadId); } catch { /* already reviewing */ }
        }
      });
  };

  const startReview = (beadId: string) => {
    if (reviewing.has(beadId)) throw new HttpError(409, `Bead ${beadId} is already being reviewed`);
    const bead = store.getBead(beadId);
    if (!bead) throw new HttpError(404, `Unknown bead "${beadId}"`);
    if (bead.status !== 'in_review') throw new HttpError(400, `Bead ${beadId} is ${bead.status}, not in_review`);
    reviewing.add(beadId);
    push('change', {});
    void reviewBead(ctx, beadId)
      .catch((e: unknown) => {
        store.log({ kind: 'review.error', beadId, seat: 'reviewer', data: { message: (e as Error).message } });
      })
      .finally(() => {
        reviewing.delete(beadId);
        push('change', {});
        // A rejected bead goes back to the Engineer automatically when auto-review is on.
        if (ctx.review?.auto && store.getBead(beadId)?.status === 'changes_requested') {
          try { startRun(beadId); } catch { /* cap reached or already running: the human takes over */ }
        }
      });
  };

  const startGoalReview = (goalId: string) => {
    if (reviewing.has(goalId)) return;
    reviewing.add(goalId);
    push('change', {});
    void reviewGoal(ctx, goalId)
      .catch((e: unknown) => {
        store.log({ kind: 'review.error', goalId, seat: 'reviewer', data: { message: (e as Error).message } });
        store.escalate({ goalId, reason: 'goal_review_failed', message: `The final review failed: ${(e as Error).message}` });
      })
      .finally(() => { reviewing.delete(goalId); push('change', {}); });
  };

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/api/state' && method === 'GET') return json(200, state());

    let m: RegExpMatchArray | null;
    if (path === '/api/projects' && method === 'POST') {
      const b = await readJson(req);
      const p = addProject({ name: str(b, 'name'), path: str(b, 'path'), identity: str(b, 'identity') }, ctx.identities, opts.projectsFile);
      ctx.projects.splice(0, ctx.projects.length, ...loadProjects(opts.projectsFile));
      push('change', {});
      return json(201, p);
    }
    if (path === '/api/requests' && method === 'POST') {
      const b = await readJson(req);
      const project = typeof b.project === 'string' && b.project ? b.project : null;
      const body = typeof b.body === 'string' ? b.body : '';
      // The browser UI is the only thing that reaches this route, so the source is fixed here, not taken from the caller.
      return json(201, submitRequest(ctx, { source: 'ui', project, title: str(b, 'title'), body, requester: 'local user' }).request);
    }
    if ((m = path.match(/^\/api\/requests\/([\w-]+)\/(route|reject)$/)) && method === 'POST') {
      const b = await readJson(req);
      return json(200, m[2] === 'route' ? routeRequest(ctx, m[1]!, str(b, 'project')) : rejectRequest(ctx, m[1]!, str(b, 'reason')));
    }
    if ((m = path.match(/^\/api\/requests\/([\w-]+)\/plan$/)) && method === 'POST') {
      const id = m[1]!;
      const r = store.getRequest(id);
      if (!r) throw new HttpError(404, `Unknown request "${id}"`);
      if (r.status !== 'routed' && r.status !== 'planning') throw new HttpError(400, `Request ${id} is ${r.status}; only a routed request can be planned`);
      if (planning.has(id)) throw new HttpError(409, 'Planning is already running for this request');
      const project = ctx.projects.find((p) => p.name === r.project);
      if (!project?.vault) throw new HttpError(400, `Project "${r.project}" has no vault, so planning is off for it`);
      planning.add(id);
      push('change', {});
      void planRequest(ctx, id)
        .catch(() => { /* failures are logged as planning.failed and escalated; questions show up as clarifications */ })
        .finally(() => { planning.delete(id); push('change', {}); });
      return json(202, { planning: id });
    }
    if ((m = path.match(/^\/api\/clarifications\/([\w-]+)\/answer$/)) && method === 'POST') {
      const b = await readJson(req);
      if (!Array.isArray(b.answers) || !b.answers.every((a) => typeof a === 'string')) throw new HttpError(400, '"answers" must be an array of strings');
      const request = answerClarification(ctx, m[1]!, b.answers as string[]);
      // Answers in: the Chair looks again and planning carries on, as it does for the PLAN button.
      if (!planning.has(request.id)) {
        planning.add(request.id);
        push('change', {});
        void planRequest(ctx, request.id)
          .catch(() => { /* logged or asked again */ })
          .finally(() => { planning.delete(request.id); push('change', {}); });
      }
      return json(202, { planning: request.id });
    }
    if ((m = path.match(/^\/api\/plans\/([\w-]+)$/)) && method === 'GET') {
      const rec = store.getPlan(m[1]!);
      if (!rec) throw new HttpError(404, `Unknown plan "${m[1]}"`);
      const goal = store.getGoal(rec.goalId)!;
      const vault = openVault(getProject(ctx.projects, goal.project), ctx.identities.find((i) => i.id === getProject(ctx.projects, goal.project).identity)!);
      return json(200, { record: rec, plan: vault.readPlan(rec.vaultPath.replace(/^plans\//, ''), rec.version).plan });
    }
    if ((m = path.match(/^\/api\/plans\/([\w-]+)\/(reject|edit)$/)) && method === 'POST') {
      const id = m[1]!;
      const rec = store.getPlan(id);
      if (!rec) throw new HttpError(404, `Unknown plan "${id}"`);
      const b = await readJson(req);
      if (m[2] === 'edit') return json(201, editPlan(ctx, id, b.plan));
      const feedback = str(b, 'feedback');
      if (rec.status !== 'awaiting_approval') throw new HttpError(400, `Plan ${id} is ${rec.status}, not awaiting approval`);
      const reqId = rec.requestId ?? '';
      planning.add(reqId);
      push('change', {});
      void rejectPlan(ctx, id, feedback)
        .catch(() => { /* logged as planning.failed and escalated */ })
        .finally(() => { planning.delete(reqId); push('change', {}); });
      return json(202, { replanning: id });
    }
    if ((m = path.match(/^\/api\/goals\/([\w-]+)\/(pause|resume)$/)) && method === 'POST') {
      if (!store.getGoal(m[1]!)) throw new HttpError(404, `Unknown goal "${m[1]}"`);
      store.setGoalPaused(m[1]!, m[2] === 'pause');
      store.log({ kind: m[2] === 'pause' ? 'goal.paused' : 'goal.resumed', goalId: m[1]! });
      return json(200, store.getGoal(m[1]!));
    }
    if ((m = path.match(/^\/api\/escalations\/([\w-]+)\/resolve$/)) && method === 'POST') {
      if (!store.resolveEscalation(m[1]!)) throw new HttpError(404, 'No such open escalation');
      return json(200, { resolved: m[1] });
    }
    if (path === '/api/goals' && method === 'POST') {
      const b = await readJson(req);
      return json(201, createGoal(ctx, { project: str(b, 'project'), title: str(b, 'title') }));
    }
    if (path === '/api/beads' && method === 'POST') {
      const b = await readJson(req);
      const after = Array.isArray(b.dependsOn) ? b.dependsOn.map(String) : [];
      return json(201, addBead(ctx, { goalId: str(b, 'goalId'), title: str(b, 'title'), brief: str(b, 'brief'), dependsOn: after }));
    }
    if ((m = path.match(/^\/api\/goals\/([\w-]+)\/deliver$/)) && method === 'POST') {
      return json(201, requestDelivery(ctx, m[1]!));
    }
    if ((m = path.match(/^\/api\/approvals\/([\w-]+)\/(approve|deny)$/)) && method === 'POST') {
      return json(200, decideApproval(ctx, m[1]!, m[2] as 'approve' | 'deny'));
    }
    if ((m = path.match(/^\/api\/goals\/([\w-]+)\/prereview$/)) && method === 'POST') {
      const id = m[1]!;
      if (reviewing.has(id)) throw new HttpError(409, 'A pre-review is already running for this goal');
      if (!store.getPr(id)) throw new HttpError(400, 'This goal has no open pull request');
      reviewing.add(id);
      push('change', {});
      void requestPrecomment(ctx, id)
        .catch((e: unknown) => store.log({ kind: 'review.error', goalId: id, seat: 'reviewer', data: { message: (e as Error).message } }))
        .finally(() => { reviewing.delete(id); push('change', {}); });
      return json(202, { reviewing: id });
    }
    if (path === '/api/prs/refresh' && method === 'POST') {
      refreshAllPrs(ctx);
      return json(200, { prs: store.listPrs() });
    }
    if (path === '/api/audit/verify' && method === 'GET') return json(200, { ...store.verifyChain(), plans: verifyPlans(ctx) });
    if ((m = path.match(/^\/api\/beads\/([\w-]+)\/(run|cancel|approve|changes|diff|output|review)$/))) {
      const [, id, action] = m as unknown as [string, string, string];
      if (action === 'diff' && method === 'GET') return json(200, { diff: beadDiff(ctx, id) });
      if (action === 'output' && method === 'GET') return json(200, { output: outputs.get(id) || readRunOutput(ctx, id, MAX_OUTPUT) });
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (action === 'run') {
        if (!store.getBead(id)) throw new HttpError(404, `Unknown bead "${id}"`);
        startRun(id);
        return json(202, { started: id });
      }
      if (action === 'cancel') {
        cancelBead(ctx, id);
        push('change', {});
        return json(202, { cancelling: id });
      }
      if (action === 'review') {
        startReview(id);
        return json(202, { reviewing: id });
      }
      if (action === 'approve') return json(200, approveBead(ctx, id));
      if (action === 'changes') {
        const b = await readJson(req);
        return json(200, requestChanges(ctx, id, str(b, 'feedback')));
      }
    }
    throw new HttpError(404, 'Not found');
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    const root = opts.uiDir ? resolve(opts.uiDir) : undefined;
    if (!root || !existsSync(join(root, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('UI not built. Run: pnpm ui:build');
      return;
    }
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = join(root, rel || 'index.html');
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    let body: Buffer | string = readFileSync(file);
    if (file.endsWith('index.html')) {
      body = body.toString('utf8').replace('__OCTET_TOKEN__', token);
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    });
    res.end(body);
  }


  // The scheduler: reads durable state on every change and every 30 s, and starts work through the same
  // functions the buttons use, so it respects the running sets and the caps.
  let ticking = false;
  let pending: NodeJS.Timeout | undefined;
  const runTick = () => {
    if (ticking || opts.scheduler === false) return;
    ticking = true;
    try {
      tick(ctx, { isRunning: (id) => running.has(id), isReviewing: (id) => reviewing.has(id) }, {
        run: (id) => startRun(id),
        review: (id) => startReview(id),
        goalReview: (id) => startGoalReview(id),
      });
    } catch (e) {
      console.error('octet: scheduler tick failed', e);
    } finally {
      ticking = false;
    }
  };
  const tickSoon = () => {
    if (pending || opts.scheduler === false) return;
    pending = setTimeout(() => { pending = undefined; runTick(); }, 100);
    pending.unref();
  };
  store.subscribe(tickSoon);
  const beat = setInterval(runTick, 30_000);
  beat.unref();
  runTick();

  // Read-only PR status polling, so a locked repo's "waiting on review" state stays current.
  const poll = setInterval(() => { try { refreshAllPrs(ctx); } catch { /* logged per PR */ } }, 90_000);
  poll.unref();
  // Catches runs whose owner died after startup (a CLI run killed with no daemon watching).
  const sweep = setInterval(() => { try { reconcileRunning(store); } catch { /* retried next sweep */ } }, 15_000);
  sweep.unref();
  intake.start();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const addr = server.address() as AddressInfo;
        const host = (req.headers.host ?? '').toLowerCase();
        // Blocks DNS-rebinding: only loopback names on our own port are served.
        if (host !== `127.0.0.1:${addr.port}` && host !== `localhost:${addr.port}`) {
          throw new HttpError(403, 'Forbidden host');
        }
        const url = new URL(req.url ?? '/', `http://${host}`);
        if (url.pathname.startsWith('/api/')) {
          const bearer = req.headers.authorization?.replace(/^Bearer /, '');
          if (!tokenOk(bearer ?? url.searchParams.get('token'), token)) throw new HttpError(401, 'Missing or bad token');
          await route(req, res, url);
        } else if (req.method === 'GET') {
          serveStatic(res, url.pathname);
        } else {
          throw new HttpError(405, 'Method not allowed');
        }
      } catch (e) {
        if (res.headersSent) return void res.end();
        const status = e instanceof HttpError ? e.status : e instanceof OctetError ? 400 : 500;
        const message = status === 500 ? 'Internal error' : (e as Error).message;
        if (status === 500) console.error(e);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server, port, token,
    close: () => new Promise((resolve) => {
      clearInterval(poll);
      clearInterval(sweep);
      clearInterval(beat);
      clearTimeout(pending);
      intake.stop();
      for (const c of clients) c.end();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
