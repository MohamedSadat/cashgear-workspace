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
const { triggerText, amountText } = await import('./model');
const { automationsEn } = await import('./words');
import type { AutomationRecord, PropertyDef } from '../core';
import type { AutomationRunsPage, AutomationsHost, DatabaseAutomations } from '../host';

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
});
