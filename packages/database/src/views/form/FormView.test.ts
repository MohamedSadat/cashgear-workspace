// The form view drawn in jsdom over the in-memory host (Phase 16): the eighth view type, a new
// form's questions (the title required, then every property a form asks) with its properties
// following them; a member's answer added as one `page.create` marked by its form (its values the
// form rules kept), required questions refused before anything is sent; a page shown by an earlier
// answer; the question editor's changes as `view.upsert`s; a reader drawn the form and nothing sent;
// no filter, sort, search or New on its toolbar; and Arabic.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from '../../testing/dom';

installDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { newOp } = await import('@cgw/workspace');
const { DatabaseView } = await import('../../DatabaseView');
const { createDatabaseI18n } = await import('../../i18n');
const { seed, P } = await import('../../testing/fixtures');
const { VIEW_TYPES, VIEW_ORDER } = await import('../registry');
const { readForm } = await import('@cgw/workspace/forms');
type ViewConfig = import('@cgw/workspace').ViewConfig;
type StoredForm = import('@cgw/workspace').StoredForm;
type Operation = import('@cgw/workspace').Operation;

type Root = ReturnType<typeof createRoot>;
let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  document.documentElement.dir = 'ltr';
});
afterAll(() => (window as unknown as { close(): void }).close());

const flush = (times = 4) =>
  act(async () => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  const i18n = createDatabaseI18n(language);
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  root = createRoot(container);
  await act(async () => root!.render(h(I18nextProvider, { i18n }, node)));
  await flush();
}
async function click(target: Element | undefined | null) {
  if (!target) throw new Error('Nothing to click');
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}
/** Types into a control as React reads it (its value setter, then an input event). */
async function type(control: Element | null, text: string) {
  if (!control) throw new Error('No control');
  const el = control as HTMLInputElement | HTMLTextAreaElement;
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}
async function choose(control: Element | null, value: string) {
  const select = control as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
/** A control by its label's text. */
const field = (label: string) => {
  const found = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.replace('*', '').trim() === label,
  );
  if (!found) throw new Error(`No field ${label}`);
  return found.htmlFor ? document.getElementById(found.htmlFor) : found.querySelector('input');
};

/** The Tasks database shown as a form with the given form (default: the view type's own). */
async function formView(form?: StoredForm, options: { canEdit?: boolean } = {}) {
  const s = seed(3, { today: '2026-11-24', canEdit: options.canEdit });
  const database = s.host.database(s.tasksId)!;
  const base = s.host.views(s.tasksId)[0];
  const id = s.host.newId();
  const config: ViewConfig = {
    ...VIEW_TYPES.form.defaultConfig(database),
    ...(form ? { form } : {}),
  };
  await s.host.apply([
    newOp('view.upsert', base.workspaceId, id, {
      ...base,
      id,
      name: 'Sign-ups',
      type: 'form',
      orderKey: 'a1',
      config,
    }),
  ]);
  s.host.applied.length = 0;
  await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId, viewId: id }));
  return { ...s, viewId: id, database };
}

const created = (ops: Operation[]) => ops.filter((op) => op.type === 'page.create');

