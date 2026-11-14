// The ERP view block's states (jsdom): every state without data says what it is and shows none;
// connected, it lists connectors, draws the records by type with paging, and writes each setting
// to the block's attributes, never a value from the ERP.
import { afterEach, describe, expect, it } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';
import { ErpError } from '../contract';
import { ar } from '../i18n/ar';
import { en } from '../i18n/en';
import type { Rendered } from './testing';

// The browser first: React DOM reads what it supports when it loads.
installDom();
const { act } = await import('react');
const {
  FakeConnection,
  FakeErp,
  LINK,
  OTHER_LINK,
  RECORDS,
  TICKET,
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

const E = en.erp;
const A = ar.erp;
const CONNECTED = { linkId: LINK.id, connectorId: 'customers' } as const;

let view: Rendered | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

async function connected(options: Parameters<typeof renderView>[0] = {}): Promise<Rendered> {
  view = await renderView({ attrs: CONNECTED, ...options });
  await click(button(view.container, (options.language === 'ar' ? A : E).connect));
  return view;
}

const headers = (el: Element) => [...el.querySelectorAll('th')].map(text);
const firstRow = (el: Element) => [...el.querySelectorAll('tbody tr:first-child td')].map(text);

describe('the ERP view block', { timeout: 30_000 }, () => {
  it('says why there is nothing, with no data, before it can connect', async () => {
    const connection = new FakeConnection();
    connection.availabilityValue = 'signedOut';
    view = await renderView({ attrs: CONNECTED, connection });
    expect(text(view.container)).toBe(E.signIn);

    await act(async () => connection.set({ availabilityValue: 'localWorkspace' }));
    expect(text(view.container)).toBe(E.localWorkspace);

    await act(async () => connection.set({ availabilityValue: 'ready', onlineValue: false }));
    expect(text(view.container)).toBe(E.offline);
    expect(connection.loads).toBe(0);

    await act(async () => connection.set({ onlineValue: true, linksValue: { status: 'loading' } }));
    expect(text(view.container)).toBe(E.linksLoading);
    expect(connection.loads).toBe(1);

    await act(async () => connection.set({ linksValue: { status: 'failed' } }));
    expect(text(view.container)).toContain(E.linksFailed);
    await click(button(view.container, E.retry));
    expect(connection.reloads).toBe(1);

    // A link the workspace no longer has: said so, and the list read again.
    await act(async () => connection.set({ linksValue: { status: 'ready', links: [OTHER_LINK] } }));
    expect(text(view.container)).toBe(E.linkGone);
    expect(connection.reloads).toBe(2);
    expect(view.flow).not.toHaveBeenCalled();
  });

  it('says how to link a workspace with no link, and nothing chosen to a reader', async () => {
    const connection = new FakeConnection();
    connection.linksValue = { status: 'ready', links: [] };
    view = await renderView({ connection });
    expect(text(view.container)).toContain(E.noLink);
    expect(text(view.container)).toContain(E.howToLink);
    view.unmount();

    view = await renderView({ editable: false });
    expect(text(view.container)).toBe(E.notChosen);
    expect(view.container.querySelector('button')).toBeNull();
  });

  it('connects inside the click, shows connecting, and can cancel', async () => {
    let resolveTicket: (ticket: string) => void = () => undefined;
    view = await renderView({
      attrs: CONNECTED,
      flow: (request) =>
        new Promise<string>((resolve, reject) => {
          resolveTicket = resolve;
          request.signal.addEventListener('abort', () => reject(new ErpError('aborted')));
        }),
    });
    expect(text(view.container)).toContain(E.notConnected);
    await click(button(view.container, E.connect));
    // The flow ran in the click itself (the pop-up opens inside it).
    expect(view.flow).toHaveBeenCalledTimes(1);
    expect(view.flow.mock.calls[0]![0]).toMatchObject({
      workspaceId: LINK.workspaceId,
      erpLinkId: LINK.erpLinkId,
    });
    expect(text(view.container)).toContain(E.connectingPopup);
    await click(button(view.container, E.cancel));
    await until(() => text(view!.container).includes(E.notConnected), 'not connected');
    // Cancelled here: not "the window was closed".
    expect(text(view.container)).not.toContain(E.popupClosed);
    expect(resolveTicket).toBeTypeOf('function');
  });

  it('says when the pop-up was blocked or closed, and connects again', async () => {
    let next: ErpError | null = new ErpError('connect.blocked');
    view = await renderView({
      attrs: CONNECTED,
      flow: async () => {
        const error = next;
        if (error) throw error;
        return TICKET;
      },
    });
    await click(button(view.container, E.connect));
    await until(() => text(view!.container).includes(E.popupBlocked), 'blocked');
    expect(view.container.querySelector('[data-code="connect.blocked"]')).not.toBeNull();

    next = new ErpError('connect.cancelled');
    await click(button(view.container, E.connectAgain));
    await until(() => text(view!.container).includes(E.popupClosed), 'closed');

    next = null;
    await click(button(view.container, E.connect));
    await until(() => !!view!.container.querySelector('table'), 'the table');
  });

  it('lists the connectors in the interface language and writes the chosen one', async () => {
    const erp = new FakeErp();
    // An Arabic ERP session in an English interface: the schema's English labels name the data.
    erp.language = 'ar';
    view = await renderView({ erp });
    await click(button(view.container, E.connect));
    await until(() => !!view!.container.querySelector('[data-testid="erp-choose"]'), 'the list');
    expect(text(view.container)).toContain(E.chooseData);
    expect(hasButton(view.container, 'العملاء')).toBe(false);
    await click(button(view.container, 'Customers'));
    expect(view.writes).toEqual([
      {
        linkId: LINK.id,
        connectorId: 'customers',
        fields: null,
        filter: null,
        sort: null,
        pageSize: null,
      },
    ]);
    await until(() => !!view!.container.querySelector('table'), 'the table');
  });

  it('chooses the company first when the workspace has several links', async () => {
    const connection = new FakeConnection();
    connection.linksValue = { status: 'ready', links: [LINK, OTHER_LINK] };
    view = await renderView({ connection });
    const select = view.container.querySelector<HTMLSelectElement>('select')!;
    expect([...select.options].map((o) => o.text)).toEqual(['Kit Trading', 'Dot Foods']);
    await choose(select, OTHER_LINK.id);
    await click(button(view.container, E.connect));
    expect(view.flow.mock.calls[0]![0].erpLinkId).toBe(OTHER_LINK.erpLinkId);
  });

  it('draws the records by type, pages by cursor, and refreshes', async () => {
    view = await connected({ attrs: { ...CONNECTED, pageSize: 2 } });
    await until(() => !!view!.container.querySelector('table'), 'the table');
    const { container } = view;
    expect(headers(container)).toEqual([
      'Account',
      'Name',
      'Credit limit',
      'Visits',
      'Blocked',
      'Last invoice',
      'Modified',
      'Salesperson',
    ]);
    // Decimals keep every digit (grouped, never a float); a date-time keeps the ERP's clock and
    // its offset; a lookup shows its item's label; booleans are words.
    expect(firstRow(container)).toEqual([
      'C-1001',
      'Qorvath Supplies',
      '15,000.50',
      '1,234',
      E.no,
      'Mar 5, 2026',
      'Nov 14, 2026, 10:05 AM UTC+02:00',
      'Bob Stone',
    ]);
    const second = [...container.querySelectorAll('tbody tr:nth-child(2) td')].map(text);
    expect(second[2]).toBe('-0.75');
    expect(second[4]).toBe(E.yes);
    expect(second[5]).toBe('');
    expect(second[6]).toBe('Nov 13, 2026, 11:30 PM UTC');
    expect(text(container.querySelector('[data-testid="erp-range"]')!)).toBe('Records 1–2 of 3');
    expect(text(container.querySelector('[data-testid="erp-loaded-at"]')!)).toMatch(/^Loaded /);
    expect(text(container.querySelector('[data-testid="erp-title"]')!)).toBe('Customers');
    expect(button(container, E.previousPage).disabled).toBe(true);

    await click(button(container, E.nextPage));
    await until(() => text(container).includes('Records 3–3 of 3'), 'page 2');
    expect(view.erp.queries.at(-1)!.cursor).toBe('2');
    expect(firstRow(container)[1]).toBe('Zarkonite Works');
    expect(button(container, E.nextPage).disabled).toBe(true);

    await click(button(container, E.previousPage));
    await until(() => text(container).includes('Records 1–2 of 3'), 'page 1');
    expect(view.erp.queries.at(-1)!.cursor).toBeNull();

    const before = view.erp.queries.length;
    await click(button(container, E.refresh));
    await until(() => view!.erp.queries.length === before + 1, 'a refresh');
    // Paging and refreshing change nothing in the block.
    expect(view.writes).toEqual([]);
  });

  it('labels fields in Arabic for an Arabic session, in an Arabic interface', async () => {
    const erp = new FakeErp();
    erp.language = 'ar';
    view = await connected({ erp, language: 'ar' });
    await until(() => !!view!.container.querySelector('table'), 'the table');
    expect(headers(view.container)[0]).toBe('الحساب');
    expect(text(view.container)).toContain(A.refresh);
    expect(text(view.container)).toContain(A.nextPage);
  });

  it('writes fields, sorts, filters and the page size to the block, and queries by them', async () => {
    view = await connected();
    await until(() => !!view!.container.querySelector('table'), 'the table');
    const { container } = view;

    // Fields: one left out.
    await click(button(container, 'Fields: 8'));
    const box = container.querySelector<HTMLInputElement>('input[data-field="visits"]')!;
    await click(box);
    expect(JSON.parse(view.attrs().fields!)).toEqual([
      'customerAccount',
      'customerName',
      'creditLimit',
      'blocked',
      'lastInvoiceDate',
      'modifiedDate',
      'salesperson',
    ]);
    await until(() => !headers(container).includes('Visits'), 'the column gone');
    expect(view.erp.queries.at(-1)!.fields).not.toContain('visits');

    // A sort, then its direction.
    await click(button(container, E.sort));
    await click(button(container, E.addSort));
    expect(JSON.parse(view.attrs().sort!)).toEqual([
      { field: 'customerAccount', direction: 'asc' },
    ]);
    await choose(
      container.querySelector<HTMLSelectElement>('select[aria-label="Direction of sort 1"]')!,
      'desc',
    );
    expect(JSON.parse(view.attrs().sort!)).toEqual([
      { field: 'customerAccount', direction: 'desc' },
    ]);
    await until(() => view!.erp.queries.at(-1)!.sort?.[0]?.direction === 'desc', 'the sort');
    expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toBe('Account');

    // The filter: a search (written on Enter), then a condition on a lookup.
    await click(button(container, E.filter));
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await type(search, 'Qor');
    await press(search, 'Enter');
    expect(JSON.parse(view.attrs().filter!)).toEqual({ search: 'Qor' });
    // A text condition is written once it has a value; this one has none yet.
    await click(button(container, E.addCondition));
    expect(JSON.parse(view.attrs().filter!)).toEqual({ search: 'Qor' });
    const fieldSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Field"]')!;
    await choose(fieldSelect, 'salesperson');
    expect(JSON.parse(view.attrs().filter!)).toEqual({
      search: 'Qor',
      equals: { salesperson: 'S-ALI' },
    });
    // Inactive lookup items are not offered.
    const values = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Value of Salesperson"]',
    )!;
    expect([...values.options].map((o) => o.value)).toEqual(['', 'S-ALI', 'S-BOB']);
    await choose(values, 'S-BOB');
    expect(JSON.parse(view.attrs().filter!).equals).toEqual({ salesperson: 'S-BOB' });
    await until(
      () =>
        JSON.stringify(view!.erp.queries.at(-1)!.filter) ===
        JSON.stringify({ search: 'Qor', equals: { salesperson: 'S-BOB' } }),
      'the filtered query',
    );

    // The page size.
    const pageSize = [...container.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === '25'),
    )!;
    await choose(pageSize, '25');
    expect(view.attrs().pageSize).toBe(25);
    await until(() => view!.erp.queries.at(-1)!.pageSize === 25, 'the page size');

    // Every write is a setting: none holds a value from a record.
    const written = JSON.stringify(view.writes);
    for (const record of RECORDS) expect(written).not.toContain(String(record.values.customerName));
  });

  it('leaves out what the reader cannot see, and refuses a filter on it', async () => {
    view = await connected({
      attrs: {
        ...CONNECTED,
        fields: JSON.stringify(['customerAccount', 'secretMargin', 'customerName']),
        sort: JSON.stringify([{ field: 'secretMargin', direction: 'asc' }]),
      },
    });
    await until(() => !!view!.container.querySelector('table'), 'the table');
    expect(headers(view.container)).toEqual(['Account', 'Name']);
    expect(text(view.container.querySelector('[data-testid="erp-hidden"]')!)).toBe(
      'Fields of this view your ERP account cannot see, left out: 2',
    );
    expect(view.erp.queries.at(-1)).toMatchObject({ fields: ['customerAccount', 'customerName'] });
    expect(view.erp.queries.at(-1)!.sort).toBeUndefined();
    view.unmount();

    view = await connected({
      attrs: { ...CONNECTED, filter: JSON.stringify({ equals: { secretMargin: 'high' } }) },
    });
    await until(
      () => !!view!.container.querySelector('[data-testid="erp-filter-denied"]'),
      'filter denied',
    );
    expect(view.container.querySelector('table')).toBeNull();
    expect(view.erp.queries).toEqual([]);
  });

  it('says so when the ERP refuses: access, a connector gone, busy, not answering', async () => {
    const erp = new FakeErp();
    erp.failures.schema = new ErpError('privilege.denied', { status: 403, correlationId: 'c-42' });
    view = await connected({ erp });
    await until(() => text(view!.container).includes(E.noAccess), 'no access');
    expect(text(view.container)).toContain('Reference: c-42');
    expect(view.container.querySelector('table')).toBeNull();

    erp.failures.schema = new ErpError('connector.notFound', { status: 404 });
    await click(button(view.container, E.retry));
    await until(() => text(view!.container).includes(E.connectorNotFound), 'not found');

    erp.failures.query = new ErpError('rate.limited', { status: 429, retryAfterMs: 3000 });
    await click(button(view.container, E.retry));
    await until(() => text(view!.container).includes('Try again in 3 s'), 'busy');
    expect(button(view.container, E.retry).disabled).toBe(true);
    expect(view.container.querySelector('table')).toBeNull();
    await until(() => text(view!.container).includes(E.rateLimitedNow), 'the wait over');
    erp.failures.query = new ErpError('network');
    await click(button(view.container, E.retry));
    await until(() => text(view!.container).includes(E.notAnswering), 'not answering');
    await click(button(view.container, E.retry));
    await until(() => !!view!.container.querySelector('table'), 'the table');
  });

  it('asks to connect again when the session ends, and says when the ERP revoked the link', async () => {
    const erp = new FakeErp();
    view = await connected({ erp });
    await until(() => !!view!.container.querySelector('table'), 'the table');
    erp.failures.query = new ErpError('session.expired', { status: 401 });
    await click(button(view.container, E.refresh));
    await until(() => text(view!.container).includes(E.expired), 'expired');
    expect(view.container.querySelector('table')).toBeNull();
    expect(view.sessions.state(LINK.id)).toBe('expired');

    await click(button(view.container, E.connectAgain));
    await until(() => !!view!.container.querySelector('table'), 'the table again');
    erp.failures.query = new ErpError('link.revoked', { status: 403 });
    await click(button(view.container, E.refresh));
    await until(
      () => text(view!.container).includes(E.linkRevoked.replace('{{company}}', 'Kit Trading')),
      'revoked',
    );
    expect(view.container.querySelector('table')).toBeNull();
    expect(hasButton(view.container, E.connectAgain)).toBe(false);
  });

  it('shows a reader the data with no settings, and writes nothing', async () => {
    view = await connected({ editable: false });
    await until(() => !!view!.container.querySelector('table'), 'the table');
    expect(view.container.querySelector('[role="group"][aria-label="View settings"]')).toBeNull();
    expect(hasButton(view.container, 'Fields: 8')).toBe(false);
    expect(hasButton(view.container, E.refresh)).toBe(true);
    expect(view.writes).toEqual([]);
  });
});
