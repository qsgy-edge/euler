import { check, sameBinding, sha256, uuid } from '../contracts.ts';
import type { HostAdapter, SourceAck } from '../contracts.ts';
import type { Activity, ProbeStore, SourceExpandRequest } from '../store/probe-store.ts';

type Archive = HostAdapter['source'] & { append(eventId: string, text: string, role?: 'user' | 'assistant' | 'tool'): SourceAck };
export interface ArtifactEvidence { request: SourceExpandRequest; hash: string }
interface EvidenceRef { request: SourceExpandRequest; hash: string; projectId: string }
export interface AnalysisHeader {
  schema: 'analysis-artifact@1'; kind: 'report' | 'handoff' | 'export'; artifactId: string; version: number;
  task: SourceAck; intentId: string; supersedes: SourceAck | null; bodyHash: string; requestHash: string;
  evidence: EvidenceRef[]; coverage: { projects: string[]; complete: false };
  exportInputs?: { selection: ExportSelection[]; approval: SourceAck };
}
export interface AnalysisArtifact extends AnalysisHeader { ref: SourceAck; body: string; bodyOffset: number }
export interface ReportInput {
  eventId: string; title: string; facts: string; inferences: string; recommendations: string; unresolved: string;
  evidence: ArtifactEvidence[]; supersedes?: SourceAck;
}
export interface HandoffInput { eventId: string; title: string; markdown: string; evidence: ArtifactEvidence[]; supersedes?: SourceAck }
export interface ExportSelection { unitId: string; hash: string }
const PREFIX = '<!-- euler-analysis-artifact@1 ';

export function parseAnalysisArtifact(text: string): { header: AnalysisHeader; body: string; bodyOffset: number } | null {
  if (!text.startsWith(PREFIX)) return null;
  const split = text.indexOf(' -->\n\n');
  if (split === -1) return null;
  check(split >= PREFIX.length && split <= 32768, 'analysis-artifact-integrity');
  let header: AnalysisHeader;
  try { header = JSON.parse(text.slice(PREFIX.length, split)) as AnalysisHeader; }
  catch { throw new Error('analysis-artifact-integrity'); }
  const start = split + ' -->\n\n'.length;
  const body = text.slice(start);
  check(header.schema === 'analysis-artifact@1' && ['report','handoff','export'].includes(header.kind)
    && Number.isSafeInteger(header.version) && header.version > 0 && /^[a-f0-9]{64}$/.test(header.requestHash)
    && sha256(body) === header.bodyHash && Array.isArray(header.evidence) && header.evidence.length <= 16
    && Array.isArray(header.coverage?.projects) && header.coverage.complete === false, 'analysis-artifact-integrity');
  uuid(header.artifactId); uuid(header.intentId);
  return { header, body, bodyOffset: Array.from(text.slice(0, start)).length };
}

