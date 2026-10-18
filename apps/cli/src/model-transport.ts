import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Model } from '@earendil-works/pi-ai';
import { check, CORE_TOOLS, sha256, validateBudget } from '@euler/core';
import type { CaptureFailure, CaptureRoute, ModelReply, ModelRequest, NeutralRequest, ProbeBudget } from '@euler/core';
import type { AuthorizeSend } from './agent-pump.ts';

export function configuredTransport(path: string) {
  const raw = readFileSync(path, 'utf8');
  check(Buffer.byteLength(raw) <= 8192, 'config-too-large');
  const config = JSON.parse(raw) as { provider: string; model: string; baseUrl: string; authNamespace: string; credentialEnv: string;
    contextWindow: number; maxTokens: number; budget: ProbeBudget; authorization: string; captureCapability?: CaptureRoute['capability'] };
  check(Object.keys(config).filter(key => key !== 'captureCapability').sort().join(',') === ['provider', 'model', 'baseUrl', 'authNamespace', 'credentialEnv', 'contextWindow', 'maxTokens', 'budget', 'authorization'].sort().join(','), 'invalid-transport-config');
  check(config.authorization === 'synthetic-test-only' && /^[A-Z][A-Z0-9_]{1,100}$/.test(config.credentialEnv), 'test-authorization-required');
  check(config.captureCapability === undefined || ['basic','standard','high'].includes(config.captureCapability), 'invalid-capture-capability');
  validateBudget(config.budget);
  check(Number.isSafeInteger(config.contextWindow) && Number.isSafeInteger(config.maxTokens), 'invalid-model-limits');
  const model: Model<'openai-completions'> = { api: 'openai-completions', provider: config.provider, id: config.model, name: config.model,
    baseUrl: config.baseUrl, reasoning: false, input: ['text'], contextWindow: config.contextWindow, maxTokens: config.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  // Credentials are resolved only from the operator's explicitly selected test environment variable.
  check(Boolean(process.env[config.credentialEnv]), 'credential-unavailable');
  return { model, budget: config.budget, authNamespace: config.authNamespace, captureCapability: config.captureCapability ?? null,
    transport: new HttpModelTransport(model, config.budget, () => process.env[config.credentialEnv] ?? '') };
}

export async function verifyTransportPrerequisites(extraTests: string[] = [], event = 'agent-prerequisites', signal?: AbortSignal): Promise<void> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const tests = ['archive', 'persistence', 'search-projection', 'request-ledger', 'request-recovery', 'request-admission', 'request-ledger-boundaries', 'agent-run', 'agent-boundaries', 'model-transport', ...extraTests]
    .map(name => `apps/cli/test/${name}.test.ts`);
  // Bound the nested file pool while allowing independent durable I/O to overlap.
  const command = ['--test', '--test-concurrency=4', ...tests];
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, command, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4_194_304,
      env, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : null : 0, stdout, stderr }));
  });
  process.stdout.write(JSON.stringify({ event, command: ['node', ...command], exitCode: result.status,
    outputHash: sha256((result.stdout ?? '') + (result.stderr ?? '')), passed: result.status === 0 }) + '\n');
  signal?.throwIfAborted();
  check(result.status === 0, 'prerequisite-evidence-gap');
}

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
  async *stream(request: ModelRequest, signal: AbortSignal, authorizeSend: AuthorizeSend): AsyncIterable<{ kind: 'complete'; reply: ModelReply; failure?: CaptureFailure; responseHash?: string }> {
    const credential = this.#credential();
    check(typeof credential === 'string' && credential.length > 0 && credential.length <= 8192 && !/[\r\n]/.test(credential), 'credential-unavailable');
    const payload = request.payload; // primitive, immutable final bytes
    const received = await new Promise<{ body: Buffer; status: number }>((resolve, reject) => {
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
            resolve({ body: Buffer.concat(chunks), status: response.statusCode ?? 0 });
          });
        });
        outgoing.on('error', () => reject(new Error('transport-unknown')));
        this.#count++;
        outgoing.end(payload);
      } catch (error) { reject(error); }
    });
    const responseHash = sha256(received.body);
    if (received.status !== 200) {
      const failure: CaptureFailure = received.status === 429 ? 'rate-limit' : received.status === 408 ? 'timeout'
        : received.status >= 500 ? 'temporary-unavailable' : 'permanent';
      yield { kind: 'complete', reply: { text: 'Provider request failed.', calls: [], stop: 'error' }, failure, responseHash }; return;
    }
    let body: string;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(received.body); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      yield { kind: 'complete', reply: { text: 'Provider response violated the configured protocol.', calls: [], stop: 'error' }, failure: 'protocol', responseHash }; return;
    }
    check(!body.includes(credential), 'response-contained-credential');
    let reply: ModelReply, failure: CaptureFailure | undefined;
    let usage: ModelReply['usage'], modelHash: string | undefined;
    try {
      const data = JSON.parse(body) as { model?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }; choices?: { finish_reason?: string; message?: { role?: string; content?: unknown; tool_calls?: unknown } }[] };
      check(data && typeof data === 'object', 'invalid-provider-response');
      const observedUsage = data.usage;
      if (observedUsage && [observedUsage.prompt_tokens, observedUsage.completion_tokens].every(value => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000))
        usage = { input: Number(observedUsage.prompt_tokens), output: Number(observedUsage.completion_tokens) };
      if (typeof data.model === 'string' && data.model.length <= 256) modelHash = sha256(data.model);
      check(Array.isArray(data.choices) && data.choices.length === 1 && data.choices[0], 'invalid-provider-response');
      const choice = data.choices[0]!, message = choice.message;
      check(message?.role === 'assistant' && (message.content === null || typeof message.content === 'string'), 'invalid-provider-message');
      const toolCalls = message.tool_calls ?? [];
      check(Array.isArray(toolCalls) && toolCalls.length <= 128, 'invalid-provider-tools');
      const calls = toolCalls.map((call: { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }) => {
        check(call && call.type === 'function' && typeof call.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(call.id)
          && typeof call.function?.name === 'string' && typeof call.function.arguments === 'string', 'invalid-provider-tool');
        const name = call.function.name, argumentsValue: unknown = JSON.parse(call.function.arguments);
        check(argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue), 'invalid-provider-tool');
        // Exact fixed namespace mapping; unknown names stay unknown to Core.
        const known = ['controlled.echo', ...CORE_TOOLS];
        return { id: call.id, name: known.find(candidate => candidate.replaceAll('.', '_') === name) ?? name,
          arguments: argumentsValue as Record<string, unknown> };
      });
      check(new Set(calls.map(call => call.id)).size === calls.length, 'invalid-provider-tools');
      check(['stop', 'tool_calls', 'length'].includes(choice.finish_reason ?? '')
        && (calls.length > 0) === (choice.finish_reason === 'tool_calls'), 'unsupported-stop-reason');
      reply = { text: message.content ?? '', calls,
        stop: choice.finish_reason === 'tool_calls' ? 'tools' : choice.finish_reason === 'length' ? 'length' : 'end' };
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error &&
        ['invalid-provider-response','invalid-provider-message','invalid-provider-tools','invalid-provider-tool','unsupported-stop-reason'].includes(error.message))) throw error;
      failure = 'protocol';
      reply = { text: 'Provider response violated the configured protocol.', calls: [], stop: 'error' };
    }
    yield { kind: 'complete', responseHash, ...(failure ? { failure } : {}),
      reply: { ...reply, ...(usage ? { usage } : {}), ...(modelHash ? { modelHash } : {}) } };
  }
}
