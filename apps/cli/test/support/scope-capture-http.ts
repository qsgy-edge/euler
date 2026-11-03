import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SourceAck } from '@euler/core';

export function scopeCaptureResponder(claim: string, recordRequest: (body: string) => void) {
  let ordinal = 0;
  return async (request: IncomingMessage, response: ServerResponse) => {
    let body = ''; for await (const chunk of request) body += chunk;
    recordRequest(body);
    const { messages } = JSON.parse(body), tail = JSON.parse(messages.at(-1).content);
    const results = messages.filter((message: { role: string }) => message.role === 'tool')
      .map((message: { content: string }) => JSON.parse(JSON.parse(message.content).result));
    const expanded = results.find((result: { ref?: SourceAck; text?: string }) => result.ref && typeof result.text === 'string');
    const search = results.find((result: { results?: unknown[] }) => result.results);
    const call = tail.intent.step === 'proposer' || expanded ? null : search
      ? { name: 'source_expand', arguments: JSON.stringify({ eventId: search.results[0].ref.eventId, offset: 0, limit: 4096 }) }
      : { name: 'source_search', arguments: JSON.stringify({ query: 'rawscope' }) };
    const content = call ? null : tail.intent.step === 'proposer'
      ? JSON.stringify({ type: 'decision', content: claim }) : JSON.stringify({ result: 'pass', evidence: [expanded.ref] });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content,
      ...(call ? { tool_calls: [{ id: 'scope-' + ++ordinal, type: 'function', function: call }] } : {}) },
      finish_reason: call ? 'tool_calls' : 'stop' }] }));
  };
}
