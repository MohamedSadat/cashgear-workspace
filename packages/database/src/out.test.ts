// After 0.19.0: a database block's rows leave the page as text a slice at a time, the main thread
// given back between slices; what is written is the same as all at once, grouped or not.
import { describe, expect, it } from 'vitest';
import { viewOut } from './out';
import { P, seed } from './testing';

const say = (key: string) => key;

describe('a database block as it leaves the page', () => {
  it('is the same text cut into slices as all at once', async () => {
    const { host, tasksId, viewId } = seed(120);
    const whole = await viewOut(host, tasksId, viewId, { say, locale: 'en', sliceMs: Infinity });
    const sliced = await viewOut(host, tasksId, viewId, { say, locale: 'en', sliceMs: 0 });
    expect(whole.kind === 'table' && whole.rows).toHaveLength(120);
    expect(sliced).toEqual(whole);
  });

  it('is the same text cut into slices as all at once in a grouped view', async () => {
    const { host, tasksId, viewId } = seed(90);
    const view = host.views(tasksId)[0];
    await host.apply([
      {
        opId: 'g',
        type: 'view.upsert',
        workspaceId: view.workspaceId,
        entityId: viewId,
        baseVersion: null,
        createdAt: new Date().toISOString(),
        payload: { ...view, config: { ...view.config, group: { propertyId: P.status } } },
      },
    ]);
    const whole = await viewOut(host, tasksId, viewId, { say, locale: 'en', sliceMs: Infinity });
    const sliced = await viewOut(host, tasksId, viewId, { say, locale: 'en', sliceMs: 0 });
    expect(whole.kind === 'table' && whole.groups?.length).toBeGreaterThan(1);
    expect(whole.kind === 'table' && whole.rows).toHaveLength(90);
    expect(sliced).toEqual(whole);
  });
});
