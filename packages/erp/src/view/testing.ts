// What the view tests share: a fake ERP client behind real `ErpSessions`, a fake connection
// (links, online state, availability) and a block whose attributes change as the editor would
// change them. Test-only: nothing here is exported from the package. A test installs the browser
// (`installDom`) before it imports this, since React DOM reads what it supports when it loads.
import { act, createElement, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { vi } from 'vitest';
import type { ErpClient } from '../client';
import {
  ErpError,
  LIMITS,
  type ConnectSession,
  type ConnectorSchema,
  type ConnectorSummary,
  type ErpRecord,
  type Language,
  type QueryRequest,
  type QueryResponse,
} from '../contract';
import { createErpI18n } from '../i18n';
import { ErpSessions, type ConnectFlow } from '../session';
import type {
  ErpAvailability,
  ErpBlockAttrs,
  ErpConnection,
  ErpLinkInfo,
  ErpLinksState,
  ErpViewHost,
} from './host';

export const TICKET = 'T'.repeat(43);

export const LINK: ErpLinkInfo = {
  id: '01930000-0000-7000-8000-00000000a001',
  erpLinkId: 'erp-link-kit',
  workspaceId: '01930000-0000-7000-8000-0000000000aa',
  company: 'Kit',
  companyName: 'Kit Trading',
  linkedBy: { id: 'u-1', name: 'Dana' },
  linkedAt: '2026-11-14T09:00:00Z',
};

export const OTHER_LINK: ErpLinkInfo = {
  ...LINK,
  id: '01930000-0000-7000-8000-00000000a002',
  erpLinkId: 'erp-link-dot',
  company: 'Dot',
  companyName: 'Dot Foods',
};

export const EMPTY_ATTRS: ErpBlockAttrs = {
  linkId: null,
  connectorId: null,
  filter: null,
  fields: null,
  sort: null,
  pageSize: null,
};

export const CONNECTORS: ConnectorSummary[] = [
  {
    id: 'customers',
    kind: 'entity',
    label: { en: 'Customers', ar: 'العملاء' },
    schemaVersion: 'customers.1',
    access: 'view',
  },
  {
    id: 'vendors',
    kind: 'entity',
    label: { en: 'Vendors', ar: 'الموردون' },
    schemaVersion: 'vendors.1',
    access: 'view',
  },
];

const field = (
  name: string,
  en: string,
  ar: string,
  type: ConnectorSchema['fields'][number]['type'],
  extra: Partial<ConnectorSchema['fields'][number]> = {},
): ConnectorSchema['fields'][number] => ({
  name,
  label: { en, ar },
  type,
  editable: false,
  editReason: 'notEditable',
  filterable: false,
  sortable: false,
  ...extra,
});

export const SCHEMA: ConnectorSchema = {
  id: 'customers',
  schemaVersion: 'customers.1',
  keyField: 'customerAccount',
  idField: 'recId',
  maxPageSize: 500,
  maxRecords: 100_000,
  maxCommitRecords: 0,
  fields: [
    field('customerAccount', 'Account', 'الحساب', 'text', { filterable: true, sortable: true }),
    field('customerName', 'Name', 'الاسم', 'text', { sortable: true }),
    field('creditLimit', 'Credit limit', 'حد الائتمان', 'decimal', { scale: 2, sortable: true }),
    field('visits', 'Visits', 'الزيارات', 'integer'),
    field('blocked', 'Blocked', 'محظور', 'boolean', { filterable: true }),
    field('lastInvoiceDate', 'Last invoice', 'آخر فاتورة', 'date'),
    field('modifiedDate', 'Modified', 'آخر تعديل', 'dateTime', { sortable: true }),
    field('salesperson', 'Salesperson', 'المندوب', 'lookup', {
      lookup: 'salespeople',
      filterable: true,
    }),
  ],
  lookups: {
    salespeople: [
      { code: 'S-ALI', label: 'Ali Hassan' },
      { code: 'S-BOB', label: 'Bob Stone' },
      { code: 'S-OLD', label: 'Retired', active: false },
    ],
  },
};

/** Distinctive values, as the mock's markers are, so a leak is easy to look for. */
export const RECORDS: ErpRecord[] = [
  {
    id: 'r1',
    key: 'C-1001',
    version: 'AAAAAAAAB9E=',
    values: {
      customerAccount: 'C-1001',
      customerName: 'Qorvath Supplies',
      creditLimit: '15000.50',
      visits: 1234,
      blocked: false,
      lastInvoiceDate: '2026-03-05',
      modifiedDate: '2026-11-14T10:05:00+02:00',
      salesperson: 'S-BOB',
    },
  },
  {
    id: 'r2',
    key: 'C-1002',
    version: 'AAAAAAAAB9I=',
    values: {
      customerAccount: 'C-1002',
      customerName: 'Velmorra Trading',
      creditLimit: '-0.75',
      visits: 0,
      blocked: true,
      lastInvoiceDate: null,
      modifiedDate: '2026-11-13T23:30:00Z',
      salesperson: 'S-ALI',
    },
  },
  {
    id: 'r3',
    key: 'C-1003',
    version: 'AAAAAAAAB9M=',
    values: {
      customerAccount: 'C-1003',
      customerName: 'Zarkonite Works',
      creditLimit: '200.00',
      visits: 7,
      blocked: false,
      lastInvoiceDate: '2025-12-31',
      modifiedDate: '2026-01-01T00:00:00+04:00',
      salesperson: null,
    },
  },
];

/** An ERP in memory behind the client's interface, paging by offset as the mock does. */
export class FakeErp {
  language: Language = 'en';
  connectorsList: ConnectorSummary[] = CONNECTORS;
  schemaValue: ConnectorSchema = SCHEMA;
  records: ErpRecord[] = RECORDS;
  /** The next call of a kind fails with this. */
  readonly failures: Partial<Record<'connectors' | 'schema' | 'query' | 'redeem', ErpError>> = {};
  readonly queries: QueryRequest[] = [];
  readonly ended: string[] = [];
  private n = 0;

  readonly client: ErpClient = {
    apiBase: 'http://127.0.0.1:4282',
    redeemLink: vi.fn(),
    redeem: async (): Promise<ConnectSession> => {
      this.fail('redeem');
      const now = Date.now();
      return {
        token: `tok_${++this.n}_${'s'.repeat(40)}`,
        expiresAt: new Date(now + LIMITS.sessionIdleMs).toISOString(),
        maxExpiresAt: new Date(now + LIMITS.sessionMaxMs).toISOString(),
        linkId: LINK.erpLinkId,
        company: 'Kit',
        companyName: 'Kit Trading',
        user: { id: 'u101', displayName: 'Alice Haddad' },
        language: this.language,
      };
    },
    renew: async () => ({
      expiresAt: new Date(Date.now() + LIMITS.sessionIdleMs).toISOString(),
    }),
    end: async (token) => {
      this.ended.push(token);
    },
    connectors: async () => {
      this.fail('connectors');
      return this.connectorsList;
    },
    schema: async () => {
      this.fail('schema');
      return this.schemaValue;
    },
    query: async (_token, _id, request): Promise<QueryResponse> => {
      this.queries.push(request);
      this.fail('query');
      const start = request.cursor ? Number(request.cursor) : 0;
      const page = this.records.slice(start, start + request.pageSize).map((record) => ({
        ...record,
        values: request.fields
          ? Object.fromEntries(request.fields.map((name) => [name, record.values[name] ?? null]))
          : record.values,
      }));
      const next = start + request.pageSize;
      return {
        records: page,
        nextCursor: next < this.records.length ? String(next) : null,
        total: this.records.length,
      };
    },
  };

  private fail(kind: keyof FakeErp['failures']) {
    const error = this.failures[kind];
    if (error) {
      delete this.failures[kind];
      throw error;
    }
  }
}

/** The tab's connection, as the shell gives it, held by the test. */
export class FakeConnection implements ErpConnection {
  availabilityValue: ErpAvailability = 'ready';
  onlineValue = true;
  linksValue: ErpLinksState = { status: 'ready', links: [LINK] };
  connectKind: 'popup' | 'browser' = 'popup';
  loads = 0;
  reloads = 0;
  private readonly listeners = new Set<() => void>();
  availability = () => this.availabilityValue;
  online = () => this.onlineValue;
  links = () => this.linksValue;
  loadLinks = () => void this.loads++;
  reloadLinks = () => void this.reloads++;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  set(change: Partial<Pick<FakeConnection, 'availabilityValue' | 'onlineValue' | 'linksValue'>>) {
    Object.assign(this, change);
    for (const listener of [...this.listeners]) listener();
  }
}

export interface Rendered {
  container: HTMLElement;
  erp: FakeErp;
  connection: FakeConnection;
  sessions: ErpSessions;
  flow: ReturnType<typeof vi.fn<ConnectFlow>>;
  /** Every `setAttrs` the view made. */
  writes: Partial<ErpBlockAttrs>[];
  /** The block's attributes now. */
  attrs(): ErpBlockAttrs;
  unmount(): void;
}

/** Renders `ErpView` in a block whose attributes take what the view writes, as the editor does. */
export async function renderView(
  options: {
    attrs?: Partial<ErpBlockAttrs>;
    editable?: boolean;
    language?: Language;
    erp?: FakeErp;
    connection?: FakeConnection;
    flow?: ConnectFlow;
  } = {},
): Promise<Rendered> {
  const { ErpView } = await import('./ErpView');
  const erp = options.erp ?? new FakeErp();
  const connection = options.connection ?? new FakeConnection();
  const flow = vi.fn<ConnectFlow>(options.flow ?? (async () => TICKET));
  const sessions = new ErpSessions({ client: erp.client, flow, target: null });
  const writes: Partial<ErpBlockAttrs>[] = [];
  let current: ErpBlockAttrs = { ...EMPTY_ATTRS, ...options.attrs };
  const editable = options.editable ?? true;

  function Block() {
    const [attrs, setAttrsState] = useState(current);
    const host = useMemo<ErpViewHost>(
      () => ({
        attrs,
        editable,
        setAttrs: (change) => {
          writes.push(change);
          current = { ...current, ...change };
          setAttrsState(current);
        },
        connection,
        sessions,
      }),
      [attrs],
    );
    return createElement(ErpView, { host });
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const i18n = createErpI18n(options.language ?? 'en');
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, createElement(Block)));
  });
  return {
    container,
    erp,
    connection,
    sessions,
    flow,
    writes,
    attrs: () => current,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      sessions.dispose();
    },
  };
}

/** Lets promises and timers run until `check` holds (or fails the test). */
export async function until(check: () => boolean, what = 'the condition'): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

export const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

export function button(container: Element, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => text(b) === label || b.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`No button "${label}" in: ${text(container)}`);
  return found;
}

export const hasButton = (container: Element, label: string) =>
  [...container.querySelectorAll('button')].some(
    (b) => text(b) === label || b.getAttribute('aria-label') === label,
  );

export async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

/** Types into a controlled input as a person does: the value, then an input event. */
export async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export async function press(el: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}
