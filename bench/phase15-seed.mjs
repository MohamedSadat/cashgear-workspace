// Phase 15's scene, made through the API as a client makes it, for tests/e2e/automations.spec.ts
// and bench/phase15.mjs: a workspace with a Tasks database (Status, Notes, Points, When with the
// time, Owner, and an Approve button), a table view, rows through the import route, and rules
// saved as the app saves them (`automation.upsert` through the operations route).
import { uuidv7 } from './phase12-chart.mjs';

export { uuidv7 };

export const P = {
  status: 'Status01',
  notes: 'Notes001',
  points: 'Points01',
  when: 'When0001',
  owner: 'Owner001',
  approve: 'Approve1',
};
export const STATUS = { todo: 'StTodo01', doing: 'StDoin01', done: 'StDone01' };

/** The operations route's operation, as a client queues one. */
export function opOf(workspaceId, type, entityId, payload) {
  return {
    opId: uuidv7(),
    type,
    workspaceId,
    entityId,
    baseVersion: null,
    payload,
    createdAt: new Date().toISOString(),
  };
}

/** Sends operations; throws on any refusal. */
export async function push(api, workspaceId, ops) {
  const answer = await api.post(`/api/v1/workspaces/${workspaceId}/ops`, { ops });
  const refused = answer.results.filter((r) => r.status !== 'applied');
  if (refused.length) throw new Error('Operations refused: ' + JSON.stringify(refused[0]));
  return answer.results;
}

export async function seedTasks(
  api,
  { rows = 5, name = 'Automations', title = 'Tasks', timeZone = 'UTC' } = {},
) {
  const workspaceId = uuidv7();
  await api.post('/api/v1/workspaces', { id: workspaceId, name, timeZone });
  const now = new Date().toISOString();
  const section = uuidv7();
  const databaseId = uuidv7();
  const tableId = uuidv7();
  const page = (id, kind, pageTitle, orderKey, extra = {}) => ({
    id,
    workspaceId,
    sectionId: section,
    parentPageId: null,
    orderKey,
    kind,
    title: pageTitle,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
    ...extra,
  });
  await push(api, workspaceId, [
    opOf(workspaceId, 'section.create', section, {
      id: section,
      workspaceId,
      name: 'Shared',
      orderKey: 'a0',
      visibility: 'workspace',
      version: 1,
      createdAt: now,
    }),
    opOf(
      workspaceId,
      'page.create',
      databaseId,
      page(databaseId, 'database', title, 'a1', {
        database: {
          properties: [
            { id: 'title', name: 'Name', type: 'title' },
            {
              id: P.status,
              name: 'Status',
              type: 'status',
              options: [
                { id: STATUS.todo, name: 'To do', colour: 'gray', group: 'todo' },
                { id: STATUS.doing, name: 'Doing', colour: 'blue', group: 'inProgress' },
                { id: STATUS.done, name: 'Done', colour: 'green', group: 'complete' },
              ],
            },
            { id: P.notes, name: 'Notes', type: 'text' },
            { id: P.points, name: 'Points', type: 'number' },
            { id: P.when, name: 'When', type: 'date', date: { includeTime: true } },
            { id: P.owner, name: 'Owner', type: 'person' },
            { id: P.approve, name: 'Approve', type: 'button', button: { label: 'Approve' } },
          ],
        },
        // As a build that knows the button sends it.
        propertyTypes: 21,
      }),
    ),
  ]);
  await push(api, workspaceId, [
    opOf(workspaceId, 'view.upsert', tableId, {
      id: tableId,
      workspaceId,
      databaseId,
      name: 'Table',
      type: 'table',
      orderKey: 'a0',
      config: {
        filter: null,
        sorts: [],
        group: null,
        properties: { order: [], hidden: [], widths: {} },
        wrap: false,
      },
      version: 1,
      createdAt: now,
      viewTypes: 7,
    }),
  ]);
  if (rows > 0) {
    const lines = ['Name,Points'];
    for (let i = 0; i < rows; i++) lines.push(`Task ${i},${i}`);
    await api.post(`/api/v1/databases/${databaseId}/import`, {
      csv: lines.join('\r\n') + '\r\n',
      columns: ['title', P.points],
      header: true,
    });
  }
  return { workspaceId, sectionId: section, databaseId, tableId };
}

/** A rule as the editor saves it. */
export function ruleOf(
  seeded,
  { trigger, steps, conditions = null, name = 'Rule', enabled = true },
) {
  return {
    id: uuidv7(),
    workspaceId: seeded.workspaceId,
    databaseId: seeded.databaseId,
    name,
    enabled,
    trigger,
    conditions,
    steps,
    authorId: null,
    version: 0,
    createdAt: '',
    updatedAt: '',
  };
}

export async function saveRule(api, seeded, fields) {
  const rule = ruleOf(seeded, fields);
  await push(api, seeded.workspaceId, [
    opOf(seeded.workspaceId, 'automation.upsert', rule.id, rule),
  ]);
  return rule;
}

/** The database's rows by title, as the server holds them now. */
export async function rowsByTitle(api, databaseId) {
  const page = await api.get(`/api/v1/databases/${databaseId}/rows?limit=1000`);
  return new Map(page.rows.map((row) => [row.title, row]));
}

/** A row added as the app adds one (a `page.create` of kind row). */
export async function addRow(
  api,
  seeded,
  title,
  values = {},
  orderKey = 'b' + Date.now().toString(36),
) {
  const id = uuidv7();
  const now = new Date().toISOString();
  await push(api, seeded.workspaceId, [
    opOf(seeded.workspaceId, 'page.create', id, {
      id,
      workspaceId: seeded.workspaceId,
      sectionId: seeded.sectionId,
      parentPageId: seeded.databaseId,
      orderKey,
      kind: 'row',
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
      row: { values },
    }),
  ]);
  return id;
}

/** A rule's runs, newest first, every page of them. */
export async function runsOf(api, seeded, ruleId) {
  const runs = [];
  let before = null;
  for (;;) {
    const page = await api.get(
      `/api/v1/databases/${seeded.databaseId}/automations/${ruleId}/runs?limit=200` +
        (before ? `&before=${encodeURIComponent(before)}` : ''),
    );
    runs.push(...page.runs);
    if (!page.next) return runs;
    before = page.next;
  }
}
