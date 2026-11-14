// The link screen and the settings section (jsdom): linking sends the ticket once and forgets it,
// whatever the answer; each refusal says what it is; unlinking is for owners and admins.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';
import { ErpError, type LinkRedeemResponse } from '../contract';
import { en } from '../i18n/en';
import type { ErpLinkScreenHost, ErpSettingsHost } from './host';

installDom();
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createErpI18n } = await import('../i18n');
const { ErpLinkScreen } = await import('./ErpLinkScreen');
const { ErpSettings } = await import('./ErpSettings');
const { RecordLinkError } = await import('./host');
const { ErpSessions } = await import('../session');
const { FakeConnection, FakeErp, LINK, OTHER_LINK, TICKET, button, click, hasButton, text, until } =
  await import('./testing');

const E = en.erp;
const REDEEMED: LinkRedeemResponse = {
  linkId: 'erp-link-kit',
  company: 'Kit',
  companyName: 'Kit Trading',
};
const WORKSPACES = [
  { id: 'ws-1', name: 'Finance' },
  { id: 'ws-2', name: 'Sales' },
];

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function render(node: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n: createErpI18n('en') }, node));
  });
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

function linkHost(over: Partial<ErpLinkScreenHost> = {}) {
  let ticket: string | null = TICKET;
  const host = {
    get ticket() {
      return ticket;
    },
    signedIn: true,
    online: true,
    signIn: vi.fn(),
    workspaces: WORKSPACES,
    redeem: vi.fn(async () => REDEEMED),
    record: vi.fn(async (): Promise<'created' | 'exists'> => 'created'),
    forgetTicket: vi.fn(() => {
      ticket = null;
    }),
    openSettings: vi.fn(),
    close: vi.fn(),
    ...over,
  };
  return host;
}

describe('the link screen', { timeout: 30_000 }, () => {
  it('links the chosen workspace: Redeem at the ERP once, then Workspace records it', async () => {
    const host = linkHost();
    const container = await render(createElement(ErpLinkScreen, { host }));
    expect(text(container)).toContain(E.linkTitle);
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    await click(radios[1]!);
    await click(button(container, E.linkConfirm));
    await until(() => !!container.querySelector('[data-testid="erp-link-done"]'), 'done');
    expect(host.forgetTicket).toHaveBeenCalledTimes(1);
    expect(host.redeem).toHaveBeenCalledWith(TICKET, WORKSPACES[1]);
    expect(host.record).toHaveBeenCalledWith(WORKSPACES[1], REDEEMED);
    expect(text(container)).toContain('Kit Trading is now linked to Sales.');
    await click(button(container, E.linkOpenSettings));
    expect(host.openSettings).toHaveBeenCalledWith('ws-2');
  });

  it('says what went wrong at the ERP, and never sends the ticket again', async () => {
    const host = linkHost({
      redeem: vi.fn(async () => {
        throw new ErpError('ticket.invalid', { status: 401 });
      }),
    });
    const container = await render(createElement(ErpLinkScreen, { host }));
    await click(button(container, E.linkConfirm));
    await until(() => text(container).includes(E.linkExpired), 'expired');
    expect(host.forgetTicket).toHaveBeenCalled();
    expect(host.record).not.toHaveBeenCalled();
    expect(hasButton(container, E.linkConfirm)).toBe(false);
    expect(hasButton(container, E.retry)).toBe(false);
  });

  it('retries only the record when Workspace could not keep it, and says when it was there', async () => {
    let attempt = 0;
    const host = linkHost({
      record: vi.fn(async (): Promise<'created' | 'exists'> => {
        if (attempt++ === 0) throw new RecordLinkError('failed');
        return 'exists';
      }),
    });
    const container = await render(createElement(ErpLinkScreen, { host }));
    await click(button(container, E.linkConfirm));
    await until(() => text(container).includes(E.linkRecordFailed), 'record failed');
    await click(button(container, E.retry));
    await until(
      () => text(container).includes('Kit Trading was already linked to Finance.'),
      'exists',
    );
    expect(host.redeem).toHaveBeenCalledTimes(1);
    expect(host.record).toHaveBeenCalledTimes(2);
  });

  it('names each state that cannot link', async () => {
    const cases: [Partial<ErpLinkScreenHost>, string][] = [
      [{ signedIn: false }, E.linkSignIn],
      [{ signedIn: undefined }, E.loading],
      [{ online: false }, E.linkOffline],
      [{ workspaces: [] }, E.linkNoWorkspace],
    ];
    for (const [over, expected] of cases) {
      const container = await render(createElement(ErpLinkScreen, { host: linkHost(over) }));
      expect(text(container)).toContain(expected);
      expect(hasButton(container, E.linkConfirm)).toBe(false);
      cleanup?.();
      cleanup = null;
    }
    const gone = linkHost();
    gone.forgetTicket();
    const container = await render(createElement(ErpLinkScreen, { host: gone }));
    expect(text(container)).toContain(E.linkNoTicket);
  });

  it('forgets the ticket when the person cancels', async () => {
    const host = linkHost();
    const container = await render(createElement(ErpLinkScreen, { host }));
    await click(button(container, E.cancel));
    expect(host.forgetTicket).toHaveBeenCalled();
    expect(host.close).toHaveBeenCalled();
    expect(host.redeem).not.toHaveBeenCalled();
  });
});

