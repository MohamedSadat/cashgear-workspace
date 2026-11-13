// The database templates' operations, applied by the workspace's real planner (a memory store),
// in English and Arabic; and row templates: the menu, a row made from one, a template made.
import { describe, expect, it } from 'vitest';
import { MemoryStore, type Id, type RowRecord } from '@cgw/workspace';
import { seedTree } from '@cgw/workspace/testing';
import { createDatabaseI18n, type DbT } from '../i18n';
import { P, seed } from '../testing/fixtures';
import { testId } from '../testing/memoryHost';
import { VIEW_TYPES } from '../views/registry';
import { TEMPLATE_IDS, makeDatabase, type TemplateChoice } from './databaseTemplates';
import { createFromTemplate, createTemplate, rowTemplateItems } from './rowTemplates';

const strings = (language: 'en' | 'ar'): DbT => {
  const i18n = createDatabaseI18n(language);
  const t = i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (key, options) => t(`database.${key}`, options);
};

async function made(choice: TemplateChoice, language: 'en' | 'ar' = 'en') {
  const store = new MemoryStore();
  const { ws, section, a } = await seedTree(store);
  const me: Id = '0190a000-0000-7000-8000-0000000000e1';
  const result = makeDatabase(
    choice,
    { workspaceId: ws.id, sectionId: section.id, parentPageId: a.id, orderKey: 'a5' },
    { t: strings(language), newId: testId, me, today: '2026-11-13', offsetMinutes: 120 },
  );
  await store.applyLocalOps(result.ops);
  const mirror = await store.readMirror(ws.id);
  const rows = await store.readRows(result.databaseId);
  return { store, result, mirror, rows, me };
}

describe('database templates', () => {
  it.each([...TEMPLATE_IDS, 'blank' as const])(
    '%s is made by operations the planner accepts',
    async (id) => {
      const { result, mirror, rows } = await made(id);
      const database = mirror.databases?.find((d) => d.id === result.databaseId);
      expect(database).toBeTruthy();
      expect(database!.properties[0]).toMatchObject({ id: 'title', type: 'title' });
      const views = (mirror.views ?? []).filter((v) => v.databaseId === result.databaseId);
      expect(views.map((v) => v.id)).toEqual(result.views.map((v) => v.id));
      expect(views[0].id).toBe(result.viewId);
      // Every property a view names exists.
      const ids = new Set(database!.properties.map((p) => p.id));
      for (const view of views) {
        if (view.config.group) expect(ids.has(view.config.group.propertyId)).toBe(true);
        if (view.config.calendarBy) expect(ids.has(view.config.calendarBy)).toBe(true);
        for (const sort of view.config.sorts) expect(ids.has(sort.propertyId)).toBe(true);
        for (const hidden of view.config.properties.hidden) expect(ids.has(hidden)).toBe(true);
        if (view.type === 'board') expect(view.config.group).toBeTruthy();
        if (view.type === 'calendar') expect(view.config.calendarBy).toBeTruthy();
      }
      expect(rows.length).toBe(result.rows.length);
      // Values were kept as written (the planner coerces them: nothing was dropped).
      for (const planned of result.rows) {
        const stored = rows.find((r) => r.id === planned.id)!;
        expect(stored.values).toEqual(planned.values);
        expect(stored.isTemplate).toBe(planned.isTemplate);
      }
    },
  );

  it('uses every view type between them, and has sample rows in each', async () => {
    const types = new Set<string>();
    for (const id of TEMPLATE_IDS) {
      const { result } = await made(id);
      result.views.forEach((v) => types.add(v.type));
      expect(result.rows.filter((r) => !r.isTemplate).length).toBeGreaterThanOrEqual(3);
      expect(result.title).not.toBe('');
    }
    expect([...types].sort()).toEqual(Object.keys(VIEW_TYPES).sort());
  });

  it('is made in the interface language', async () => {
    const en = await made('tasks', 'en');
    const ar = await made('tasks', 'ar');
    expect(en.result.title).toBe('Tasks');
    expect(ar.result.title).toBe('المهام');
    const arStatus = ar.result.properties.find((p) => p.type === 'status')!;
    expect(arStatus.options!.map((o) => o.name)).toEqual(['لم تبدأ', 'قيد التنفيذ', 'منجزة']);
    expect(ar.result.views.map((v) => v.name)).toEqual(['لوحة', 'كل المهام', 'تقويم', 'مهامي']);
    expect(ar.rows.map((r) => r.title)).toContain('راجع الميزانية');
  });

  it("gives tasks to the person making it, and dates around today in the person's offset", async () => {
    const { result, me } = await made('tasks');
    const assignee = result.properties.find((p) => p.type === 'person')!;
    expect(result.rows[0].values[assignee.id]).toEqual([me]);
    const due = result.properties.find((p) => p.type === 'date')!;
    expect(result.rows[0].values[due.id]).toEqual({ start: '2026-11-15' });
    const meetings = await made('meetingNotes');
    const date = meetings.result.properties.find((p) => p.type === 'date')!;
    // 10:00 at UTC+2 is 08:00 UTC.
    expect(meetings.result.rows[0].values[date.id]).toEqual({ start: '2026-11-13T08:00:00Z' });
    expect(meetings.rows.filter((r: RowRecord) => r.isTemplate).map((r) => r.title)).toEqual([
      'Weekly sync',
    ]);
  });

  it('makes new ids each time', () => {
    const t = strings('en');
    const place = { workspaceId: 'w', sectionId: 's', parentPageId: null, orderKey: 'a0' };
    const ctx = { t, newId: testId, me: null, today: '2026-11-13', offsetMinutes: 0 };
    const one = makeDatabase('projects', place, ctx);
    const two = makeDatabase('projects', place, ctx);
    expect(one.databaseId).not.toBe(two.databaseId);
    expect(one.properties[1].id).not.toBe(two.properties[1].id);
    expect(one.ops[0]).toMatchObject({
      type: 'page.create',
      payload: { kind: 'database', icon: '📁' },
    });
  });
});

