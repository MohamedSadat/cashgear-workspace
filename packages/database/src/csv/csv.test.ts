// CSV import mapping and operations (applied by the memory host, and by the real planner for a
// new database), and export of a view's rows.
import { describe, expect, it } from 'vitest';
import { MemoryStore, derivedOption, parseCsv, type Id } from '@cgw/workspace';
import { seedTree } from '@cgw/workspace/testing';
import { P, seed } from '../testing/fixtures';
import { testId } from '../testing/memoryHost';
import { csvLookups, exportFileName, settled } from './exportView';
import {
  csvTable,
  defaultMapping,
  importOps,
  importTargets,
  inferredProperties,
  newDatabaseOps,
  planImportValues,
  titleFromFile,
} from './importPlan';
import { rowsToCsv } from '@cgw/workspace';

const columnName = (n: number) => `Column ${n}`;

const FILE = [
  'Name,priority,Amount,Due,Done,Ignored,Tags',
  'Pay the rent,High,1200.5,2026-11-30,yes,x,Finance',
  'Order paper,Urgent,abc,not a date,no,y,"Finance, Legal"',
  '"Call ""Omar""",,,2026-12-01,,z,',
].join('\r\n');

describe('importing into a database', () => {
  it('maps columns to properties by name and the first column to the title', () => {
    const { host, tasksId } = seed(0);
    const db = host.database(tasksId)!;
    const table = csvTable(parseCsv(FILE), true, columnName);
    expect(table.header).toEqual(['Name', 'priority', 'Amount', 'Due', 'Done', 'Ignored', 'Tags']);
    expect(defaultMapping(db, table)).toEqual([
      'title',
      P.priority,
      P.amount,
      P.due,
      P.done,
      null,
      P.tags,
    ]);
    const noHeader = csvTable(parseCsv('a,b\r\nc,d'), false, columnName);
    expect(noHeader.header).toEqual(['Column 1', 'Column 2']);
    expect(noHeader.records).toHaveLength(2);
    expect(defaultMapping(db, noHeader)).toEqual(['title', null]);
    expect(importTargets(db).map((p) => p.type)).not.toContain('person');
    expect(importTargets(db).map((p) => p.type)).not.toContain('formula');
  });

  it('reads every cell as its property reads text, adds the options a column needs, lists what it cannot read', () => {
    const { host, tasksId } = seed(0);
    const db = host.database(tasksId)!;
    const table = csvTable(parseCsv(FILE), true, columnName);
    const planned = planImportValues(db, table, defaultMapping(db, table));
    expect(planned.rows.map((r) => r.title)).toEqual([
      'Pay the rent',
      'Order paper',
      'Call "Omar"',
    ]);
    const [rent, paper, call] = planned.rows;
    expect(rent.values).toMatchObject({
      [P.priority]: 'prHigh01',
      [P.amount]: 1200.5,
      [P.due]: { start: '2026-11-30' },
      [P.done]: true,
      [P.tags]: ['tgFin001'],
    });
    // "Urgent" is a new option, with the id the server derives for it.
    const urgent = derivedOption(
      db.id,
      P.priority,
      'Urgent',
      new Set(db.properties.find((p) => p.id === P.priority)!.options!.map((o) => o.id)),
    );
    expect(paper.values[P.priority]).toBe(urgent.id);
    expect(planned.changed.map((d) => d.id)).toEqual([P.priority]);
    expect(planned.changed[0].options!.at(-1)).toMatchObject({ id: urgent.id, name: 'Urgent' });
    expect(paper.values[P.tags]).toEqual(['tgFin001', 'tgLegal1']);
    expect(paper.values[P.done]).toBeUndefined();
    expect(call.values).toEqual({ [P.due]: { start: '2026-12-01' } });
    expect(planned.problems).toEqual([
      { line: 3, column: 'Amount', text: 'abc' },
      { line: 3, column: 'Due', text: 'not a date' },
    ]);
  });

  it('writes the options first, then a row per record after every row', async () => {
    const { host, tasksId } = seed(5);
    const db = host.database(tasksId)!;
    const table = csvTable(parseCsv(FILE), true, columnName);
    const planned = planImportValues(db, table, defaultMapping(db, table));
    const page = host.page(tasksId)!;
    const ops = importOps(tasksId, planned, {
      workspaceId: db.workspaceId,
      sectionId: page.sectionId,
      newId: testId,
      endKey: host.rowOrderKey(tasksId, 'end'),
    });
    expect(ops.map((o) => o.type)).toEqual([
      'db.update',
      'page.create',
      'page.create',
      'page.create',
    ]);
    await host.apply(ops);
    const source = host.rows(tasksId, {
      viewId: null,
      spec: { filter: null, sorts: [], group: null },
    });
    const titles = source.snapshot().rows.map((r) => r.title);
    expect(titles.slice(-3)).toEqual(['Pay the rent', 'Order paper', 'Call "Omar"']);
    expect(source.snapshot().total).toBe(8);
    source.close();
  });
});

