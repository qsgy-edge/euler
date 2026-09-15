import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Model } from '@earendil-works/pi-ai';
import { check, CORE_TOOLS, sha256 } from '@euler/core';
import type { ModelReply, ModelRequest, NeutralRequest, ProbeBudget } from '@euler/core';
import type { AuthorizeSend } from './agent-pump.ts';

// A single text/tool protocol using the pi-ai Model interface. No SDK auth
// discovery, hooks, redirects or retry machinery runs on this send path.
export class HttpModelTransport {
  readonly #model: Model<'openai-completions'>;
  readonly #budget: ProbeBudget;
  readonly #credential: () => string;
  readonly #url: URL;
  #count = 0;
  get count(): number { return this.#count; }
  constructor(model: Model<'openai-completions'>, budget: ProbeBudget, credential: () => string) {
    this.#model = structuredClone(model); this.#budget = { ...budget }; this.#credential = credential;
    check(model.api === 'openai-completions' && !model.reasoning && !model.headers, 'unsupported-model-contract');
    const base = new URL(model.baseUrl);
    check(!base.username && !base.password && !base.search && !base.hash, 'unsafe-endpoint');
    check(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)), 'https-required');
    check(budget.contextLimit <= model.contextWindow && budget.outputReserve <= model.maxTokens, 'model-budget-mismatch');
    this.#url = new URL(base.href.replace(/\/$/, '') + '/chat/completions');
  }
  encode(request: NeutralRequest): string {
    check(request.provider === this.#model.provider && request.model === this.#model.id && request.route === this.#model.baseUrl, 'route-mismatch');
    const messages: Record<string, unknown>[] = [{ role: 'system', content: request.p0.policy }];
    for (const turn of request.p2) {
      messages.push(...turn.inputs);
      messages.push({ role: 'assistant', content: turn.assistant.text || null,
        ...(turn.assistant.calls.length ? { tool_calls: turn.assistant.calls.map(call => ({ id: call.id, type: 'function',
          function: { name: call.name.replaceAll('.', '_'), arguments: JSON.stringify(call.arguments) } })) } : {}) });
      messages.push(...turn.results.map(result => ({ role: 'tool', tool_call_id: result.callId, content: JSON.stringify({ outcome: result.outcome, result: result.modelResult }) })));
    }
    messages.push(...request.p3.messages);
    // Intent is bounded data, never a provider-supplied instruction channel.
    const firstUser = messages.findIndex(message => message.role === 'user');
    if (firstUser >= 0) messages[firstUser] = { ...messages[firstUser],
      content: JSON.stringify({ input: messages[firstUser]!.content, intent: request.p3.intent }) };
    return JSON.stringify({ model: this.#model.id, stream: false, max_tokens: this.#budget.outputReserve, messages,
      tools: request.p0.tools.map(tool => ({ type: 'function', function: { name: tool.name.replaceAll('.', '_'), description: tool.description, parameters: tool.parameters } })) });
  }
  async *stream(request: ModelRequest, signal: AbortSignal, authorizeSend: AuthorizeSend): AsyncIterable<{ kind: 'complete'; reply: ModelReply }> {
    const credential = this.#credential();
    check(typeof credential === 'string' && credential.length > 0 && credential.length <= 8192 && !/[\r\n]/.test(credential), 'credential-unavailable');
    const payload = request.payload; // primitive, immutable final bytes
    const received = await new Promise<{ body: string; status: number }>((resolve, reject) => {
      try {
        signal.throwIfAborted();
        authorizeSend(payload); // durable started + final payload/cancellation check
        const send = this.#url.protocol === 'https:' ? httpsRequest : httpRequest;
        const outgoing = send(this.#url, { method: 'POST', agent: false, signal,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${credential}` } }, response => {
          const chunks: Buffer[] = []; let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 65536) { response.destroy(new Error('response-limit')); return; }
            chunks.push(chunk);
          });
          response.on('error', () => reject(new Error('response-interrupted')));
          response.on('end', () => {
            if (!response.complete) { reject(new Error('response-interrupted')); return; }
            try { resolve({ body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), status: response.statusCode ?? 0 }); }
            catch { reject(new Error('response-encoding')); }
          });
        });
        outgoing.on('error', () => reject(new Error('transport-unknown')));
        this.#count++;
        outgoing.end(payload);
      } catch (error) { reject(error); }
    });
    if (received.status !== 200) {
      yield { kind: 'complete', reply: { text: 'Provider request failed.', calls: [], stop: 'error' } }; return;
    }
    check(!received.body.includes(credential), 'response-contained-credential');
    const data = JSON.parse(received.body) as { model?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }; choices?: { finish_reason?: string; message?: { role?: string; content?: unknown; tool_calls?: unknown } }[] };
    check(Array.isArray(data.choices) && data.choices.length === 1, 'invalid-provider-response');
    const choice = data.choices[0]!, message = choice.message;
    check(message?.role === 'assistant' && (message.content === null || typeof message.content === 'string'), 'invalid-provider-message');
    const toolCalls = message.tool_calls ?? [];
    check(Array.isArray(toolCalls) && toolCalls.length <= 128, 'invalid-provider-tools');
    const calls = toolCalls.map((call: { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }) => {
      check(call.type === 'function' && typeof call.id === 'string' && typeof call.function?.name === 'string' && typeof call.function.arguments === 'string', 'invalid-provider-tool');
      const name = call.function.name;
      // Exact fixed namespace mapping; unknown names stay unknown to Core.
      const known = ['controlled.echo', ...CORE_TOOLS];
      return { id: call.id, name: known.find(candidate => candidate.replaceAll('.', '_') === name) ?? name,
        arguments: JSON.parse(call.function.arguments) as Record<string, unknown> };
    });
    check(['stop', 'tool_calls', 'length'].includes(choice.finish_reason ?? ''), 'unsupported-stop-reason');
    const usage = data.usage;
    const validUsage = usage && [usage.prompt_tokens, usage.completion_tokens].every(value => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000);
    yield { kind: 'complete', reply: { text: message.content ?? '', calls,
      ...(validUsage ? { usage: { input: Number(usage.prompt_tokens), output: Number(usage.completion_tokens) } } : {}),
      ...(typeof data.model === 'string' && data.model.length <= 256 ? { modelHash: sha256(data.model) } : {}),
      stop: choice.finish_reason === 'tool_calls' ? 'tools' : choice.finish_reason === 'length' ? 'length' : 'end' } };
  }
}
