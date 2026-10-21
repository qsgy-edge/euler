import { randomUUID } from 'node:crypto';
import { createSandbox } from '../../src/sandbox.ts';
import { openProbe } from '../../src/probe.ts';

/** Seed a fixed synthetic batch through the existing public Store boundary. */
export function rollbackFixture(count = 2) {
  const sandbox = createSandbox(), probe = openProbe(sandbox);
  const candidates = Array.from({ length: count }, (_, index) => {
    const source = probe.archive.append(randomUUID(), `合成批次来源 ${index}`);
    const candidate = probe.store.captureMemory(probe.activity, source, `合成批次偏好 ${index}`, {
      type: 'preference', scope: { kind: 'project', id: sandbox.fixture.projectId, resolved: true }, appliesTo: [],
    }).record;
    return probe.store.verifyMemory(probe.activity, candidate.recordId, candidate, 'pass', [source]).record;
  });
  const batch = probe.store.activateMemoryBatch(probe.activity, candidates);
  probe.store.registerHostInfo(probe.activity);
  return { sandbox, probe, batch, candidates };
}
