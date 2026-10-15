/**
 * Every OpenTelemetry attribute and span name Octet emits lives here. The GenAI semantic conventions are
 * still "Development", so names can change; when they do, this is the only file to edit.
 *
 * Targeted revision: open-telemetry/semantic-conventions-genai at commit f3c6d0c (2026-10-14),
 * docs/gen-ai/gen-ai-agent-spans.md and gen-ai-spans.md (execute_tool), which reference core semconv v1.44.0.
 */

export const SEMCONV_REVISION = 'semantic-conventions-genai@f3c6d0c (2026-10-14), core semconv v1.44.0';
/** OTLP version the exporter's JSON follows. */
export const OTLP_VERSION = '1.x JSON (opentelemetry-proto, OTLP/HTTP)';

export const ATTR = {
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  agentName: 'gen_ai.agent.name',
  agentId: 'gen_ai.agent.id',
  agentVersion: 'gen_ai.agent.version',
  conversationId: 'gen_ai.conversation.id',
  requestModel: 'gen_ai.request.model',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  toolType: 'gen_ai.tool.type',
  errorType: 'error.type',
  // Opt-in content. Recorded only when `[telemetry] capture_content = true`.
  inputMessages: 'gen_ai.input.messages',
  outputMessages: 'gen_ai.output.messages',
  systemInstructions: 'gen_ai.system_instructions',
  toolCallArguments: 'gen_ai.tool.call.arguments',
  toolCallResult: 'gen_ai.tool.call.result',
  // Octet's own attributes; they are not part of the conventions.
  octetGoalId: 'octet.goal.id',
  octetBeadId: 'octet.bead.id',
  octetSeat: 'octet.seat',
  octetExitCode: 'octet.exit_code',
  octetCostUsd: 'octet.cost.usd',
  octetMcpServer: 'octet.mcp.server',
} as const;

/** Values of `gen_ai.operation.name`. */
export const OP = { invokeAgent: 'invoke_agent', executeTool: 'execute_tool' } as const;

/** Values of `gen_ai.tool.type`: a tool the agent runs on its side to reach outside systems. */
export const TOOL_TYPE_EXTENSION = 'extension';
export const TOOL_TYPE_FUNCTION = 'function';

export const spanNames = {
  invokeAgent: (seat: string): string => `${OP.invokeAgent} ${seat}`,
  executeTool: (tool: string): string => `${OP.executeTool} ${tool}`,
};

/** Values of `error.type` for the ways a run can end badly. */
export const ERROR_TYPE = { timeout: 'timeout', cancelled: 'cancelled', exit: 'agent_exit_nonzero', exception: 'exception' } as const;

/** OTLP SpanKind numbers. */
export const SPAN_KIND = { internal: 1, client: 3 } as const;
