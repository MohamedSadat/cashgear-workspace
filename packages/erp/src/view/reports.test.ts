// A report in an ERP view block (Phase 12, jsdom): listed as a report, its parameters above its
// table written to the block as the person sets them (a default not held), sent with every query
// (`{}` for every default), its totals and labels drawn, the ERP's notes, no editing and no AI,
// and a reader shown the parameters read-only. A query runs on Refresh and on a parameter's
// change, once each.
import { afterEach, describe, expect, it } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';
import type { ConnectorSchema } from '../contract';
import { ErpDrafts } from '../drafts';
import { ar } from '../i18n/ar';
import { en } from '../i18n/en';
import { reportsAr, reportsEn } from '../i18n/reports';
import type { Rendered } from './testing';

installDom();
const {
  AP_AGING,
  AP_SCHEMA,
  BLOCK_ID,
  FakeErp,
  LINK,
  PAGE_ID,
  button,
  choose,
  click,
  hasButton,
  press,
  renderView,
  text,
  type,
  until,
} = await import('./testing');

const E = { ...en.erp, ...reportsEn };
const A = { ...ar.erp, ...reportsAr };
const REPORT = { linkId: LINK.id, connectorId: 'apAging' } as const;

let view: Rendered | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

async function report(options: Parameters<typeof renderView>[0] = {}): Promise<Rendered> {
  const erp = options.erp ?? new FakeErp().report();
  view = await renderView({ attrs: REPORT, ...options, erp });
  await click(button(view.container, (options.language === 'ar' ? A : E).connect));
  return view;
}

const loaded = (v: Rendered) =>
  until(() => !!v.container.querySelector('[data-testid="erp-table"] tbody tr'), 'the table');
const control = <T extends Element>(v: Rendered, name: string, selector: string) =>
  v.container.querySelector<T>(`[data-parameter="${name}"] ${selector}`)!;
const header = (v: Rendered, field: string) =>
  text(v.container.querySelector(`thead th[data-field="${field}"]`)!);
const lastParameters = (v: Rendered) => v.erp.queries.at(-1)!.parameters;