/** Task documents stay in their source owner's archive. Publication and proposals use existing Store owners. */
export class AnalysisArtifacts {
  readonly #store: ProbeStore;
  readonly #activity: Activity;
  readonly #archive: Archive;
  constructor(store: ProbeStore, activity: Activity, archive: Archive) { this.#store = store; this.#activity = activity; this.#archive = archive; }

  saveReport(input: ReportInput): AnalysisArtifact {
    check(input && Object.keys(input).every(key => ['eventId','title','facts','inferences','recommendations','unresolved','evidence','supersedes'].includes(key)), 'invalid-analysis-report');
    for (const text of [input.title, input.facts, input.inferences, input.recommendations, input.unresolved]) check(typeof text === 'string' && text.trim().length > 0, 'invalid-analysis-report');
    const body = `# ${input.title}\n\n状态：分析结果与待验证建议，不构成已采纳决定或执行授权。\n\n## 事实\n\n${input.facts}\n\n## 推断\n\n${input.inferences}\n\n## 建议\n\n${input.recommendations}\n\n## 未决问题\n\n${input.unresolved}\n`;
    return this.#save('report', input.eventId, body, input.evidence, input.supersedes, sha256(JSON.stringify(input)));
  }
  saveHandoff(input: HandoffInput): AnalysisArtifact {
    check(input && Object.keys(input).every(key => ['eventId','title','markdown','evidence','supersedes'].includes(key))
      && typeof input.title === 'string' && input.title.trim().length > 0, 'invalid-analysis-handoff');
    return this.#save('handoff', input.eventId, input.markdown, input.evidence, input.supersedes, sha256(JSON.stringify(input)));
  }
  #save(kind: AnalysisHeader['kind'], eventId: string, body: string, evidence: ArtifactEvidence[], supersedes: SourceAck | undefined, requestHash: string,
    exportInputs?: AnalysisHeader['exportInputs']): AnalysisArtifact {
    uuid(eventId);
    check(typeof body === 'string' && body.trim().length > 0 && Buffer.byteLength(body) <= 49152
      && Array.isArray(evidence) && evidence.length <= 16, 'invalid-analysis-artifact');
    const existing = this.#archive.lookup(eventId);
    if (existing) {
      const saved = this.#read(existing, false);
      check(saved.requestHash === requestHash && saved.kind === kind && saved.body === body, 'analysis-identity-conflict');
      return saved;
    }
    const intent = this.#store.readIntent(this.#activity);
    check(intent?.status === 'active', 'analysis-task-required');
    const prior = supersedes ? this.read(supersedes) : null;
    check(!prior || prior.kind === kind && prior.intentId === intent.intentId && sameBinding(prior.ref.binding, intent.binding), 'analysis-version-mismatch');
    const refs: EvidenceRef[] = evidence.map(item => {
      check(item && Object.keys(item).sort().join(',') === 'hash,request', 'invalid-analysis-evidence');
      const excerpt = 'unitId' in item.request ? this.#store.expandSource(this.#activity, item.request)
        : this.#store.expandSource(this.#activity, item.request);
      check(excerpt.excerptHash === item.hash, 'analysis-evidence-stale');
      return { request: structuredClone(item.request), hash: item.hash,
        projectId: 'projectId' in excerpt ? excerpt.projectId : excerpt.ref.binding.projectId };
    });
    const header: AnalysisHeader = { schema: 'analysis-artifact@1', kind, artifactId: prior?.artifactId ?? eventId,
      version: prior ? prior.version + 1 : 1, task: intent.goalInput, intentId: intent.intentId,
      supersedes: supersedes ?? null, bodyHash: sha256(body), requestHash, evidence: refs,
      coverage: { projects: [...new Set(refs.map(ref => ref.projectId))].sort(), complete: false },
      ...(exportInputs ? { exportInputs: structuredClone(exportInputs) } : {}) };
    const text = PREFIX + JSON.stringify(header) + ' -->\n\n' + body;
    // The owner's append/lookup protocol supplies identity reconciliation and durable readback.
    const ref = this.#archive.append(eventId, text, 'assistant');
    check(this.#archive.read(ref).text === text, 'analysis-durable-ack-required');
    return { ...header, ref, body, bodyOffset: Array.from(PREFIX + JSON.stringify(header) + ' -->\n\n').length };
  }
  read(ref: SourceAck): AnalysisArtifact { return this.#read(ref, true); }
  #read(ref: SourceAck, taskAccess: boolean): AnalysisArtifact {
    if (taskAccess) this.#store.expandSource(this.#activity, { ref, offset: 0, limit: 1 });
    const read = this.#archive.read(ref);
    check(read.role === 'assistant', 'analysis-owner-mismatch');
    const parsed = parseAnalysisArtifact(read.text);
    check(parsed && sameBinding(parsed.header.task.binding, ref.binding), 'analysis-artifact-integrity');
    this.#store.validateAnalysisSource(this.#activity, ref);
    return { ...parsed.header, ref, body: parsed.body, bodyOffset: parsed.bodyOffset };
  }
  exportMarkdown(input: { eventId: string; selection: ExportSelection[]; approval: SourceAck }): { ref: SourceAck; markdown: string; hash: string } {
    const markdown = this.#store.renderAnalysisExport(this.#activity, input.selection, input.approval);
    const saved = this.#save('export', input.eventId, markdown, [], undefined,
      sha256(JSON.stringify({ selection: input.selection, approval: input.approval })),
      { selection: input.selection, approval: input.approval });
    return { ref: saved.ref, markdown, hash: sha256(markdown) };
  }
}
