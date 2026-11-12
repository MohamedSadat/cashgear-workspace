// Generated databases for the tests and the browser harness: a "Tasks" database with a property
// of every type (a relation to a small "Projects" database, a rollup over it, a formula), and as
// many rows as asked, in English and Arabic, made the same way for the same seed.
import type { Id, PageRecord, RowRecord } from '@cgw/workspace';
import { keysBetween } from '@cgw/workspace';
import type { DatabaseRecord, PropertyDef, Value, ViewRecord } from '../core';
import type { Person } from '../host';
import { emptyConfig } from '../model/viewConfig';
import { MemoryDatabaseHost, testId, type MemoryHostOptions } from './memoryHost';

export const WORKSPACE: Id = '0190a000-0000-7000-8000-00000000aaaa';
export const SECTION: Id = '0190a000-0000-7000-8000-00000000bbbb';

export const PEOPLE: Person[] = [
  { id: '0190a000-0000-7000-8000-0000000000p1', name: 'Mona Adel', email: 'mona@example.com' },
  { id: '0190a000-0000-7000-8000-0000000000p2', name: 'سارة خالد', email: 'sara@example.com' },
  { id: '0190a000-0000-7000-8000-0000000000p3', name: 'Omar Farouk', email: 'omar@example.com' },
];

/** Property ids of the Tasks database (8 characters of base 62). */
export const P = {
  notes: 'txtNotes',
  amount: 'numAmnt1',
  due: 'dateDue1',
  done: 'chkDone1',
  priority: 'selPrio1',
  tags: 'mulTags1',
  status: 'staStat1',
  owner: 'perOwnr1',
  site: 'urlSite1',
  email: 'emlMail1',
  phone: 'phnPhon1',
  files: 'filFile1',
  project: 'relProj1',
  double: 'frmDoub1',
  projects: 'rolCnt01',
  created: 'ctdTime1',
  creator: 'ctdByer1',
  edited: 'ledTime1',
  editor: 'ledByer1',
} as const;
export const TASKS_BACK = 'relTask1';

const WORDS_EN = [
  'invoice',
  'ledger',
  'budget',
  'report',
  'payroll',
  'customer',
  'supplier',
  'audit',
];
const WORDS_AR = ['فاتورة', 'دفتر', 'ميزانية', 'تقرير', 'رواتب', 'عميل', 'مورد', 'تدقيق'];

function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
}

export function page(
  id: Id,
  title: string,
  kind: PageRecord['kind'],
  parent: Id | null = null,
): PageRecord {
  const now = '2026-11-01T09:00:00Z';
  return {
    id,
    workspaceId: WORKSPACE,
    sectionId: SECTION,
    parentPageId: parent,
    orderKey: 'a0',
    kind,
    title,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
  };
}

export function tasksProperties(projectsId: Id): PropertyDef[] {
  return [
    { id: 'title', name: 'Name', type: 'title' },
    {
      id: P.status,
      name: 'Status',
      type: 'status',
      options: [
        { id: 'stTodo01', name: 'Not started', colour: 'gray', group: 'todo' },
        { id: 'stDoing1', name: 'In progress', colour: 'blue', group: 'inProgress' },
        { id: 'stDone01', name: 'Done', colour: 'green', group: 'complete' },
      ],
    },
    {
      id: P.priority,
      name: 'Priority',
      type: 'select',
      options: [
        { id: 'prHigh01', name: 'High', colour: 'red' },
        { id: 'prMed001', name: 'Medium', colour: 'yellow' },
        { id: 'prLow001', name: 'منخفضة', colour: 'green' },
      ],
    },
    {
      id: P.tags,
      name: 'Tags',
      type: 'multiSelect',
      options: [
        { id: 'tgFin001', name: 'Finance', colour: 'purple' },
        { id: 'tgOps001', name: 'عمليات', colour: 'orange' },
        { id: 'tgLegal1', name: 'Legal', colour: 'pink' },
      ],
    },
    {
      id: P.amount,
      name: 'Amount',
      type: 'number',
      number: { format: 'currency', decimals: 2, currency: 'EGP' },
    },
    { id: P.due, name: 'Due', type: 'date', date: { includeTime: false } },
    { id: P.done, name: 'Done', type: 'checkbox' },
    { id: P.owner, name: 'Owner', type: 'person' },
    { id: P.notes, name: 'Notes', type: 'text' },
    { id: P.site, name: 'Site', type: 'url' },
    { id: P.email, name: 'Email', type: 'email' },
    { id: P.phone, name: 'Phone', type: 'phone' },
    { id: P.files, name: 'Files', type: 'files' },
    {
      id: P.project,
      name: 'Project',
      type: 'relation',
      relation: { databaseId: projectsId, reversePropertyId: TASKS_BACK },
    },
    {
      id: P.double,
      name: 'Double',
      type: 'formula',
      formula: { expression: `prop("${P.amount}") * 2` },
    },
    {
      id: P.projects,
      name: 'Projects',
      type: 'rollup',
      rollup: { relationPropertyId: P.project, targetPropertyId: 'title', fn: 'count' },
    },
    { id: P.created, name: 'Created', type: 'createdTime', date: { includeTime: true } },
    { id: P.creator, name: 'Created by', type: 'createdBy' },
    { id: P.edited, name: 'Edited', type: 'lastEditedTime', date: { includeTime: true } },
    { id: P.editor, name: 'Edited by', type: 'lastEditedBy' },
  ];
}