describe('the form view', () => {
  it('is the eighth view type, a new form asking the title first and every property it may ask', async () => {
    expect(VIEW_ORDER).toHaveLength(8);
    expect(VIEW_ORDER[7]).toBe('form');
    const s = seed(1);
    const database = s.host.database(s.tasksId)!;
    const config = VIEW_TYPES.form.defaultConfig(database);
    const form = readForm(config, database, 'app');
    expect(form.pages).toHaveLength(1);
    expect(form.pages[0].questions[0]).toEqual({
      propertyId: 'title',
      label: null,
      help: null,
      required: true,
      options: null,
    });
    const asked = form.pages[0].questions.map((q) => q.propertyId);
    expect(asked).toContain(P.priority);
    expect(asked).toContain(P.owner);
    // A formula, a rollup and created or edited times and people are never asked.
    for (const id of [P.double, P.projects, P.created, P.creator, P.edited, P.editor])
      expect(asked).not.toContain(id);
    // Its properties follow its questions, for an older build's table.
    expect(config.properties.order).toEqual(asked);
    expect(config.properties.hidden).toContain(P.double);
    expect(config.properties.hidden).not.toContain(P.priority);
  });

  it("answers as one row marked by its form, after the rules' check, offline as online", async () => {
    const s = await formView({
      title: 'Requests',
      pages: [
        {
          questions: [
            { propertyId: 'title', label: 'What do you need', required: true },
            { propertyId: P.priority, options: ['prHigh01', 'prMed001'] },
            { propertyId: P.amount },
          ],
        },
      ],
    });
    // The toolbar has nothing of rows for it.
    expect(button('Filter')).toBeUndefined();
    expect(button('Sort')).toBeUndefined();
    expect(button('New')).toBeUndefined();
    expect(container.querySelector('input[type="search"].cgw-db-search')).toBeNull();

    await click(button('Answer'));
    expect(container.querySelector('h2')?.textContent).toBe('Requests');
    // An option the question does not show is not offered.
    const priority = field('Priority') as HTMLSelectElement;
    expect([...priority.options].map((o) => o.value)).toEqual(['', 'prHigh01', 'prMed001']);

    // A required question not answered: nothing sent, the problem said.
    await click(button('Submit'));
    expect(created(s.host.applied)).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'What do you need: Answer this question.',
    );
    expect(field('What do you need')?.getAttribute('aria-invalid')).toBe('true');

    await type(field('What do you need'), 'A new laptop');
    await choose(priority, 'prHigh01');
    await type(field('Amount'), '١٢٫٥');
    await click(button('Submit'));
    const [op] = created(s.host.applied);
    expect(op.payload).toMatchObject({
      kind: 'row',
      parentPageId: s.tasksId,
      title: 'A new laptop',
      formId: s.viewId,
      row: { values: { [P.priority]: 'prHigh01', [P.amount]: 12.5 } },
    });
    expect(container.textContent).toContain('Thank you. Your answer was sent.');
    await click(button('Send another answer'));
    expect((field('What do you need') as HTMLInputElement).value).toBe('');
  });

  it('shows a page only for the answers its condition names', async () => {
    const s = await formView({
      pages: [
        { questions: [{ propertyId: 'title', required: true }, { propertyId: P.priority }] },
        {
          title: 'How urgent',
          when: {
            kind: 'group',
            op: 'and',
            children: [
              { kind: 'condition', propertyId: P.priority, operator: 'is', value: 'prHigh01' },
            ],
          },
          questions: [{ propertyId: P.due, required: true }],
        },
      ],
    });
    await click(button('Answer'));
    await type(field('Name'), 'Fix the roof');
    // No priority: the last page is the first; it submits.
    expect(button('Submit')).toBeDefined();
    await choose(field('Priority'), 'prHigh01');
    expect(button('Next')).toBeDefined();
    await click(button('Next'));
    expect(container.querySelector('h3')?.textContent).toBe('How urgent');
    await click(button('Submit'));
    expect(created(s.host.applied)).toHaveLength(0);
    await type(field('Due'), '2026-12-01');
    await click(button('Back'));
    expect((field('Name') as HTMLInputElement).value).toBe('Fix the roof');
    await click(button('Next'));
    await click(button('Submit'));
    expect(created(s.host.applied)[0].payload).toMatchObject({
      title: 'Fix the roof',
      row: { values: { [P.priority]: 'prHigh01', [P.due]: { start: '2026-12-01' } } },
    });
  });

  it("edits its questions as the view's upserts, its properties following them", async () => {
    const s = await formView({ pages: [{ questions: [{ propertyId: 'title' }] }] });
    // A form that asks something opens on its answer; its editor is a press away.
    await click(button('Edit questions'));
    const required = [...container.querySelectorAll('[data-question="title"] label')].find(
      (l) => l.textContent === 'Required',
    );
    await click(required?.querySelector('input') ?? required);
    await choose(container.querySelector('.cgw-db-form-add select'), P.priority);
    const upserts = s.host.applied.filter((op) => op.type === 'view.upsert');
    const last = upserts[upserts.length - 1].payload as { config: ViewConfig };
    const form = readForm(last.config, s.database, 'app');
    expect(form.pages[0].questions.map((q) => [q.propertyId, q.required])).toEqual([
      ['title', true],
      [P.priority, false],
    ]);
    expect(last.config.properties.order).toEqual(['title', P.priority]);
    expect(last.config.properties.hidden).toContain(P.amount);
  });

  it('draws the form for a reader and sends nothing', async () => {
    const s = await formView(
      { pages: [{ questions: [{ propertyId: 'title', required: true }] }] },
      { canEdit: false },
    );
    expect(button('Edit questions')).toBeUndefined();
    expect(container.textContent).toContain(
      'only people who can edit this database answer it here',
    );
    expect((field('Name') as HTMLInputElement).disabled).toBe(true);
    expect((button('Submit') as HTMLButtonElement).disabled).toBe(true);
    expect(s.host.applied).toHaveLength(0);
  });

  it('speaks Arabic', async () => {
    const s = seed(1, { today: '2026-11-24' });
    const database = s.host.database(s.tasksId)!;
    const base = s.host.views(s.tasksId)[0];
    const id = s.host.newId();
    await s.host.apply([
      newOp('view.upsert', base.workspaceId, id, {
        ...base,
        id,
        name: 'نموذج',
        type: 'form',
        orderKey: 'a1',
        config: VIEW_TYPES.form.defaultConfig(database),
      }),
    ]);
    await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId, viewId: id }), 'ar');
    expect(button('تحرير الأسئلة')).toBeDefined();
    await click(button('الإجابة'));
    expect(container.textContent).toContain('الأسئلة المعلّمة بـ * مطلوبة.');
    expect(button('إرسال')).toBeDefined();
  });

  it('is offered only where the server keeps forms', async () => {
    const s = seed(1);
    const menu = async () => {
      await click(document.querySelector('[aria-label="Add a view"]'));
      // Each item's words after its glyph.
      const offered = [...document.querySelectorAll('[role="menuitem"]')].map((i) =>
        i.textContent?.trim().slice(1),
      );
      await act(async () => root?.unmount());
      root = null;
      return offered;
    };
    await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId }));
    expect(await menu()).toContain('Form');
    // A server before 0.16.0 refuses a form view: the menu leaves it out.
    (s.host as import('../../host').DatabaseHost).viewTypeKnown = (type) => type !== 'form';
    await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId }));
    const offered = await menu();
    expect(offered).toContain('Chart');
    expect(offered).not.toContain('Form');
  });
});
