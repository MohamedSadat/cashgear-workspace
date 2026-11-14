// No ERP data at rest (INTEGRATIONS.md, "Principles" 3): a workspace linked to the mock ERP, an
// ERP block in a real page, connected as alice, its records drawn, paged and refreshed; then the
// store (documents, outbox, search index, prefs, every table), the session's mirror, the page's
// document, what the block wrote, and the browser's storage hold none of the mock's distinctive
// values, while the block on screen shows them. The proof stream does the same in the browser
// and on the desktop; this is the in-memory store.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act } = await import('react');
const Y = await import('yjs');
const { build } = await import('@cgw/doc');
const { MARKERS, startMockErp } = await import('../../../../tests/mocks/erp/server.mjs');
const { FakeServer } = await import('../../../workspace/src/testing/fakeServer');
const { sharedWorkspace } = await import('../../../workspace/src/testing/syncHarness');
const { createI18n } = await import('../i18n');
const { WorkspaceSession } = await import('../session');
const { ShellErp } = await import('./services');
const { mountErp } = await import('./mount');

const ORIGIN = 'http://127.0.0.1:5273';
let mock: Awaited<ReturnType<typeof startMockErp>>;

beforeAll(async () => {
  mock = await startMockErp({ apiPort: 0, clientPort: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await mock?.close();
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 600 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

async function control(path: string, body: unknown) {
  const answer = await fetch(`${mock.apiUrl}/__mock/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!answer.ok) throw new Error(`${path}: ${answer.status}`);
  return (await answer.json()) as { ticket: string };
}

/** Every string a value holds, bytes read as UTF-8 too, however deep. */
function strings(value: unknown, out: string[] = [], seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value instanceof Uint8Array) out.push(new TextDecoder().decode(value));
  else if (value instanceof Map) for (const [k, v] of value) strings([k, v], out, seen);
  else if (value instanceof Set) for (const v of value) strings(v, out, seen);
  else if (typeof value === 'object' && value !== null && !(value instanceof Promise)) {
    if (seen.has(value)) return out;
    seen.add(value);
    for (const v of Object.values(value)) strings(v, out, seen);
  }
  return out;
}

describe('ERP data at rest', { timeout: 60_000 }, () => {
  it('is nowhere after a query: not the store, its prefs, the document or what the block wrote', async () => {
    const shared = await sharedWorkspace(new FakeServer());
    const store = shared.one.store;
    const session = await WorkspaceSession.start(store);
    session.switchTo(shared.ws.id);

    // The browser's own requests carry the app's Origin, which the mock checks.
    const fetchFromApp = (input: string, init: RequestInit) =>
      fetch(input, { ...init, headers: { ...(init.headers as object), Origin: ORIGIN } });
    const links: {
      id: string;
      erpLinkId: string;
      workspaceId: string;
      company: string;
      companyName: string;
      linkedBy: null;
      linkedAt: string;
    }[] = [];
    const cloud = {
      account: () => ({ id: 'u-1', email: 'a@example.test', displayName: 'A', deviceId: 'd-1' }),
      subscribe: () => () => undefined,
      listLinks: async () => [...links],
      createLink: async (
        workspaceId: string,
        body: { erpLinkId: string; company: string; companyName: string },
      ) => {
        links.push({
          id: '01930000-0000-7000-8000-0000000e7001',
          workspaceId,
          linkedBy: null,
          linkedAt: new Date().toISOString(),
          ...body,
        });
        return 'created' as const;
      },
      deleteLink: async () => undefined,
    };
    // Connecting as alice without the pop-up: the mock's connect ticket stands in for it.
    const flow = vi.fn(
      async (request: { workspaceId: string; erpLinkId: string }) =>
        (
          await control('connect-ticket', {
            user: 'alice',
            workspaceId: request.workspaceId,
            linkId: request.erpLinkId,
          })
        ).ticket,
    );
    const services = new ShellErp(
      session,
      {
        kind: 'web',
        erp: { apiBase: mock.apiUrl, clientOrigin: mock.clientUrl },
        setWindowTheme: async () => {},
        openExternal: async () => {},
        openStore: async () => store,
        saveFile: async () => {},
      },
      { fetch: fetchFromApp, flow, target: null },
    );
    services.setCloud(cloud);

    // Linking, as the link screen does: the ERP's Redeem, then Workspace's record.
    const { ticket } = await control('link-ticket', { user: 'dan' });
    const redeemed = await services.redeemLink(ticket, { id: shared.ws.id, name: shared.ws.name });
    expect(redeemed.companyName).toBe('Kit Trading');
    await services.recordLink(shared.ws.id, redeemed);
    expect(services.links()).toMatchObject({ status: 'ready', links: [{ company: 'Kit' }] });

    // A page with a new ERP block, its attributes changed in the document as the editor does.
    const section = session.mirror.sectionsOf(shared.ws.id)[0]!;
    const page = await session.createPage(
      { sectionId: section.id, parentPageId: null },
      build.docOf(build.erpView(null, null)),
    );
    const doc = await session.openDoc(page.id);
    const element = () => {
      let found: InstanceType<typeof Y.XmlElement> | null = null;
      const walk = (
        node: InstanceType<typeof Y.XmlFragment> | InstanceType<typeof Y.XmlElement>,
      ) => {
        for (const child of node.toArray())
          if (child instanceof Y.XmlElement) {
            if (child.nodeName === 'erpView') found = child;
            else walk(child);
          }
      };
      walk(doc.fragment);
      return found!;
    };
    const blockId = (element().parent as InstanceType<typeof Y.XmlElement>).getAttribute(
      'id',
    ) as string;
    const writes: unknown[] = [];
    const attrs = () => {
      const el = element();
      const read = (name: string) => (el.getAttribute(name) as unknown) ?? null;
      return {
        linkId: read('linkId') as string | null,
        connectorId: read('connectorId') as string | null,
        filter: read('filter') as string | null,
        fields: read('fields') as string | null,
        sort: read('sort') as string | null,
        pageSize: read('pageSize') as number | null,
      };
    };
    const i18n = createI18n('en');
    const frameElement = document.createElement('div');
    document.body.append(frameElement);
    let options: Parameters<typeof mountErp>[1];
    const setAttrs = (change: Record<string, unknown>) => {
      writes.push(change);
      const before = attrs().linkId;
      doc.doc.transact(() => {
        for (const [name, value] of Object.entries(change))
          element().setAttribute(name, value as string);
      });
      options = { ...attrs(), blockId, editable: true, setAttrs };
      // The node view mounts again when the link changes; anything else is an update.
      if (attrs().linkId !== before) {
        frame.destroy();
        frame = mountErp(frameElement, options, { services, i18n });
      } else frame.update(options);
    };
    options = { ...attrs(), blockId, editable: true, setAttrs };
    let frame = mountErp(frameElement, options, { services, i18n });
    const button = (label: string) =>
      [...frameElement.querySelectorAll('button')].find((b) => b.textContent === label)!;

    await until(() => !!button(i18n.t('erp.connect')), 'connect');
    await act(async () => button(i18n.t('erp.connect')).click());
    await until(() => !!button('Customers'), 'the connectors');
    await act(async () => button('Customers').click());
    await until(() => !!frameElement.querySelector('table tbody tr'), 'the records');
    expect(attrs()).toMatchObject({ linkId: links[0]!.id, connectorId: 'customers' });

    // A page further, a sort, a refresh: more answers through the block.
    await act(async () => button(i18n.t('erp.nextPage')).click());
    await until(
      () => frameElement.textContent!.includes('Records 51–100 of 240'),
      'the second page',
    );
    await act(async () => button(i18n.t('erp.sort')).click());
    await act(async () => button(i18n.t('erp.addSort')).click());
    await until(() => frameElement.textContent!.includes('Records 1–50 of 240'), 'sorted');
    await act(async () => button(i18n.t('erp.refresh')).click());
    await until(() => !!frameElement.querySelector('table tbody tr'), 'refreshed');

    // The block shows the mock's values...
    const shown = frameElement.textContent!;
    const markers = [...MARKERS.Kit, ...MARKERS.Dot];
    expect(markers.filter((m) => shown.includes(m)).length).toBeGreaterThan(0);

    // ...and nothing holds them at rest.
    await session.flushAll();
    await doc.flush();
    const atRest = [
      ...strings(store),
      ...strings([...session.mirror.pages.values()]),
      ...strings(Y.encodeStateAsUpdate(doc.doc)),
      JSON.stringify(doc.fragment.toJSON()),
      JSON.stringify(writes),
      ...Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`),
    ].join('\n');
    expect(atRest.length).toBeGreaterThan(1000);
    for (const marker of markers) expect(atRest, marker).not.toContain(marker);
    // What the saved document does hold: the link and the connector, which are not ERP data.
    const saved = strings(store).join(' ');
    expect(saved).toContain(links[0]!.id);
    expect(saved).toContain('customers');

    frame.destroy();
    services.dispose();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    // Leaving ends the session at the ERP.
    await until(
      () => mock.mock.state().sessions.every((s) => s.ended || !s.live),
      'the session ended',
    );
    await doc.close();
  });
});
