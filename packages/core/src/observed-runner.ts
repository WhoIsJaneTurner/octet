import { ATTR, ERROR_TYPE, OP, SPAN_KIND, spanNames, TOOL_TYPE_EXTENSION, TOOL_TYPE_FUNCTION } from './otel-attrs.ts';
import type { Span, Tracer } from './otel.ts';
import { untrusted, type AgentHandshake, type RunObserver } from './observe.ts';
import type { AgentRunner, RunRequest, RunResult } from './runner.ts';
import type { Store } from './store.ts';

export interface ObservedRunnerOptions {
  /** Where audit events go. Unset = no audit events from this decorator. */
  store?: Store;
  /** Where spans go. Unset = no tracing. */
  tracer?: Tracer;
  /** Record prompts, outputs and tool arguments/results on spans. Off unless asked for. */
  captureContent?: boolean;
  /** Provider name for spans when the agent does not report one. */
  providerFor?: (seat: string) => string;
}

const ARG_LIMIT = 4000;

/** Goal and bead a run belongs to, found from the worktree the runner is pointed at. */
function attribute(store: Store, cwd: string): { goalId?: string; beadId?: string } {
  const bead = store.listBeads().find((b) => b.worktree === cwd);
  if (bead) return { goalId: bead.goalId, beadId: bead.id };
  const goal = store.listGoals().find((g) => g.worktree === cwd);
  return goal ? { goalId: goal.id } : {};
}

const clip = (v: unknown): unknown => {
  const s = JSON.stringify(v) ?? '';
  return s.length > ARG_LIMIT ? `${s.slice(0, ARG_LIMIT)}...[truncated ${s.length - ARG_LIMIT}]` : v;
};

/**
 * Decorator: audits and traces whatever the wrapped runner reports. Nothing here can fail or slow a run:
 * audit writes and span bookkeeping are wrapped, and span export happens later in the background.
 */
export class ObservedRunner implements AgentRunner {
  private readonly inner: AgentRunner;
  private readonly opts: ObservedRunnerOptions;
  constructor(inner: AgentRunner, opts: ObservedRunnerOptions = {}) {
    this.inner = inner;
    this.opts = opts;
  }

