import { OctetError } from './errors.ts';
import { getProject } from './project.ts';
import type { Ctx } from './orchestrate.ts';
import type { Request, RequestSource } from './store.ts';

export const MAX_REQUEST_BODY = 20_000;
export const MAX_REQUEST_TITLE = 200;
export const TRUNCATED = '\n\n[truncated by Octet: the original was longer than 20,000 characters]';

export interface RequestInput {
  source: RequestSource;
  /** Required for external sources so the same issue or ticket is never ingested twice. */
  externalRef?: string | null;
  /** Leave out to have the request wait in the inbox for you to route it. */
  project?: string | null;
  title: string;
  body?: string;
  /** Who asked, as the source reports it. Recorded, never trusted. */
  requester: string;
}

/**
 * Intake: normalizes a request from any source into the one shape. The text is data. Nothing here (or later
 * in the Warden) reads it to pick a project, identity or permission; only an explicit `project` routes it.
 * Seeing the same `(source, externalRef)` again returns the existing request instead of making a second.
 */
export function submitRequest(ctx: Ctx, input: RequestInput): { request: Request; duplicate: boolean } {
  const title = input.title.replace(/\s+/g, ' ').trim();
  if (!title) throw new OctetError('A request needs a title');
  if (title.length > MAX_REQUEST_TITLE) throw new OctetError(`Title is too long (${title.length} of ${MAX_REQUEST_TITLE} characters)`);
  if (!input.requester.trim()) throw new OctetError('A request needs a requester');
  const ref = input.externalRef ?? null;
  if (ref) {
    const existing = ctx.store.findRequestByRef(input.source, ref);
    if (existing) return { request: existing, duplicate: true };
  } else if (input.source !== 'ui' && input.source !== 'cli') {
    throw new OctetError(`Requests from ${input.source} need an externalRef so they can be de-duplicated`);
  }
  const project = input.project || null;
  if (project) getProject(ctx.projects, project); // throws for an unknown project

  const raw = input.body ?? '';
  const truncated = raw.length > MAX_REQUEST_BODY;
  const body = truncated ? raw.slice(0, MAX_REQUEST_BODY) + TRUNCATED : raw;
  const request = ctx.store.insertRequest({
    source: input.source, externalRef: ref, project, title, body, requester: input.requester.trim().slice(0, 200),
    status: project ? 'routed' : 'new',
  });
  ctx.store.log({
    kind: 'request.created',
    data: { request: request.id, source: request.source, externalRef: ref, project, title, requester: request.requester, truncated },
  });
  return { request, duplicate: false };
}

/** You (or later the Chair, confirmed by you) pick the project. Only an unplanned request can be routed. */
export function routeRequest(ctx: Ctx, id: string, project: string): Request {
  const req = ctx.store.getRequest(id);
  if (!req) throw new OctetError(`Unknown request "${id}"`);
  if (req.status !== 'new' && req.status !== 'routed') throw new OctetError(`Request ${id} is ${req.status}; it can no longer be routed`);
  getProject(ctx.projects, project);
  ctx.store.updateRequest(id, { project, status: 'routed' });
  ctx.store.log({ kind: 'request.routed', data: { request: id, from: req.project, to: project } });
  return ctx.store.getRequest(id)!;
}

/** Records why and writes nothing else: no goal, no branch, no worktree. */
export function rejectRequest(ctx: Ctx, id: string, reason: string): Request {
  const req = ctx.store.getRequest(id);
  if (!req) throw new OctetError(`Unknown request "${id}"`);
  if (req.status !== 'new' && req.status !== 'routed') throw new OctetError(`Request ${id} is ${req.status}; it can no longer be rejected`);
  const why = reason.trim();
  if (!why) throw new OctetError('A reason is required to reject a request');
  ctx.store.updateRequest(id, { status: 'rejected', rejectReason: why });
  ctx.store.log({ kind: 'request.rejected', data: { request: id, reason: why } });
  return ctx.store.getRequest(id)!;
}
