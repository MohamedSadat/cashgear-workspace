// Phase 15, M15.3: the automations in the views, in jsdom over the in-memory host and a fake
// automations host: the toolbar's button only where automations are, the dialog's list and its
// editor writing a rule the shared check keeps (and saying why one is refused), the run log's
// words, a button property's cell pressing once and only for editors, and the type picker offering
// the button only when the server knows it.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from '../testing/dom';

installDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { DatabaseView } = await import('../DatabaseView');
const { RowProperties } = await import('../RowProperties');
const { createDatabaseI18n } = await import('../i18n');
const { seed, P } = await import('../testing/fixtures');
const { RunLog } = await import('./RunLog');
// Behind React.lazy, loaded before the tests so the dialog draws in a few ticks.
await import('./AutomationsDialog');
await import('./RowRuns');
await import('./RowReminders');
const { triggerText, amountText, newRule, newTrigger, withoutReminders } = await import('./model');
const { seriesText } = await import('./Series');
const { openAutomations } = await import('./open');
const { rowCreate, rowTemplateItems } = await import('../templates/rowTemplates');
const { automationsEn } = await import('./words');
import type { AutomationRecord, PropertyDef } from '../core';
import type {
  AutomationRunsPage,
  AutomationsHost,
  DatabaseAutomations,
  RowReminder,
  RowRemindersHost,
} from '../host';

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
});
afterAll(() => (window as unknown as { close(): void }).close());

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(node: ReturnType<typeof h>) {
  root = createRoot(container);
  await act(async () => root!.render(h(I18nextProvider, { i18n: createDatabaseI18n('en') }, node)));
  for (let i = 0; i < 5; i++) await flush();
}

class FakeAutomations implements AutomationsHost {
  saved: AutomationRecord[] = [];
  presses: { rowId: string; propertyId: string }[] = [];
  buttons = true;
  data: DatabaseAutomations = {
    automations: [],
    canManage: true,
    canCallWebhooks: false,
    webhooks: [],
    timeZone: 'Asia/Riyadh',
    allOff: false,
  };
  online = () => true;
  knowsButtons = () => this.buttons;
  list = async () => this.data;
  save = async (rule: AutomationRecord) => void this.saved.push(rule);
  remove = async () => undefined;
  setEnabled = async () => undefined;
  runs = async (): Promise<AutomationRunsPage> => ({ runs: [], next: null });
  rowRuns = async (): Promise<AutomationRunsPage> => ({ runs: [], next: null });
  press = async (_db: string, rowId: string, def: PropertyDef) =>
    void this.presses.push({ rowId, propertyId: def.id });
  groups = async () => [];
  onChange = () => () => undefined;
  // Phase 17.
  workflows = false;
  knowsWorkflows = () => this.workflows;
  kept: RowReminder[] = [];
  reminderCalls: string[] = [];
  get reminders(): RowRemindersHost | undefined {
    if (!this.workflows) return undefined;
    return {
      list: async () => this.kept,
      set: async (_db, _row, propertyId, beforeMinutes) => {
        this.reminderCalls.push(`set:${propertyId}:${beforeMinutes}`);
        this.kept = [
          ...this.kept.filter((r) => r.propertyId !== propertyId),
          { propertyId, beforeMinutes, dueAt: null },
        ];
        return this.kept;
      },
      remove: async (_db, _row, propertyId) => {
        this.reminderCalls.push(`remove:${propertyId}`);
        this.kept = this.kept.filter((r) => r.propertyId !== propertyId);
        return this.kept;
      },
    };
  }
}

const button = (label: string) =>
  [...container.ownerDocument.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );

