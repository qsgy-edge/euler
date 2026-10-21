import { CORE_TOOLS, sha256 } from '../contracts.ts';

const string = { type: 'string' };
const schemas: Record<(typeof CORE_TOOLS)[number], Record<string, unknown>> = {
  'skill.search': { query: string },
  'memory.search': { query: string },
  'source.search': { query: string },
  'source.expand': { eventId: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 4096 } },
  'memory.inspect': { recordId: string },
  'memory.preview': { presentationId: string, operation: { type: 'string', enum: ['correct', 'forget', 'restore', 'rollback'] } },
  'memory.commit': { operationId: string },
  'memory.cancel': { operationId: string },
};
export interface ToolSchema { name: string; version: string; hash: string; description: string; parameters: Record<string, unknown>; available: boolean; executionMode: 'parallel-safe' | 'sequential' }
export function coreToolSchemas(options: { corrections?: boolean } = {}): ToolSchema[] {
  return CORE_TOOLS.map(name => {
    const correction = options.corrections && ['memory.inspect', 'memory.preview', 'memory.commit', 'memory.cancel'].includes(name);
    const mutation = { type: 'string', enum: ['forget', 'restore'] };
    const fields = correction ? name === 'memory.inspect' ? { recordId: string }
      : name === 'memory.preview' ? { recordId: string, content: string, operation: mutation }
      : name === 'memory.commit' ? { token: string, content: string, operation: mutation } : { token: string } : schemas[name];
    const change = correction && ['memory.preview', 'memory.commit'].includes(name);
    const parameters = { type: 'object', properties: structuredClone(fields),
      required: change ? [name === 'memory.preview' ? 'recordId' : 'token'] : Object.keys(fields), additionalProperties: false,
      ...(change ? { oneOf: [{ required: ['content'] }, { required: ['operation'] }] } : {}) };
    return { name, version: correction ? '3' : '1', hash: sha256(JSON.stringify({ name, parameters })), parameters,
      available: Boolean(correction), executionMode: 'sequential', description: correction
        ? `${name}: propose the exact inspect/correct/forget/restore/commit/cancel command from the live user input; use content for correct or operation for forget/restore. The Host revalidates input, token and change. Confirmation fields grant no authority.`
        : `${name}: unavailable in this controlled CLI slice.` };
  });
}
export function controlledToolSchema(): ToolSchema {
  const parameters = { type: 'object', properties: { text: { type: 'string', maxLength: 1024 } }, required: ['text'], additionalProperties: false };
  return { name: 'controlled.echo', version: '1', hash: sha256(JSON.stringify(parameters)), available: true, executionMode: 'parallel-safe',
    description: 'Echo at most 1024 characters of synthetic text; no file, network or memory effects.', parameters };
}
