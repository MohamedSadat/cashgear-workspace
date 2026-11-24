// Phase 15, M15.1 on the device: a database's rules travel as operations (`automation.upsert`,
// `automation.delete`) through the outbox, checked by the planner as the server checks them, and
// never held in the mirror; the feed's `automation` change is the engine's `automations` event; a
// change of a database's properties says how many property types this build knows.
import { describe, expect, it } from 'vitest';
import { newOp } from '../build';
import { KNOWN_PROPERTY_TYPES } from '../db/types';
import type { AutomationRecord } from '../db/automations';
import { uuidv7, type Id } from '../ids';
import { FakeServer } from '../testing/fakeServer';
import { device, makeDatabase, PROP, sharedWorkspace } from '../testing/syncHarness';
import { wirePayload } from './http';

function rule(
  workspaceId: Id,
  databaseId: Id,
  fields: Partial<AutomationRecord> = {},
): AutomationRecord {
  return {
    id: uuidv7(),
    workspaceId,
    databaseId,
    name: 'Mark it seen',
    enabled: true,
    trigger: { kind: 'rowAdded' },
    conditions: null,
    steps: [{ kind: 'set', values: { [PROP.notes]: 'seen' } }],
    authorId: null,
    version: 0,
    createdAt: '',
    updatedAt: '',
    ...fields,
  };
}

describe('automations: records', { timeout: 30_000 }, () => {
  it('a rule saved offline reaches the server once online, the mirror never holding it', async () => {
    const server = new FakeServer();
    const { one, ws, section, a } = await sharedWorkspace(server);
    const { db } = await makeDatabase(one.store, ws.id, section.id, a.id);
    await one.engine.syncOnce();
    const before = await one.store.readMirror(ws.id);
    server.offline = true;
    const made = rule(ws.id, db.id);
    await one.store.applyLocalOp(newOp('automation.upsert', ws.id, made.id, made));
    await expect(one.engine.syncOnce()).rejects.toThrow();
    // Only the outbox holds it.
    expect(await one.store.readMirror(ws.id)).toEqual(before);
    expect((await one.store.nextOutboxBatch(10, ws.id)).map((o) => o.type)).toEqual([
      'automation.upsert',
    ]);
    server.offline = false;
    await one.engine.syncOnce();
    expect(await one.store.nextOutboxBatch(10, ws.id)).toEqual([]);
    const kept = server.automations(ws.id, db.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      id: made.id,
      version: 1,
      steps: [{ kind: 'set', when: null }],
    });
    expect(await one.store.readMirror(ws.id)).toEqual(before);
  });

  it('the planner refuses a rule of no shape and one for a database not held; the server, the rest', async () => {
    const server = new FakeServer();
    const { one, ws, section, a } = await sharedWorkspace(server);
    const { db } = await makeDatabase(one.store, ws.id, section.id, a.id);
    await one.engine.syncOnce();
    const empty = rule(ws.id, db.id, { steps: [] });
    await expect(
      one.store.applyLocalOp(newOp('automation.upsert', ws.id, empty.id, empty)),
    ).rejects.toMatchObject({ code: 'invalid' });
    const elsewhere = rule(ws.id, uuidv7());
    await expect(
      one.store.applyLocalOp(newOp('automation.upsert', ws.id, elsewhere.id, elsewhere)),
    ).rejects.toThrow();
    expect(await one.store.nextOutboxBatch(100, ws.id)).toEqual([]);
    // A title that is not text has the shape of a rule: the server refuses it (the editor would
    // not have sent it), and the outbox lets it go.
    const titled = rule(ws.id, db.id, { steps: [{ kind: 'set', values: { title: 5 as never } }] });
    await one.store.applyLocalOp(newOp('automation.upsert', ws.id, titled.id, titled));
    await one.engine.syncOnce();
    expect(await one.store.nextOutboxBatch(100, ws.id)).toEqual([]);
    expect(server.automations(ws.id, db.id)).toEqual([]);
  });

  it('another device is told of a rule made, changed and deleted, once a page of the feed', async () => {
    const server = new FakeServer();
    const { one, ws, section, a } = await sharedWorkspace(server);
    const { db } = await makeDatabase(one.store, ws.id, section.id, a.id);
    await one.engine.syncOnce();
    const two = device(server);
    await two.engine.syncOnce();
    const before = await two.store.readMirror(ws.id);
    const made = rule(ws.id, db.id);
    await one.store.applyLocalOp(newOp('automation.upsert', ws.id, made.id, made));
    await one.store.applyLocalOp(
      newOp('automation.upsert', ws.id, made.id, { ...made, name: 'Renamed' }),
    );
    await one.engine.syncOnce();
    await two.engine.syncOnce();
    expect(two.events.filter((e) => e.kind === 'automations')).toEqual([
      { kind: 'automations', workspaceId: ws.id, automationIds: [made.id] },
    ]);
    expect(server.automations(ws.id, db.id)[0]).toMatchObject({ name: 'Renamed', version: 2 });
    await one.store.applyLocalOp(newOp('automation.delete', ws.id, made.id, {}));
    await one.engine.syncOnce();
    await two.engine.syncOnce();
    expect(two.events.filter((e) => e.kind === 'automations')).toHaveLength(2);
    expect(server.automations(ws.id, db.id)).toEqual([]);
    expect(await two.store.readMirror(ws.id)).toEqual(before);
  });

  it('a change of properties says how many property types this build knows, on the wire only', () => {
    const update = newOp('db.update', 'w', 'd', { properties: [] });
    const page = newOp('page.create', 'w', 'p', { kind: 'database' } as never);
    const row = newOp('page.create', 'w', 'r', { kind: 'row' } as never);
    // Phase 15's button the twenty-first, Phase 17's unique id the twenty-second.
    expect(KNOWN_PROPERTY_TYPES).toHaveLength(22);
    expect(KNOWN_PROPERTY_TYPES.slice(-2)).toEqual(['button', 'uniqueId']);
    expect(wirePayload(update)).toEqual({ properties: [], propertyTypes: 22 });
    expect(wirePayload(page)).toEqual({ kind: 'database', propertyTypes: 22 });
    expect(wirePayload(row)).toEqual({ kind: 'row' });
    expect('propertyTypes' in update.payload).toBe(false);
  });
});
