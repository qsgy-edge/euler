import { randomUUID } from 'node:crypto';
import type { SourceUnitInput } from '@euler/core';
import { openProbe } from '../../src/probe.ts';

export function approvedSourceUnit(probe: ReturnType<typeof openProbe>, input: Omit<SourceUnitInput, 'approval'>): SourceUnitInput {
  const current = probe.store.readIntent(probe.activity);
  const intent = current ?? (() => {
    const goal = probe.archive.append(randomUUID(), 'Publish synthetic source', 'user');
    return probe.store.transitionIntent(probe.activity, null, goal, { step: 'publication', status: 'active' },
      'Publish synthetic source');
  })();
  const approval = probe.archive.append(randomUUID(), JSON.stringify({ schema: 'source-publication-approval@1',
    intentId: intent.intentId, goalEventId: intent.goalInput.eventId, ref: input.ref, projectId: input.projectId,
    kind: input.kind, offset: input.offset, length: input.length }), 'user');
  return { ...input, approval };
}
