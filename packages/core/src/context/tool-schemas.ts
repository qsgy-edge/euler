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
export function coreToolSchemas(): ToolSchema[] {
  return CORE_TOOLS.map(name => {
    const parameters = { type: 'object', properties: structuredClone(schemas[name]), required: Object.keys(schemas[name]), additionalProperties: false };
    return { name, version: '1', hash: sha256(JSON.stringify({ name, parameters })), parameters,
      available: false, executionMode: 'sequential', description: `${name}: unavailable in this controlled CLI slice.` };
  });
}
export function controlledToolSchema(): ToolSchema {
  const parameters = { type: 'object', properties: { text: { type: 'string', maxLength: 1024 } }, required: ['text'], additionalProperties: false };
  return { name: 'controlled.echo', version: '1', hash: sha256(JSON.stringify(parameters)), available: true, executionMode: 'parallel-safe',
    description: 'Echo at most 1024 characters of synthetic text; no file, network or memory effects.', parameters };
}
