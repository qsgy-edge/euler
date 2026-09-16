import { check, parseFileCall } from '@euler/core';
import type { FileCapability, FileDecision, FilePresentation, ToolCall } from '@euler/core';
import type { AgentPump } from './agent-pump.ts';
import { WindowsFileRoot } from './windows-files.ts';

// This callback is the independent Host input channel, never a model argument.
export function createFileToolHost(requestApproval: (presentation: FilePresentation, signal: AbortSignal) => Promise<FileDecision>): Pick<AgentPump, 'prepareFile' | 'requestFileApproval'> {
  return {
    requestFileApproval: requestApproval,
    async prepareFile(call: ToolCall, capability: FileCapability, signal: AbortSignal) {
      check(!signal.aborted, 'file-operation-cancelled');
      const parsed = parseFileCall(call);
      const root = new WindowsFileRoot(capability.root);
      try {
        const opened = root.prepare(parsed.parts, parsed.operation);
        return { target: opened.target,
          execute: () => opened.execute(parsed.content, signal),
          close: () => { opened.close(); root.close(); } };
      } catch (error) { root.close(); throw error; }
    },
  };
}