describe('a report block', { timeout: 30_000 }, () => {
  it('is listed as a report, apart from the lists, and chosen like any data', async () => {
    const erp = new FakeErp().report();
    view = await renderView({ erp });
    await click(button(view.container, E.connect));
    await until(() => !!view!.container.querySelector('[data-testid="erp-choose"]'), 'the list');
    const picker = view.container.querySelector('[data-testid="erp-choose"]')!;
    expect(text(picker)).toContain(E.lists);
    expect(text(picker)).toContain(E.reports);
    const buttons = [...picker.querySelectorAll('button')];
    expect(buttons.map((b) => [text(b), b.dataset.kind])).toEqual([
      ['Customers', 'entity'],
      ['Vendors', 'entity'],
      ['AP aging by vendor', 'report'],
    ]);
    // Each list is named by its heading.
    const lists = [...picker.querySelectorAll('ul')];
    expect(
      lists.map((ul) => text(document.getElementById(ul.getAttribute('aria-labelledby')!)!)),
    ).toEqual([E.lists, E.reports]);
    await click(button(view.container, 'AP aging by vendor'));
    expect(view.writes).toEqual([
      {
        linkId: LINK.id,
        connectorId: 'apAging',
        fields: null,
        filter: null,
        sort: null,
        pageSize: null,
        parameters: null,
      },
    ]);
    await loaded(view);
    expect(text(view.container.querySelector('[data-testid="erp-report"]')!)).toBe(E.reportTag);
    // The editor's "Data" list holds the reports in a group of their own.
    const data = [...view.container.querySelectorAll<HTMLSelectElement>('select')].find((s) =>
      [...s.options].some((o) => o.value === 'apAging'),
    )!;
    expect([...data.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([
      E.lists,
      E.reports,
    ]);
  });

  it('asks with {} for every default, and draws its totals and the labels it gives', async () => {
    view = await report();
    await loaded(view);
    expect(view.erp.queries).toHaveLength(1);
    expect(lastParameters(view)).toEqual({});
    const totals = view.container.querySelector('tfoot [data-testid="erp-totals"]')!;
    const first = totals.querySelector('th[scope="row"]')!;
    expect(text(first)).toBe(E.total);
    expect(text(totals.querySelector('td[data-field="balance"]')!)).toBe('1,750.50');
    expect(text(totals.querySelector('td[data-field="band1"]')!)).toBe('750.50');
    // A column without a total stays empty.
    expect(text(totals.querySelector('td[data-field="openItems"]')!)).toBe('');
    expect(header(view, 'band0')).toBe('Not due');
    // No editing and nothing for AI, whatever the ERP says of the person.
    expect(hasButton(view.container, E.editData)).toBe(false);
    expect(hasButton(view.container, E.aiPrepare)).toBe(false);
  });

  it('writes each kind of parameter at once, a default not held, and asks once a change', async () => {
    view = await report();
    await loaded(view);
    const v = view;
    const queries = () => v.erp.queries.length;

    // A choice: shown at its default, its other value held and sent.
    const ageBy = control<HTMLSelectElement>(v, 'ageBy', 'select');
    expect(ageBy.value).toBe('dueDate');
    expect([...ageBy.options].map((o) => o.text)).toEqual(['Due date', 'Invoice date']);
    await choose(ageBy, 'invoiceDate');
    expect(v.attrs().parameters).toBe('{"ageBy":"invoiceDate"}');
    await until(
      () => queries() === 2 && header(v, 'band0') === '0–30 days',
      'the bands by invoice',
    );
    expect(lastParameters(v)).toEqual({ ageBy: 'invoiceDate' });
    await choose(control<HTMLSelectElement>(v, 'ageBy', 'select'), 'dueDate');
    expect(v.attrs().parameters).toBeNull();
    await until(() => queries() === 3, 'the query');

    // A lookup: "All" first, active codes only.
    const group = control<HTMLSelectElement>(v, 'vendorGroup', 'select');
    expect([...group.options].map((o) => o.text)).toEqual([E.parameterAll, 'Local', 'Import']);
    await choose(group, 'IMPORT');
    expect(v.attrs().parameters).toBe('{"vendorGroup":"IMPORT"}');
    await until(() => queries() === 4, 'the query');
    expect(lastParameters(v)).toEqual({ vendorGroup: 'IMPORT' });
    await choose(control<HTMLSelectElement>(v, 'vendorGroup', 'select'), '');
    expect(v.attrs().parameters).toBeNull();
    await until(() => queries() === 5, 'the query');

    // A switch.
    const zero = control<HTMLInputElement>(v, 'includeZero', 'input[role="switch"]');
    expect(zero.checked).toBe(false);
    expect(zero.closest('label')!.textContent).toContain('Include zero balances');
    await click(zero);
    expect(v.attrs().parameters).toBe('{"includeZero":true}');
    await until(() => queries() === 6, 'the query');
    await click(control<HTMLInputElement>(v, 'includeZero', 'input[role="switch"]'));
    expect(v.attrs().parameters).toBeNull();
    await until(() => queries() === 7, 'the query');

    // A date: "Today" until one is set; cleared, back to the default.
    const asOf = control<HTMLInputElement>(v, 'asOf', 'input[role="combobox"]');
    expect(asOf.placeholder).toBe(E.defaultToday);
    expect(asOf.value).toBe('');
    const label = v.container.querySelector(`label[for="${asOf.id}"]`)!;
    expect(text(label)).toBe('As of');
    await type(asOf, '10/31/2026');
    await press(asOf, 'Enter');
    await until(() => v.attrs().parameters === '{"asOf":"2026-10-31"}', 'the date written');
    await until(() => queries() === 8, 'the query');
    expect(lastParameters(v)).toEqual({ asOf: '2026-10-31' });
    await click(button(v.container, E.dateClear));
    await until(() => v.attrs().parameters === null, 'the date cleared');
    await until(() => queries() === 9, 'the query');
    expect(lastParameters(v)).toEqual({});

    // Refresh asks once more; nothing else asks again by itself.
    await click(button(v.container, E.refresh));
    await until(() => queries() === 10, 'the refresh');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(queries()).toBe(10);
  });

  it('keeps names the report does not list when another is written', async () => {
    view = await report({ attrs: { ...REPORT, parameters: '{"gone":"kept","ageBy":"weekday"}' } });
    await loaded(view);
    // A value its type does not take is not sent: the default applies.
    expect(lastParameters(view)).toEqual({});
    expect(control<HTMLSelectElement>(view, 'ageBy', 'select').value).toBe('dueDate');
    await click(control<HTMLInputElement>(view, 'includeZero', 'input[role="switch"]'));
    expect(JSON.parse(view.attrs().parameters!)).toEqual({
      gone: 'kept',
      ageBy: 'weekday',
      includeZero: true,
    });
  });

  it('asks nothing while a required parameter has no value and no default', async () => {
    const erp = new FakeErp().report();
    erp.schemaValue = {
      ...AP_SCHEMA,
      parameters: AP_SCHEMA.parameters!.map((p) =>
        p.name === 'asOf' ? { ...p, default: undefined } : p,
      ) as ConnectorSchema['parameters'],
    };
    view = await report({ erp });
    const v = view;
    await until(
      () => !!v.container.querySelector('[data-testid="erp-parameter-needed"]'),
      'the message',
    );
    expect(text(v.container.querySelector('[data-testid="erp-parameter-needed"]')!)).toBe(
      'Choose “As of” to see this report.',
    );
    expect(erp.queries).toHaveLength(0);
    const asOf = control<HTMLInputElement>(v, 'asOf', 'input[role="combobox"]');
    expect(asOf.placeholder).toBe(E.parameterChoose);
    await type(asOf, '11/1/2026');
    await press(asOf, 'Enter');
    await loaded(v);
    expect(erp.queries).toHaveLength(1);
    expect(lastParameters(v)).toEqual({ asOf: '2026-11-01' });
  });

  it('says when the ERP cut the report short, and when only the first records can be read', async () => {
    const erp = new FakeErp().report();
    erp.schemaValue = { ...AP_SCHEMA, maxRecords: 1 };
    const answer = erp.answerWith!;
    erp.answerWith = (request) => ({ ...answer(request), partial: true });
    view = await report({ erp });
    await loaded(view);
    expect(text(view.container.querySelector('[data-testid="erp-partial"]')!)).toBe(E.partial);
    expect(text(view.container.querySelector('[data-testid="erp-first-n"]')!)).toBe(
      'Only the first 1 of 2 records can be shown here. Narrow the filter to see the others.',
    );
  });

  it('has no editing for a report even when the ERP says the person may edit', async () => {
    const erp = new FakeErp().report();
    erp.connectorsList = [{ ...AP_AGING, access: 'edit' }];
    view = await report({ erp, ai: { prepare: async () => [] } });
    await loaded(view);
    expect(hasButton(view.container, E.editData)).toBe(false);
    expect(hasButton(view.container, E.aiPrepare)).toBe(false);
    expect(view.container.querySelector('tbody button')).toBeNull();
    expect(view.drafts.peek(ErpDrafts.key(PAGE_ID, BLOCK_ID))).toBeFalsy();
  });

  it('shows a reader the parameters read-only, and runs the report with what is held', async () => {
    view = await report({
      editable: false,
      attrs: { ...REPORT, parameters: '{"ageBy":"invoiceDate","includeZero":true}' },
    });
    await loaded(view);
    expect(lastParameters(view)).toEqual({ ageBy: 'invoiceDate', includeZero: true });
    expect(view.container.querySelector('[role="group"][aria-label="View settings"]')).toBeNull();
    const ageBy = control<HTMLSelectElement>(view, 'ageBy', 'select');
    expect(ageBy.value).toBe('invoiceDate');
    expect(ageBy.getAttribute('aria-readonly')).toBe('true');
    await choose(ageBy, 'dueDate');
    const zero = control<HTMLInputElement>(view, 'includeZero', 'input[role="switch"]');
    expect(zero.getAttribute('aria-readonly')).toBe('true');
    await click(zero);
    expect(control<HTMLInputElement>(view, 'asOf', 'input').readOnly).toBe(true);
    expect(view.writes).toEqual([]);
    expect(view.erp.queries).toHaveLength(1);
  });

  it('reads in Arabic: its parameters, labels and totals', async () => {
    view = await report({ language: 'ar' });
    await loaded(view);
    const bar = view.container.querySelector('[data-testid="erp-parameters"]')!;
    expect(text(document.getElementById(bar.getAttribute('aria-labelledby')!)!)).toBe(
      A.reportSettings,
    );
    expect(text(bar)).toContain('حتى تاريخ');
    expect(text(bar)).toContain('العمر حسب');
    expect(
      [...control<HTMLSelectElement>(view, 'ageBy', 'select').options].map((o) => o.text),
    ).toEqual(['تاريخ الاستحقاق', 'تاريخ الفاتورة']);
    expect(control<HTMLInputElement>(view, 'asOf', 'input[role="combobox"]').placeholder).toBe(
      A.defaultToday,
    );
    expect(header(view, 'band0')).toBe('غير مستحق');
    expect(text(view.container.querySelector('tfoot th[scope="row"]')!)).toContain(A.total);
    expect(text(view.container.querySelector('[data-testid="erp-report"]')!)).toBe(A.reportTag);
  });
});