  async run(req: RunRequest, onChunk?: (text: string) => void): Promise<RunResult> {
    const { store, tracer, captureContent } = this.opts;
    let ref: { goalId?: string; beadId?: string } = {};
    try { if (store) ref = attribute(store, req.cwd); } catch { /* unattributed events are still better than none */ }
    const audit = (kind: string, data: unknown) => {
      try { store?.log({ kind, seat: req.seat, ...ref, data }); } catch { /* the audit log must not break a run */ }
    };

    const root = tracer?.start(spanNames.invokeAgent(req.seat), {
      kind: SPAN_KIND.client,
      attrs: {
        [ATTR.operationName]: OP.invokeAgent, [ATTR.agentName]: req.seat, [ATTR.octetSeat]: req.seat,
        [ATTR.providerName]: this.opts.providerFor?.(req.seat) ?? 'anthropic', [ATTR.requestModel]: req.model,
        [ATTR.octetGoalId]: ref.goalId, [ATTR.octetBeadId]: ref.beadId,
      },
    });
    const toolSpans = new Map<string, Span>();
    const mcpCalls = new Map<string, { server: string; tool: string }>();
    let hello: AgentHandshake | undefined;
    let tokens: { input?: number; output?: number } = {};
    let cost: number | undefined;
    const outer = req.observer;
    const guard = (fn: () => void) => { try { fn(); } catch { /* observers never break a run */ } };

    const observer: RunObserver = {
      handshake: (h) => guard(() => {
        hello = h;
        audit('agent.handshake', {
          protocol: h.protocol, protocolVersion: h.protocolVersion, command: h.command,
          agent: { name: h.agentName, title: h.agentTitle, version: h.agentVersion }, model: h.model, sessionId: h.sessionId,
          capabilities: clip(h.capabilities), mcpServers: clip(h.mcpServers), ...(h.error ? { error: h.error } : {}),
        });
        outer?.handshake?.(h);
      }),
      toolCall: (e) => guard(() => {
        if (e.mcp) {
          mcpCalls.set(e.id, e.mcp);
          audit('mcp.tool_call', { id: e.id, server: e.mcp.server, tool: e.mcp.tool, arguments: clip(e.input) });
        }
        if (root && tracer) {
          const s = tracer.start(spanNames.executeTool(e.name), {
            kind: SPAN_KIND.internal, parent: root,
            attrs: {
              [ATTR.operationName]: OP.executeTool, [ATTR.toolName]: e.name, [ATTR.toolCallId]: e.id,
              [ATTR.toolType]: e.mcp ? TOOL_TYPE_EXTENSION : TOOL_TYPE_FUNCTION, [ATTR.agentName]: req.seat,
              [ATTR.octetMcpServer]: e.mcp?.server,
              ...(captureContent && e.input !== undefined ? { [ATTR.toolCallArguments]: JSON.stringify(e.input) } : {}),
            },
          });
          toolSpans.set(e.id, s);
        }
        outer?.toolCall?.(e);
      }),
      toolResult: (e) => guard(() => {
        const mcp = mcpCalls.get(e.id);
        if (mcp) audit('mcp.tool_result', { id: e.id, server: mcp.server, tool: mcp.tool, isError: e.isError });
        const s = toolSpans.get(e.id);
        if (s) {
          toolSpans.delete(e.id);
          if (e.isError) s.set({ [ATTR.errorType]: 'tool_error' }).fail('tool reported an error');
          if (captureContent && e.output !== undefined) s.set({ [ATTR.toolCallResult]: e.output });
          s.end();
        }
        outer?.toolResult?.(e);
      }),
      decision: (e) => guard(() => {
        audit('agent.permission', { request: e.request, subject: e.subject, allowed: e.allowed, reason: e.reason });
        outer?.decision?.(e);
      }),
      usage: (e) => guard(() => {
        tokens = { ...tokens, ...(e.inputTokens !== undefined ? { input: e.inputTokens } : {}), ...(e.outputTokens !== undefined ? { output: e.outputTokens } : {}) };
        if (e.costUsd !== undefined) cost = e.costUsd;
        outer?.usage?.(e);
      }),
    };

    let result: RunResult | undefined;
    let thrown: unknown;
    try {
      result = await this.inner.run({ ...req, observer }, onChunk);
      return result;
    } catch (e) {
      thrown = e;
      throw e;
    } finally {
      guard(() => {
        for (const s of toolSpans.values()) s.end();
        if (!root) return;
        root.set({
          [ATTR.agentVersion]: hello?.agentVersion, [ATTR.conversationId]: hello?.sessionId,
          ...(hello?.provider ? { [ATTR.providerName]: hello.provider } : {}),
          [ATTR.usageInputTokens]: tokens.input, [ATTR.usageOutputTokens]: tokens.output, [ATTR.octetCostUsd]: cost,
          [ATTR.octetExitCode]: result?.exitCode,
          ...(captureContent ? {
            [ATTR.systemInstructions]: JSON.stringify([{ type: 'text', content: req.systemPrompt }]),
            [ATTR.inputMessages]: JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: req.prompt }] }]),
            ...(result ? { [ATTR.outputMessages]: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: result.output }], finish_reason: result.exitCode === 0 ? 'stop' : 'error' }]) } : {}),
          } : {}),
        });
        const errorType = thrown ? ERROR_TYPE.exception : result?.timedOut ? ERROR_TYPE.timeout : result?.cancelled ? ERROR_TYPE.cancelled : result && result.exitCode !== 0 ? ERROR_TYPE.exit : undefined;
        if (errorType) root.set({ [ATTR.errorType]: errorType }).fail(thrown ? untrusted((thrown as Error).message, 300) : errorType);
        root.end();
      });
    }
  }
}
