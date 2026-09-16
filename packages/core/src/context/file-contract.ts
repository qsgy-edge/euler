import { check, sameBinding, sha256 } from '../contracts.ts';
import type { Binding, SourceAck } from '../contracts.ts';
import type { BoundFile, FileIdentity } from '../store/probe-store.ts';
import type { ToolCall } from './agent-state.ts';
import type { ToolSchema } from './tool-schemas.ts';

export interface FileCapability {
  schema: 'file-capability@1'; grantId: string; binding: Binding; root: BoundFile; source: SourceAck;
}
export interface FileTarget { path: string; parent: BoundFile; identity: FileIdentity | null }
export interface FileAdmission {
  callId: string; presentationId: string; capabilityHash: string; intentEventId: string; intentHash: string; epoch: number;
  operation: 'file.read' | 'file.write'; rawPath: string; parts: string[]; root: BoundFile; target: FileTarget;
  cleanup: 'host-project-resource'; source: SourceAck;
}
export type FileFailureReason = 'file-output-too-large' | 'file-invalid-utf8' | 'file-create-conflict' | 'file-create-denied';
export interface FileReceipt { identity: FileIdentity; byteLength: number; text?: string }
export interface FilePresentation { token: string; callId: string; path: string; existingIdentity: FileIdentity | null; content: string }
export type FileDecision = 'approved' | 'rejected' | 'unavailable';

export function fileToolSchemas(): ToolSchema[] {
  return ['file.read', 'file.write'].map(name => {
    const parameters = { type: 'object', properties: { path: { type: 'string', maxLength: 2048 },
      ...(name === 'file.write' ? { content: { type: 'string', maxLength: 4096 } } : {}) },
      required: name === 'file.read' ? ['path'] : ['path', 'content'], additionalProperties: false };
    const descriptor = { name, version: '1', available: true, executionMode: 'sequential' as const, parameters,
      description: name === 'file.read' ? 'Read at most 4096 UTF-8 bytes from the explicitly bound project root. URL and reparse points unavailable.'
        : 'Write at most 4096 UTF-8 bytes after the owner approves this exact target and complete content. URL and reparse points unavailable.' };
    return { ...descriptor, hash: sha256(JSON.stringify(descriptor)) };
  });
}
export function parseFileCall(call: ToolCall): { parts: string[]; operation: 'file.read' | 'file.write'; rawPath: string; content?: string } {
  check(call.name === 'file.read' || call.name === 'file.write', 'file-tool-unavailable');
  const { path, content } = call.arguments;
  check(Object.keys(call.arguments).sort().join(',') === (call.name === 'file.read' ? 'path' : 'content,path'), 'invalid-file-arguments');
  check(typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 2048, 'invalid-file-path');
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new Error('file-ambiguous-path'); }
  // Exactly one protocol decode. A residual percent is rejected; no downstream decoder.
  check(!decoded.includes('%') && !/[\x00-\x1f\x7f<>:"|?*]/u.test(decoded) && !/[\uD800-\uDFFF]/u.test(decoded), 'file-ambiguous-path');
  const parts = decoded.replaceAll('\\', '/').split('/');
  check(parts.length <= 32 && parts.every(part => part.length > 0 && part !== '..'), 'file-outside-root');
  const normalized = parts.filter(part => part !== '.');
  check(normalized.length > 0 && normalized.every(part => part.length <= 255 && !/[ .]$/.test(part)
    && !/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)), 'file-ambiguous-path');
  if (call.name === 'file.write') check(typeof content === 'string' && Buffer.byteLength(content) <= 4096, 'invalid-file-content');
  return { parts: normalized, operation: call.name, rawPath: path, ...(call.name === 'file.write' ? { content: content as string } : {}) };
}
export function validateFileCapability(capability: FileCapability, binding: Binding): void {
  check(capability.schema === 'file-capability@1' && sameBinding(capability.binding, binding)
    && sameBinding(capability.source.binding, binding) && /^[0-9a-f-]{36}$/.test(capability.grantId), 'file-owner-mismatch');
  check(typeof capability.root.path === 'string' && capability.root.path.length <= 2048
    && /^\d+$/.test(capability.root.identity.dev) && /^\d+$/.test(capability.root.identity.ino), 'file-root-identity-required');
}