describe('the settings section', { timeout: 30_000 }, () => {
  function settingsHost(over: Partial<ErpSettingsHost> = {}) {
    const connection = new FakeConnection();
    connection.linksValue = { status: 'ready', links: [LINK, OTHER_LINK] };
    const erp = new FakeErp();
    const sessions = new ErpSessions({
      client: erp.client,
      flow: async () => TICKET,
      target: null,
    });
    const host: ErpSettingsHost = {
      canManage: true,
      connection,
      sessions,
      unlink: vi.fn(async () => undefined),
      openErp: vi.fn(),
      ...over,
    };
    return { host, connection, sessions };
  }

  it('lists the links, the session in this tab, and unlinks after asking', async () => {
    const { host, connection, sessions } = settingsHost();
    // Read when the section shows and the tab has not read them yet.
    connection.linksValue = { status: 'loading' };
    const container = await render(createElement(ErpSettings, { host }));
    expect(connection.loads).toBe(1);
    await act(async () =>
      connection.set({ linksValue: { status: 'ready', links: [LINK, OTHER_LINK] } }),
    );
    const rows = [...container.querySelectorAll('[data-link]')];
    expect(rows.map((row) => row.getAttribute('data-link'))).toEqual([LINK.id, OTHER_LINK.id]);
    expect(text(rows[0]!)).toContain('Kit Trading');
    expect(text(rows[0]!)).toContain('Linked by Dana on');
    expect(text(rows[0]!)).toContain(E.notConnectedHere);

    await act(async () => {
      await sessions.connect(LINK);
    });
    expect(text(container.querySelector(`[data-link="${LINK.id}"]`)!)).toContain(
      'Connected in this tab as Alice Haddad',
    );
    await click(button(container, 'Disconnect from Kit Trading'));
    expect(sessions.state(LINK.id)).toBe('none');

    await click(button(container, 'Unlink Kit Trading'));
    expect(text(container)).toContain(E.unlinkConfirm.replace('{{company}}', 'Kit Trading'));
    expect(host.unlink).not.toHaveBeenCalled();
    const confirm = [...container.querySelectorAll('button')].find(
      (b) => text(b) === E.unlink && !b.getAttribute('aria-label'),
    )!;
    await click(confirm);
    expect(host.unlink).toHaveBeenCalledWith(LINK);
    expect(text(container)).toContain(E.howToLink);
    await click(button(container, E.openErp));
    expect(host.openErp).toHaveBeenCalled();
    sessions.dispose();
  });

  it('offers no unlink to a member, and says when there is no link', async () => {
    const { host, connection, sessions } = settingsHost({ canManage: false });
    const container = await render(createElement(ErpSettings, { host }));
    expect(hasButton(container, 'Unlink Kit Trading')).toBe(false);
    await act(async () => connection.set({ linksValue: { status: 'ready', links: [] } }));
    expect(text(container)).toContain(E.settingsNone);
    sessions.dispose();
  });

  it('says so when the unlink is refused', async () => {
    const { host, sessions } = settingsHost({
      unlink: vi.fn(async () => {
        throw new Error('403');
      }),
    });
    const container = await render(createElement(ErpSettings, { host }));
    await click(button(container, 'Unlink Kit Trading'));
    const confirm = [...container.querySelectorAll('button')].find(
      (b) => text(b) === E.unlink && !b.getAttribute('aria-label'),
    )!;
    await click(confirm);
    await until(() => text(container).includes(E.unlinkFailed), 'the refusal');
    sessions.dispose();
  });
});