export interface Seeded {
  host: MemoryDatabaseHost;
  tasksId: Id;
  projectsId: Id;
  viewId: Id;
  projectRows: Id[];
}

function view(id: Id, databaseId: Id, name: string): ViewRecord {
  return {
    id,
    workspaceId: WORKSPACE,
    databaseId,
    name,
    type: 'table',
    orderKey: 'a0',
    config: emptyConfig('table'),
    version: 1,
    createdAt: '2026-11-01T09:00:00Z',
  };
}

/** A host holding the Tasks database with `rows` rows and the Projects database it relates to. */
export function seed(rows: number, options: MemoryHostOptions & { seed?: number } = {}): Seeded {
  const host = new MemoryDatabaseHost({ people: PEOPLE, ...options });
  const next = random(options.seed ?? 7);
  const projectsId = testId();
  const tasksId = testId();
  const viewId = testId();

  const projectRows: RowRecord[] = [];
  const projectKeys = keysBetween(null, null, 6);
  for (let i = 0; i < 6; i++) {
    const id = testId();
    projectRows.push(
      rowRecord(id, projectsId, i % 2 ? `مشروع ${i + 1}` : `Project ${i + 1}`, projectKeys[i], {}),
    );
  }
  const projects: DatabaseRecord = {
    id: projectsId,
    workspaceId: WORKSPACE,
    properties: [
      { id: 'title', name: 'Name', type: 'title' },
      {
        id: TASKS_BACK,
        name: 'Tasks',
        type: 'relation',
        relation: { databaseId: tasksId, reversePropertyId: P.project },
      },
    ],
    version: 1,
    rowCount: projectRows.length,
    createdAt: '2026-11-01T09:00:00Z',
  };

  const keys = keysBetween(null, null, rows);
  const taskRows: RowRecord[] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    const r = next;
    const words = 2 + Math.floor(r() * 3);
    const parts: string[] = [];
    for (let w = 0; w < words; w++) {
      const list = r() < 0.5 ? WORDS_EN : WORDS_AR;
      parts.push(list[Math.floor(r() * list.length)]);
    }
    const values: Record<string, Value> = {};
    const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)];
    values[P.status] = pick(['stTodo01', 'stDoing1', 'stDone01']);
    if (r() < 0.8) values[P.priority] = pick(['prHigh01', 'prMed001', 'prLow001']);
    if (r() < 0.6)
      values[P.tags] = [
        ...new Set([pick(['tgFin001', 'tgOps001', 'tgLegal1']), pick(['tgFin001', 'tgOps001'])]),
      ];
    values[P.amount] = Math.round(r() * 1_000_000) / 100;
    if (r() < 0.7) {
      const day = 1 + Math.floor(r() * 28);
      values[P.due] = {
        start: `2026-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      };
    }
    if (r() < 0.4) values[P.done] = true;
    if (r() < 0.7) values[P.owner] = [pick(PEOPLE).id];
    if (r() < 0.5) values[P.notes] = parts.slice().reverse().join(' ');
    if (r() < 0.3) values[P.site] = 'https://example.com/' + i;
    if (r() < 0.2) values[P.email] = `user${i}@example.com`;
    if (r() < 0.2) values[P.phone] = '+20 100 000 ' + String(i % 10000).padStart(4, '0');
    if (r() < 0.3) values[P.project] = [projectRows[Math.floor(r() * projectRows.length)].id];
    taskRows[i] = rowRecord(testId(), tasksId, parts.join(' '), keys[i], values);
  }
  // The reverse side of the relation, as the planner keeps it.
  const back = new Map<Id, Id[]>();
  for (const row of taskRows)
    for (const id of (row.values[P.project] as Id[] | undefined) ?? [])
      back.set(id, [...(back.get(id) ?? []), row.id]);
  for (const row of projectRows)
    if (back.has(row.id)) row.values[TASKS_BACK] = back.get(row.id)!.slice(0, 1000);

  const tasks: DatabaseRecord = {
    id: tasksId,
    workspaceId: WORKSPACE,
    properties: tasksProperties(projectsId),
    version: 1,
    rowCount: rows,
    createdAt: '2026-11-01T09:00:00Z',
  };
  host.addDatabase(
    page(projectsId, 'Projects', 'database'),
    projects,
    [view(testId(), projectsId, 'Table')],
    projectRows,
  );
  host.addDatabase(
    page(tasksId, 'Tasks', 'database'),
    tasks,
    [view(viewId, tasksId, 'All tasks')],
    taskRows,
  );
  host.addFile('0190a000-0000-7000-8000-0000000000f1', {
    fileName: 'report.pdf',
    sizeBytes: 1200,
    contentType: 'application/pdf',
  });
  return { host, tasksId, projectsId, viewId, projectRows: projectRows.map((r) => r.id) };
}

export function rowRecord(
  id: Id,
  databaseId: Id,
  title: string,
  orderKey: string,
  values: Record<string, Value>,
): RowRecord {
  return {
    ...page(id, title, 'row', databaseId),
    kind: 'row',
    orderKey,
    databaseId,
    values,
    versions: {},
    computed: {},
    computedVersion: null,
    createdBy: PEOPLE[0].id,
    updatedBy: PEOPLE[1].id,
  };
}
