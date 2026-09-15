import { check } from '@euler/core';
import type { AgentRun, AgentStatus, ModelReply, ModelRequest, ToolCall, RequestAttempt } from '@euler/core';
export type AuthorizeSend = (payload: string) => RequestAttempt;

export interface AgentPump {
  stream(request: ModelRequest, signal: AbortSignal, authorizeSend: AuthorizeSend): AsyncIterable<{ kind: 'partial' | 'complete'; reply: ModelReply }>;
  execute(call: ToolCall, signal: AbortSignal): Promise<string>;
}
// Always observe the original promise, including implementations that ignore
// AbortSignal. Late completion has no Core callback or archival side effect.
async function untilStopped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    listener = () => reject(new Error('run-stopped'));
    if (signal.aborted) listener(); else signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener('abort', listener); }
}
export async function pumpAgent(run: AgentRun, host: AgentPump): Promise<AgentStatus> {
  const deadline = setTimeout(() => { try { run.stop('deadline'); } catch { /* pump observes the durable failure below */ } }, run.remainingMs());
  try {
    while (!run.status().terminal) {
      const request = run.nextModel();
      if (!request) break;
      let attempt: RequestAttempt | undefined;
      const authorizeSend: AuthorizeSend = payload => {
        check(!attempt, 'hidden-retry-denied');
        attempt = run.startModel(request, payload);
        check(run.maySend(attempt.attemptId, payload), 'send-cancelled');
        return attempt;
      };
      let reply: ModelReply | undefined;
      const iterator = host.stream(request, run.signal, authorizeSend)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await untilStopped(iterator.next(), run.signal);
          if (step.done) break;
          if (step.value.kind === 'complete') {
            if (reply) throw new Error('duplicate-model-completion');
            reply = step.value.reply;
          }
        }
      } finally { void iterator.return?.().catch(() => {}); }
      check(reply && attempt, 'incomplete-model-response');
      run.finishModel(attempt.attemptId, reply);
      const execute = async (pending: ToolCall) => {
        if (run.status().terminal) return;
        const call = run.startTool(pending.id);
        if (!call) return;
        let result: string;
        const timeout = setTimeout(() => { try { run.timeoutTool(call.id); } catch { /* no success presentation */ } }, run.toolTimeoutMs);
        try { result = await untilStopped(host.execute(call, run.signal), run.signal); }
        catch {
          if (!run.status().terminal) run.finishTool(call.id, 'Tool failed', 'failure');
          return;
        } finally { clearTimeout(timeout); }
        if (!run.status().terminal) run.finishTool(call.id, result);
      };
      const calls = run.pendingTools();
      if (run.toolBatchMode() === 'parallel-safe') await Promise.all(calls.map(execute));
      else for (const call of calls) await execute(call);
    }
  } catch {
    if (!run.status().terminal) run.fail();
  } finally { clearTimeout(deadline); }
  return run.status();
}
