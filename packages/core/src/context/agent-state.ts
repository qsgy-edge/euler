import type { SourceAck } from '../contracts.ts';
import { check } from '../contracts.ts';
import type { FileAdmission, FileReceipt, FileCapability, FileFailureReason } from './file-contract.ts';

export type RunTerminal = 'completed' | 'needs-input' | 'cancelled' | 'budget-exhausted' | 'deadline' | 'failed' | 'blocked-unknown';
export interface ModelRoute { provider: string; model: string; route: string; authNamespace: string }
export interface ModelReply { text: string; calls: ToolCall[]; stop: 'end' | 'tools' | 'length' | 'error'; usage?: { input: number; output: number }; modelHash?: string }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ToolResult {
  callId: string; executionState: 'not_started' | 'started' | 'unknown';
  outcome: 'success' | 'failure' | 'cancelled' | 'timeout' | 'unavailable' | 'unknown';
  argumentsHash: string; errorClass: string | null; source: SourceAck; file?: FileReceipt;
}
export interface ToolFact { callId: string; name: string; argumentsHash: string; attemptId: string; started: boolean; result: ToolResult | null }
export type AgentEvent =
  | { kind: 'opened'; route: ModelRoute; files?: FileCapability }
  | { kind: 'input'; source: SourceAck; mode: 'steer' | 'follow-up' | 'queue' }
  | { kind: 'admitted'; eventIds: string[] }
  | { kind: 'bound'; assemblyId: string; eventIds: string[] }
  | { kind: 'response'; attemptId: string; source: SourceAck; calls: { callId: string; name: string; argumentsHash: string }[] }
  | { kind: 'file-prepared'; admission: FileAdmission }
  | { kind: 'file-approved'; callId: string; presentationId: string; source: SourceAck }
  | ({ kind: 'file-reconciled'; callId: string; source: SourceAck } & ({ receipt: FileReceipt; failureReason?: never } | { failureReason: FileFailureReason; receipt?: never }))
  | { kind: 'tool-started'; callId: string }
  | { kind: 'tool-result'; result: ToolResult }
  | { kind: 'terminal'; terminal: RunTerminal };
export interface AgentStatus {
  terminal: RunTerminal | null;
  attempts: number;
  inputs: { source: SourceAck; mode: 'steer' | 'follow-up' | 'queue'; state: 'received' | 'admitted-to-loop' | 'bound-to-assembly' }[];
  tools: ToolFact[];
  files: { admission: FileAdmission; approved: boolean; approvalSource?: SourceAck; reconciled?: FileReceipt; failureReason?: FileFailureReason }[];
  responses: { attemptId: string; source: SourceAck }[];
}
export function replayAgent(events: AgentEvent[], attempts: number): AgentStatus {
  const state: AgentStatus = { terminal: null, attempts, inputs: [], responses: [], tools: [], files: [] };
  check(events[0]?.kind === 'opened', 'agent-evidence-gap');
  for (const [index, event] of events.entries()) {
    check(!state.terminal || event.kind === 'file-reconciled', 'agent-event-after-terminal');
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
      case 'file-prepared': {
        const tool = state.tools.find(tool => tool.callId === event.admission.callId);
        check(tool && !tool.started && !tool.result && tool.name === event.admission.operation
          && !state.files.some(file => file.admission.callId === tool.callId), 'file-not-admissible');
        state.files.push({ admission: event.admission, approved: false }); break;
      }
      case 'file-approved': {
        const file = state.files.find(file => file.admission.callId === event.callId);
        const tool = state.tools.find(tool => tool.callId === event.callId);
        check(file && !file.approved && file.admission.presentationId === event.presentationId && tool && !tool.started && !tool.result, 'file-approval-stale');
        file.approved = true; file.approvalSource = event.source; break;
      }
      case 'file-reconciled': {
        const file = state.files.find(file => file.admission.callId === event.callId);
        const tool = state.tools.find(tool => tool.callId === event.callId);
        check(file && !file.reconciled && !file.failureReason && tool?.started && tool.result?.outcome === 'unknown', 'file-reconciliation-denied');
        if (event.receipt) file.reconciled = event.receipt;
        else file.failureReason = event.failureReason;
        break;
      }
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