describe('row templates', () => {
  it('lists the templates, makes a row from one with its values and the view presets', async () => {
    const { host, tasksId, viewId } = seed(3);
    const view = host.views(tasksId).find((v) => v.id === viewId)!;
    const t = strings('en');
    expect(
      rowTemplateItems({ host, databaseId: tasksId, view, templates: [], t, editable: true }).map(
        (i) => i.key,
      ),
    ).toEqual(['none', 'make']);
    const id = await createTemplate(host, tasksId, view, t('rowTemplates.newTitle'));
    expect(host.opened.at(-1)).toEqual({ kind: 'row', id });
    const template = host.rowRecords.get(id!)!;
    expect(template.isTemplate).toBe(true);
    expect(host.rowTemplates(tasksId).map((r) => r.id)).toEqual([id]);
    await host.apply([
      {
        opId: testId(),
        type: 'row.update',
        workspaceId: template.workspaceId,
        entityId: template.id,
        baseVersion: null,
        payload: { values: { [P.priority]: 'prHigh01' } },
        createdAt: new Date().toISOString(),
      },
    ]);
    // The host's list of templates follows a change to one.
    expect(host.rowTemplates(tasksId)[0].values[P.priority]).toBe('prHigh01');
    const items = rowTemplateItems({
      host,
      databaseId: tasksId,
      view,
      templates: host.rowTemplates(tasksId),
      t,
      editable: true,
    });
    expect(items.map((i) => i.key)).toEqual([`new:${id}`, 'make', 'edit', 'delete']);
    const filtered = {
      ...view,
      config: {
        ...view.config,
        filter: {
          kind: 'group' as const,
          op: 'and' as const,
          children: [
            {
              kind: 'condition' as const,
              propertyId: P.status,
              operator: 'is' as const,
              value: 'stDone01',
            },
          ],
        },
      },
    };
    const rowId = await createFromTemplate(host, tasksId, host.rowTemplates(tasksId)[0], filtered);
    const made = host.rowRecords.get(rowId!)!;
    expect(made.isTemplate).toBe(false);
    expect(made.templateOfPageId).toBe(id);
    expect(made.values[P.priority]).toBe('prHigh01');
    expect(made.values[P.status]).toBe('stDone01');
    // Templates never show in a view.
    const source = host.rows(tasksId, { viewId, spec: { filter: null, sorts: [], group: null } });
    expect(source.snapshot().rows.some((r) => r.id === id)).toBe(false);
    source.close();
  });

  it("keeps the memory host's list while nothing changes it, and follows every change to a template", async () => {
    const { host, tasksId, viewId } = seed(3);
    const view = host.views(tasksId).find((v) => v.id === viewId)!;
    const id = (await createTemplate(host, tasksId, view, 'Weekly'))!;
    const op = (type: 'row.update' | 'page.update', entityId: Id, payload: object) =>
      ({
        opId: testId(),
        type,
        workspaceId: view.workspaceId,
        entityId,
        baseVersion: null,
        payload,
        createdAt: new Date().toISOString(),
      }) as never;
    const list = host.rowTemplates(tasksId);
    expect(host.rowTemplates(tasksId)).toBe(list);
    // A value of a row that is not a template: the same list.
    const plain = host.rowsOf(tasksId).find((r) => !r.isTemplate)!;
    await host.apply([op('row.update', plain.id, { values: { [P.priority]: 'prLow001' } })]);
    expect(host.rowTemplates(tasksId)).toBe(list);
    // The template's title, then its end as a template in a change that also names it.
    await host.apply([op('page.update', id, { title: 'Monthly' })]);
    expect(host.rowTemplates(tasksId).map((r) => r.title)).toEqual(['Monthly']);
    await host.apply([op('page.update', id, { title: 'Once', isTemplate: false })]);
    expect(host.rowTemplates(tasksId)).toEqual([]);
  });
});