async function click(target: Element | undefined) {
  expect(target, 'the control is there').toBeTruthy();
  await act(async () => (target as HTMLElement).click());
  for (let i = 0; i < 5; i++) await flush();
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = Object.getPrototypeOf(select);
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

const selectLabelled = (label: string) =>
  [...document.querySelectorAll('select')].find(
    (s) =>
      s.getAttribute('aria-label') === label ||
      (s.id && document.querySelector(`label[for="${s.id}"]`)?.textContent === label),
  ) as HTMLSelectElement | undefined;

describe('automations in the views', () => {
  it('shows the toolbar button only where the host gives automations', async () => {
    const s = seed(3);
    await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId, embedded: false }));
    expect(button(automationsEn.buttonLabel)).toBeUndefined();
    await act(async () => root!.unmount());
    const t = seed(3);
    t.host.automations = new FakeAutomations();
    root = null;
    container.innerHTML = '';
    await mount(h(DatabaseView, { host: t.host, databaseId: t.tasksId, embedded: false }));
    expect(button(automationsEn.buttonLabel)).toBeTruthy();
  });

  it('makes a rule in the editor, checked as the server checks it', async () => {
    const s = seed(3);
    const fake = new FakeAutomations();
    s.host.automations = fake;
    await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId, embedded: false }));
    await click(button(automationsEn.buttonLabel));
    expect(document.body.textContent).toContain(automationsEn.none);
    expect(document.body.textContent).toContain('Asia/Riyadh');
    await click(button(automationsEn.new));
    // A set step with nothing to set is refused before it is sent, and says why.
    await click(button(automationsEn.save));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      automationsEn.problems['step.values'],
    );
    expect(fake.saved).toEqual([]);
    // When the status changes to Done, set the notes.
    await choose(selectLabelled(automationsEn.trigger)!, 'propertyChanged');
    const status = s.host.database(s.tasksId)!.properties.find((p) => p.id === P.status)!;
    await choose(selectLabelled(automationsEn.trigger_.property)!, P.status);
    const done = status.options!.find((o) => (o as { group?: string }).group === 'complete')!;
    await choose(selectLabelled(automationsEn.trigger_.to)!, done.id);
    await choose(selectLabelled(automationsEn.set.add)!, P.done);
    await click(button(automationsEn.save));
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0]).toMatchObject({
      databaseId: s.tasksId,
      enabled: true,
      trigger: {
        kind: 'propertyChanged',
        propertyId: P.status,
        to: { operator: 'is', value: done.id },
      },
      steps: [{ kind: 'set', values: { [P.done]: true }, when: null }],
    });
  });

  it('offers waits, branches and approvals only where the server keeps them, and nests steps', async () => {
    const s = seed(3);
    const fake = new FakeAutomations();
    s.host.automations = fake;
    await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId, embedded: false }));
    await click(button(automationsEn.buttonLabel));
    await click(button(automationsEn.new));
    const offered = (label: string = automationsEn.addStep) =>
      [...(selectLabelled(label)?.options ?? [])].map((o) => o.value).filter(Boolean);
    // A server before 0.17.0 keeps four step kinds (and this person calls no webhook).
    expect(offered()).toEqual(['set', 'addRow', 'notify']);
    await click(button(automationsEn.cancel));
    fake.data = { ...fake.data, stepKinds: 7 };
    await act(async () => root!.unmount());
    root = null;
    container.innerHTML = '';
    await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId, embedded: false }));
    await click(button(automationsEn.buttonLabel));
    await click(button(automationsEn.new));
    expect(offered()).toEqual(['set', 'addRow', 'notify', 'wait', 'branch', 'approval']);
    await choose(selectLabelled(automationsEn.addStep)!, 'branch');
    // The branch's "if" path takes steps of its own, one level deeper.
    const ifPath = automationsEn.nested.add.replace(
      '{{path}}',
      automationsEn.branch.pathSteps.replace('{{path}}', automationsEn.branch.if),
    );
    expect(offered(ifPath)).toContain('approval');
    await choose(selectLabelled(ifPath)!, 'set');
    await choose(selectLabelled(automationsEn.addStep)!, 'wait');
    const adds = [...document.querySelectorAll('select')].filter(
      (x) => x.getAttribute('aria-label') === automationsEn.set.add,
    ) as HTMLSelectElement[];
    expect(adds).toHaveLength(2);
    for (const add of adds) await choose(add, P.done);
    await click(button(automationsEn.save));
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0].steps).toEqual([
      { kind: 'set', values: { [P.done]: true }, when: null },
      {
        kind: 'branch',
        branches: [
          {
            when: { kind: 'group', op: 'and', children: [] },
            steps: [{ kind: 'set', values: { [P.done]: true }, when: null }],
          },
        ],
        otherwise: [],
        when: null,
      },
      { kind: 'wait', until: { kind: 'time', minutes: 1440 }, when: null },
    ]);
  });

  it('reads where a run waits and the path its branch took', async () => {
    await mount(
      h(RunLog, {
        title: 'Runs',
        of: 'rule',
        stepName: (kind: string) => kind,
        load: async () => ({
          runs: [
            {
              id: 'r2',
              automationId: 'a1',
              automationName: 'Rule',
              databaseId: 'd1',
              rowId: 'row1',
              rowTitle: 'Invoice 8',
              trigger: 'rowAdded',
              depth: 1,
              actor: null,
              author: { id: 'p2', name: 'Omar' },
              status: 'waiting',
              reason: null,
              steps: [
                { index: 0, path: '0', kind: 'branch', status: 'done', detail: 'path:1' },
                {
                  index: 1,
                  path: '0/1/0',
                  kind: 'approval',
                  status: 'waiting',
                  detail: '2026-11-27T10:00:00Z',
                  count: 2,
                },
              ],
              startedAt: '2026-11-24T10:00:00Z',
              endedAt: null,
            },
          ],
          next: null,
        }),
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain(automationsEn.status.waiting);
    expect(text).toContain(automationsEn.log.took.replace('{{path}}', 'Path 2'));
    expect(text).toContain(automationsEn.log.asked.replace('{{count}}', '2'));
    expect(container.querySelector('li[data-depth="1"]')?.textContent).toContain('approval');
  });

  it('reads a run log in words: its status, its reason and its steps', async () => {
    await mount(
      h(RunLog, {
        title: 'Runs',
        of: 'rule',
        stepName: (kind: string) => kind,
        load: async () => ({
          runs: [
            {
              id: 'r1',
              automationId: 'a1',
              automationName: 'Rule',
              databaseId: 'd1',
              rowId: 'row1',
              rowTitle: 'Invoice 7',
              trigger: 'propertyChanged',
              depth: 4,
              actor: { id: 'p1', name: 'Mona Adel' },
              author: { id: 'p2', name: 'Omar' },
              status: 'stopped',
              reason: 'depth',
              steps: [{ index: 0, kind: 'set', status: 'failed', code: 'access.denied' }],
              startedAt: '2026-11-24T10:00:00Z',
              endedAt: null,
            },
          ],
          next: null,
        }),
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain(automationsEn.status.stopped);
    expect(text).toContain('Invoice 7');
    expect(text).toContain(automationsEn.reasons.depth);
    expect(text).toContain('Mona Adel');
    expect(text).toContain(automationsEn.reasons['access.denied']);
  });

  it('presses a button once for an editor, and never on a template or for a reader', async () => {
    const s = seed(2);
    const fake = new FakeAutomations();
    s.host.automations = fake;
    const db = s.host.database(s.tasksId)!;
    s.host.records.set(s.tasksId, {
      ...db,
      properties: [
        ...db.properties,
        { id: 'btnAppr1', name: 'Approve', type: 'button', button: { label: 'Approve it' } },
      ],
    });
    const row = [...s.host.rowRecords.values()].find(
      (r) => r.databaseId === s.tasksId && !r.isTemplate,
    )!;
    await mount(h(RowProperties, { host: s.host, rowId: row.id }));
    await click(button('Approve it'));
    expect(fake.presses).toEqual([{ rowId: row.id, propertyId: 'btnAppr1' }]);
    // The row's runs are under its properties.
    expect(document.body.textContent).toContain(automationsEn.log.rowTitle);
    await act(async () => root!.unmount());
    root = null;
    container.innerHTML = '';
    await mount(h(RowProperties, { host: s.host, rowId: row.id, editable: false }));
    expect(button('Approve it')!.disabled).toBe(true);
  });

  it('says what starts a rule in a sentence', () => {
    const s = seed(1);
    const db = s.host.database(s.tasksId)!;
    const words = createDatabaseI18n('en');
    const loose = words.t as unknown as (key: string, options?: Record<string, unknown>) => string;
    const at = ((key: string, options?: Record<string, unknown>) =>
      loose(`database.automations.${key}`, options)) as never;
    // The words are merged by the hook; a test merges them as it does.
    words.addResourceBundle(
      'en',
      'translation',
      { database: { automations: automationsEn } },
      true,
      false,
    );
    expect(triggerText({ kind: 'rowAdded' }, db, at, 'en')).toBe('When a row is added');
    expect(
      triggerText({ kind: 'date', propertyId: P.due, offsetMinutes: -120, at: null }, db, at, 'en'),
    ).toBe('2 hours before Due');
    expect(
      triggerText({ kind: 'schedule', every: 'week', at: '09:00', weekday: 1 }, db, at, 'en'),
    ).toBe('Every Monday at 09:00');
    // A value is read as a person reads it: an option by its name, never its id.
    const status = db.properties.find((p) => p.id === P.status)!;
    const option = status.options![1]!;
    expect(
      triggerText(
        { kind: 'propertyChanged', propertyId: P.status, to: { operator: 'is', value: option.id } },
        db,
        at,
        'en',
      ),
    ).toBe(`When Status changes to ${option.name}`);
    expect(
      triggerText(
        { kind: 'propertyChanged', propertyId: P.done, to: { operator: 'is', value: true } },
        db,
        at,
        'en',
      ),
    ).toBe('When Done changes to checked');
    expect(amountText(1440, 'en')).toBe('1 day');
    expect(amountText(-90, 'en')).toBe('90 minutes');
  });
  it('makes a repeating row of a template, offered only where the server makes them', async () => {
    const s = seed(3);
    const made = rowCreate(s.host, s.tasksId, { title: 'Water the plants', isTemplate: true })!;
    await s.host.apply([made.op]);
    const fake = new FakeAutomations();
    s.host.automations = fake;
    await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId, embedded: false }));
    await click(button(automationsEn.buttonLabel));
    await click(button(automationsEn.new));
    const triggers = () =>
      [...(selectLabelled(automationsEn.trigger)?.options ?? [])].map((o) => o.value);
    // A server before 0.17.0 makes no repeating rows.
    expect(triggers()).not.toContain('recurring');
    await click(button(automationsEn.cancel));
    fake.data = { ...fake.data, stepKinds: 7 };
    await act(async () => root!.unmount());
    root = null;
    container.innerHTML = '';
    await mount(h(DatabaseView, { host: s.host, databaseId: s.tasksId, embedded: false }));
    await click(button(automationsEn.buttonLabel));
    await click(button(automationsEn.new));
    expect(triggers()).toContain('recurring');
    await choose(selectLabelled(automationsEn.trigger)!, 'recurring');
    // The template, the repetition's fields (the library's, in the automations' words), its days.
    expect(selectLabelled(automationsEn.series.template)!.value).toBe(made.id);
    expect(document.body.textContent).toContain(automationsEn.series.legend);
    expect(document.body.textContent).not.toContain(automationsEn.conditions);
    await choose(selectLabelled(automationsEn.series.mode)!, 'done');
    expect(selectLabelled(automationsEn.series.done)!.value).toBe(P.status);
    // Its row is made by the trigger: the step a new rule starts with is not needed.
    await click(button(automationsEn.stepRemove.replace('{{number}}', '1')));
    await click(button(automationsEn.save));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0]).toMatchObject({
      conditions: null,
      steps: [],
      trigger: {
        kind: 'recurring',
        templateId: made.id,
        rule: { frequency: 'weekly' },
        mode: 'done',
        doneProperty: P.status,
        dateProperty: P.due,
      },
    });

    // "Repeat a template" opens on a new rule for it, named for it, with no steps.
    await act(async () =>
      openAutomations(
        s.tasksId,
        newTrigger('recurring', s.host.database(s.tasksId)!, {
          templates: s.host.rowTemplates(s.tasksId),
          today: '2026-12-01',
        }),
        { name: 'Repeat Water the plants', steps: [] },
      ),
    );
    for (let i = 0; i < 5; i++) await flush();
    expect((document.querySelector('input[maxlength="200"]') as HTMLInputElement).value).toBe(
      'Repeat Water the plants',
    );
    await click(button(automationsEn.save));
    expect(fake.saved[1]).toMatchObject({
      name: 'Repeat Water the plants',
      steps: [],
      trigger: { kind: 'recurring', start: '2026-12-01', mode: 'date', at: '09:00' },
    });
  });

  it('lists "Repeat a template" in the New menu only when given', async () => {
    const s = seed(1);
    const made = rowCreate(s.host, s.tasksId, { title: 'Water the plants', isTemplate: true })!;
    await s.host.apply([made.op]);
    const t = ((key: string) => key) as never;
    const base = {
      host: s.host,
      databaseId: s.tasksId,
      view: null,
      templates: s.host.rowTemplates(s.tasksId),
      t,
      editable: true,
    };
    expect(rowTemplateItems(base).map((i) => i.key)).not.toContain('repeat');
    const opened: string[] = [];
    const items = rowTemplateItems({
      ...base,
      repeat: { text: 'Repeat a template', open: (template) => opened.push(template.id) },
    });
    const repeat = items.find((i) => i.key === 'repeat')!;
    expect(repeat.text).toBe('Repeat a template');
    (repeat.children![0] as unknown as { command(): void }).command();
    expect(opened).toEqual([made.id]);
  });

  it("keeps a reminder only of a date reached, and sets a person's own reminders on a row", async () => {
    const s = seed(3);
    const db = s.host.database(s.tasksId)!;
    // A rule's notices stop being reminders when its trigger is no date.
    const notify = {
      kind: 'notify' as const,
      people: [],
      groups: [],
      personProperties: [P.owner],
      message: '',
      reminder: true,
      when: null,
    };
    const { reminder, ...plain } = notify;
    void reminder;
    const group = { kind: 'group' as const, op: 'and' as const, children: [] };
    expect(
      withoutReminders([
        notify,
        {
          kind: 'branch',
          branches: [{ when: group, steps: [notify] }],
          otherwise: [notify],
          when: null,
        },
      ]),
    ).toEqual([
      plain,
      {
        kind: 'branch',
        branches: [{ when: group, steps: [plain] }],
        otherwise: [plain],
        when: null,
      },
    ]);
    // A repeating rule starts with no steps.
    expect(newRule('r2', db.workspaceId, db, newTrigger('recurring', db)).steps).toEqual([]);

    // A row's "Remind me": a choice for each date property, sent to the server once chosen.
    const fake = new FakeAutomations();
    s.host.automations = fake;
    const row = [...s.host.rowRecords.values()].find(
      (r) => r.databaseId === s.tasksId && !r.isTemplate,
    )!;
    await mount(h(RowProperties, { host: s.host, rowId: row.id }));
    // A server before 0.17.0 keeps no reminders.
    expect(document.body.textContent).not.toContain(automationsEn.remind.title);
    await act(async () => root!.unmount());
    root = null;
    container.innerHTML = '';
    fake.workflows = true;
    await mount(h(RowProperties, { host: s.host, rowId: row.id }));
    const details = [...document.querySelectorAll('details')].find((d) =>
      d.textContent?.startsWith(automationsEn.remind.title),
    )!;
    expect(details).toBeTruthy();
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    for (let i = 0; i < 5; i++) await flush();
    const due = selectLabelled(automationsEn.remind.of.replace('{{property}}', 'Due'))!;
    expect(due.value).toBe('');
    await choose(due, '1440');
    for (let i = 0; i < 3; i++) await flush();
    expect(fake.reminderCalls).toEqual([`set:${P.due}:1440`]);
    expect(due.value).toBe('1440');
    await choose(due, '');
    for (let i = 0; i < 3; i++) await flush();
    expect(fake.reminderCalls).toEqual([`set:${P.due}:1440`, `remove:${P.due}`]);
  });

  it('sums up a repeating row in a sentence', () => {
    const s = seed(1);
    const words = createDatabaseI18n('en');
    words.addResourceBundle(
      'en',
      'translation',
      { database: { automations: automationsEn } },
      true,
      false,
    );
    const loose = words.t as unknown as (key: string, options?: Record<string, unknown>) => string;
    const at = ((key: string, options?: Record<string, unknown>) =>
      loose(`database.automations.${key}`, options)) as never;
    const trigger = {
      ...newTrigger('recurring', s.host.database(s.tasksId)!, { today: '2026-12-01' }),
      templateId: 'tpl',
      rule: { frequency: 'weekly' as const, interval: 2, weekDays: ['monday' as const] },
    } as Extract<AutomationRecord['trigger'], { kind: 'recurring' }>;
    expect(seriesText(trigger, at, 'en', () => 'Water the plants')).toBe(
      'A row from “Water the plants”: Every 2 weeks on Monday',
    );
    expect(seriesText({ ...trigger, mode: 'done' }, at, 'en', () => undefined)).toBe(
      'A row from “a deleted template” once the last is done: Every 2 weeks on Monday',
    );
  });
});