describe('a new database from a file', () => {
  it('works out the properties and is made by operations the planner accepts', async () => {
    const store = new MemoryStore();
    const { ws, section } = await seedTree(store);
    const table = csvTable(parseCsv(FILE), true, columnName);
    const databaseId = testId();
    const properties = inferredProperties(table, databaseId);
    expect(properties.map((p) => p.type)).toEqual([
      'title',
      'text',
      'text',
      'text',
      'checkbox',
      'text',
      'text',
    ]);
    const made = newDatabaseOps({
      table,
      properties,
      databaseId,
      title: titleFromFile('Bills 2026.csv'),
      viewName: 'Table',
      place: { workspaceId: ws.id, sectionId: section.id, parentPageId: null, orderKey: 'a9' },
      newId: testId,
    });
    expect(made.ops.map((o) => o.type)).toEqual([
      'page.create',
      'view.upsert',
      'page.create',
      'page.create',
      'page.create',
    ]);
    await store.applyLocalOps(made.ops);
    const mirror = await store.readMirror(ws.id);
    expect(mirror.pages.find((p) => p.id === databaseId)?.title).toBe('Bills 2026');
    expect(
      mirror.databases?.find((d) => d.id === databaseId)?.properties.map((p) => p.name),
    ).toEqual(table.header);
    const rows = await store.readRows(databaseId);
    expect(rows.map((r) => r.title).sort()).toEqual(['Call "Omar"', 'Order paper', 'Pay the rent']);
  });

  it('makes select options for a column changed to select', () => {
    const table = csvTable(parseCsv('Name,Kind\na,Red\nb,Blue\nc,Red'), true, columnName);
    const databaseId: Id = testId();
    const properties = inferredProperties(table, databaseId);
    expect(properties[1].type).toBe('text');
    const asSelect = [properties[0], { ...properties[1], type: 'select' as const, options: [] }];
    const made = newDatabaseOps({
      table,
      properties: asSelect,
      databaseId,
      title: 'Kinds',
      viewName: 'Table',
      place: { workspaceId: 'w', sectionId: 's', parentPageId: null, orderKey: 'a0' },
      newId: testId,
    });
    const created = made.ops[0].payload as {
      database: { properties: { options?: { name: string }[] }[] };
    };
    expect(created.database.properties[1].options!.map((o) => o.name)).toEqual(['Red', 'Blue']);
    expect(made.planned.rows[0].values[asSelect[1].id]).toBe(
      made.planned.rows[2].values[asSelect[1].id],
    );
  });
});

describe('exporting a view', () => {
  it("writes the view's rows in its order with names for people and options", async () => {
    const { host, tasksId, viewId } = seed(20);
    const db = host.database(tasksId)!;
    const view = host.views(tasksId).find((v) => v.id === viewId)!;
    const config = {
      ...view.config,
      sorts: [{ propertyId: 'title', direction: 'asc' as const }],
      properties: {
        order: [P.status, P.owner],
        hidden: db.properties
          .filter((p) => ![P.status, P.owner, 'title'].includes(p.id))
          .map((p) => p.id),
        widths: {},
      },
    };
    const source = host.rows(tasksId, {
      viewId,
      spec: { filter: null, sorts: config.sorts, group: null },
    });
    const snapshot = await settled(source);
    const csv = rowsToCsv(db, { config }, snapshot.rows, csvLookups(host, snapshot.rows, db));
    source.close();
    const lines = csv.slice(1).split('\r\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe('Name,Status,Owner');
    expect(lines).toHaveLength(22);
    const first = snapshot.rows[0];
    const owner = host
      .people()
      .find((p) => p.id === (first.values[P.owner] as string[] | undefined)?.[0]);
    expect(lines[1].endsWith(owner ? owner.name : ',')).toBe(true);
  });

  it('names the file after the database and the view, safely', () => {
    expect(exportFileName('Tasks', 'All tasks')).toBe('Tasks - All tasks.csv');
    expect(exportFileName('A/B: "x"', 'v?')).toBe('A B x - v.csv');
    expect(exportFileName('', '')).toBe('export.csv');
    expect(exportFileName('المهام', 'كل المهام')).toBe('المهام - كل المهام.csv');
  });
});
