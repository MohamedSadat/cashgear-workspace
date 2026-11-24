// Phase 16's scene, made through the API as a client makes it, for tests/e2e/forms.spec.ts and
// bench/phase16.mjs: a workspace with a Sign-ups database (Name, Email, Stage of three options, Seats,
// Notes, Owner), a table view, and a form view of three pages (the seats' page only for a new
// stage; the Stage question showing two of its three options), with its link made by the routes.
import { opOf, push, rowsByTitle, saveRule, uuidv7 } from './phase15-seed.mjs';

export { opOf, push, rowsByTitle, saveRule, uuidv7 };

export const P = {
  email: 'Email001',
  stage: 'Stage001',
  seats: 'Seats001',
  notes: 'Notes001',
  owner: 'Owner001',
};
export const STAGE = { fresh: 'StNew001', old: 'StOld001', secret: 'StSec001' };

/** A form of three pages, in a language: the seats asked only of a new stage. */
export function signUpForm(language = 'en') {
  const ar = language === 'ar';
  return {
    title: ar ? 'التسجيل' : 'Sign up',
    description: ar ? 'أخبرنا عنك' : 'Tell us about you',
    language,
    thanks: ar ? 'وصلتنا إجابتك، شكرًا' : 'We have it, thank you',
    submit: null,
    pages: [
      {
        title: null,
        description: null,
        when: null,
        questions: [
          {
            propertyId: 'title',
            label: ar ? 'اسمك' : 'Your name',
            help: null,
            required: true,
            options: null,
          },
          {
            propertyId: P.email,
            label: null,
            help: ar ? 'نراسلك بشأن هذا فقط' : 'We write only about this',
            required: true,
            options: null,
          },
          {
            propertyId: P.stage,
            label: null,
            help: null,
            required: false,
            options: [STAGE.fresh, STAGE.old],
          },
        ],
      },
      {
        title: ar ? 'المقاعد' : 'Seats',
        description: null,
        when: {
          kind: 'group',
          op: 'and',
          children: [
            { kind: 'condition', propertyId: P.stage, operator: 'is', value: STAGE.fresh },
          ],
        },
        questions: [
          { propertyId: P.seats, label: null, help: null, required: true, options: null },
        ],
      },
      {
        title: null,
        description: null,
        when: null,
        questions: [
          { propertyId: P.notes, label: null, help: null, required: false, options: null },
        ],
      },
    ],
  };
}

const properties = [
  { id: 'title', name: 'Name', type: 'title' },
  { id: P.email, name: 'Email', type: 'email' },
  {
    id: P.stage,
    name: 'Stage',
    type: 'select',
    options: [
      { id: STAGE.fresh, name: 'New', colour: 'blue' },
      { id: STAGE.old, name: 'Returning', colour: 'green' },
      { id: STAGE.secret, name: 'Secret stage', colour: 'red' },
    ],
  },
  { id: P.seats, name: 'Seats', type: 'number' },
  { id: P.notes, name: 'Notes', type: 'text' },
  { id: P.owner, name: 'Owner', type: 'person' },
];

/** A form view's config: its form, and its properties following its questions. */
export function formConfig(form) {
  const asked = form.pages.flatMap((p) => p.questions.map((q) => q.propertyId));
  return {
    filter: null,
    sorts: [],
    group: null,
    properties: {
      order: asked,
      hidden: properties.map((p) => p.id).filter((id) => !asked.includes(id) && id !== 'title'),
      widths: {},
    },
    form,
  };
}

export async function seedForm(
  api,
  { name = 'Forms', title = 'Sign-ups', language = 'en', link = true, rows = 0 } = {},
) {
  const workspaceId = uuidv7();
  await api.post('/api/v1/workspaces', { id: workspaceId, name, timeZone: 'UTC' });
  const now = new Date().toISOString();
  const sectionId = uuidv7();
  const databaseId = uuidv7();
  const tableId = uuidv7();
  const formId = uuidv7();
  await push(api, workspaceId, [
    opOf(workspaceId, 'section.create', sectionId, {
      id: sectionId,
      workspaceId,
      name: 'Shared',
      orderKey: 'a0',
      visibility: 'workspace',
      version: 1,
      createdAt: now,
    }),
    opOf(workspaceId, 'page.create', databaseId, {
      id: databaseId,
      workspaceId,
      sectionId,
      parentPageId: null,
      orderKey: 'a1',
      kind: 'database',
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
      database: { properties },
      propertyTypes: 21,
    }),
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
      viewTypes: 8,
    }),
    opOf(workspaceId, 'view.upsert', formId, {
      id: formId,
      workspaceId,
      databaseId,
      name: language === 'ar' ? 'نموذج التسجيل' : 'Sign-up form',
      type: 'form',
      orderKey: 'a1',
      config: formConfig(signUpForm(language)),
      version: 1,
      createdAt: now,
      viewTypes: 8,
    }),
  ]);
  if (rows > 0) {
    const lines = ['Name,Email'];
    for (let i = 0; i < rows; i++) lines.push(`Signed ${i},s${i}@example.com`);
    await api.post(`/api/v1/databases/${databaseId}/import`, {
      csv: lines.join('\r\n') + '\r\n',
      columns: ['title', P.email],
      header: true,
    });
  }
  let url = null;
  let token = null;
  if (link) {
    const made = await api.post(`/api/v1/databases/${databaseId}/views/${formId}/form/link`, {
      enabled: true,
    });
    url = made.url;
    token = url.slice(url.lastIndexOf('/') + 1);
  }
  return { workspaceId, sectionId, databaseId, tableId, formId, url, token };
}

/** A whole answer by the link's fields (the seats' page skipped: a returning stage). */
export function answerFields(name, extra = {}) {
  return {
    'q.title': name,
    [`q.${P.email}`]: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`,
    [`q.${P.stage}`]: STAGE.old,
    [`q.${P.notes}`]: 'Sent by the link',
    at: '2',
    go: 'next',
    ...extra,
  };
}
