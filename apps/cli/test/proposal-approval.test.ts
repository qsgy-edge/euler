import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';
import { openProbe } from '../src/probe.ts';

test('plain mixed Markdown cannot publish a project proposal without exact owner approval', () => {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  try {
    const report = probe.archive.append(randomUUID(), '# Project A and B analysis\nPRIVATE_PROJECT_B', 'assistant');
    const generic = probe.archive.append(randomUUID(), 'Save a proposal');
    const proposal = { target: 'Project A', expectedChange: 'PRIVATE_PROJECT_B', owner: sandbox.fixture.ownerId,
      scope: { kind: 'project' as const, id: sandbox.fixture.projectId, resolved: true }, evidenceRefs: [report],
      evaluation: { schema: 'evaluation-contract@1' as const, level: 'L0' as const, assertions: ['Synthetic'] } };
    for (const input of [report, generic]) assert.throws(() => probe.store.saveEvolutionProposal(probe.activity, input, proposal), /proposal-publication-approval/);
    const approved = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'analysis-proposal-approval@1', proposal }));
    assert.throws(() => probe.store.saveEvolutionProposal(probe.activity, approved, { ...proposal, expectedChange: 'OTHER_UNAPPROVED_CONTENT' }), /proposal-publication-approval/);
    probe.store.drainSourceProjection(probe.activity);
    assert.equal(probe.store.searchSources(probe.activity, { query: 'PRIVATE_PROJECT_B' }).results.length, 0);
  } finally { probe.close(); rmSync(sandbox.root, { recursive: true, force: true }); }
});
