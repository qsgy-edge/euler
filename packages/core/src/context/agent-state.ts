import type { SourceAck } from '../contracts.ts';
import { check } from '../contracts.ts';

export type RunTerminal = 'completed' | 'needs-input' | 'cancelled' | 'budget-exhausted' | 'deadline' | 'failed' | 'blocked-unknown';
export interface ModelRoute { provider: string; model: string; route: string; authNamespace: string }
export interface ModelReply { text: string; calls: ToolCall[]; stop: 'end' | 'tools' | 'length' | 'error'; usage?: { input: number; output: number }; modelHash?: string }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ToolResult {
  callId: string; executionState: 'not_started' | 'started' | 'unknown';
  outcome: 'success' | 'failure' | 'cancelled' | 'timeout' | 'unavailable' | 'unknown';
  argumentsHash: string; errorClass: string | null; source: SourceAck;
}
export interface ToolFact { callId: string; name: string; argumentsHash: string; attemptId: string; started: boolean; result: ToolResult | null }
export type AgentEvent =
  | { kind: 'opened'; route: ModelRoute }
  | { kind: 'input'; source: SourceAck; mode: 'steer' | 'follow-up' | 'queue' }
  | { kind: 'admitted'; eventIds: string[] }
  | { kind: 'bound'; assemblyId: string; eventIds: string[] }
  | { kind: 'response'; attemptId: string; source: SourceAck; calls: { callId: string; name: string; argumentsHash: string }[] }
  | { kind: 'tool-started'; callId: string }
  | { kind: 'tool-result'; result: ToolResult }
  | { kind: 'terminal'; terminal: RunTerminal };
export interface AgentStatus {
  terminal: RunTerminal | null;
  attempts: number;
  inputs: { source: SourceAck; mode: 'steer' | 'follow-up' | 'queue'; state: 'received' | 'admitted-to-loop' | 'bound-to-assembly' }[];
  tools: ToolFact[];
  responses: { attemptId: string; source: SourceAck }[];
}
export function replayAgent(events: AgentEvent[], attempts: number): AgentStatus {
  const state: AgentStatus = { terminal: null, attempts, inputs: [], responses: [], tools: [] };
  check(events[0]?.kind === 'opened', 'agent-evidence-gap');
  for (const [index, event] of events.entries()) {
    check(!state.terminal, 'agent-event-after-terminal');
    switch (event.kind) {
      case 'opened': check(index === 0, 'agent-evidence-gap'); break;
      case 'input':
        check(!state.inputs.some(input => input.source.eventId === event.source.eventId), 'input-already-received');
        state.inputs.push({ source: event.source, mode: event.mode, state: 'received' }); break;
      case 'admitted': case 'bound':
        for (const id of event.eventIds) {
          const input = state.inputs.find(input => input.source.eventId === id);
          check(input?.mode === 'steer' && input.state === (event.kind === 'bound' ? 'admitted-to-loop' : 'received'), 'invalid-input-transition');
          input.state = event.kind === 'bound' ? 'bound-to-assembly' : 'admitted-to-loop';
        }
        break;
      case 'response':
        check(!state.responses.some(response => response.attemptId === event.attemptId), 'response-already-settled');
        state.responses.push({ attemptId: event.attemptId, source: event.source });
        for (const call of event.calls) {
          check(!state.tools.some(tool => tool.callId === call.callId), 'duplicate-tool-call');
          state.tools.push({ ...call, attemptId: event.attemptId, started: false, result: null });
        }
        break;
      case 'tool-started': {
        const tool = state.tools.find(tool => tool.callId === event.callId);
        check(tool && !tool.started && !tool.result, 'tool-not-admissible');
        tool.started = true; break;
      }
      case 'tool-result': {
        const tool = state.tools.find(tool => tool.callId === event.result.callId);
        check(tool && !tool.result && tool.argumentsHash === event.result.argumentsHash, 'tool-result-mismatch');
        check((event.result.executionState === 'started') === tool.started, 'tool-execution-mismatch');
        check(event.result.outcome !== 'success' || tool.started, 'success-without-execution');
        tool.result = event.result; break;
      }
      case 'terminal':
        check(state.tools.every(tool => tool.result), 'unsettled-tool-batch');
        if (event.terminal === 'completed') check(!state.tools.some(tool => tool.result?.outcome === 'unknown'), 'unknown-tool');
        state.terminal = event.terminal; break;
    }
  }
  return state;
}
