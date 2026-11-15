// Phase 7: the warning before ERP changes are left behind. Moving to another route asks first and
// the app keeps showing the page meanwhile; staying puts the address back, leaving forgets the
// page's drafts; the browser asks before the tab closes; the desktop asks before its window does.
import { afterEach, describe, expect, it } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
Object.assign(globalThis, {
  location: window.location,
  history: window.history,
  EventTarget: window.EventTarget,
});
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ErpDrafts } = await import('@cgw/erp');
const { createErpI18n } = await import('@cgw/erp/view');
const { en } = await import('@cgw/erp/i18n');
const { useHash } = await import('../route');
const { installErpLeaveGuard } = await import('./leave');

const PAGE = '01930000-0000-7000-8000-0000000000bb';
const OTHER = '01930000-0000-7000-8000-0000000000cc';
const E = en.erp;
const RECORD = { id: 'r1', key: 'V-1', version: 'AAAAAAAAAAE=', values: { vendorName: 'Old' } };

const settle = () => act(() => new Promise((done) => setTimeout(done, 10)));
const dialog = () => document.querySelector('[role="alertdialog"]');
const buttonIn = (el: Element, label: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === label)!;

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

async function setup() {
  history.replaceState(null, '', `#/p/${PAGE}`);
  const drafts = new ErpDrafts();
  let asker: (() => Promise<boolean>) | null = null;
  const off = installErpLeaveGuard(drafts, createErpI18n('en'), {
    onCloseAsk: (ask) => {
      asker = ask;
      return () => void (asker = null);
    },
  });
  const shown: string[] = [];
  function Probe() {
    const hash = useHash();
    shown.push(hash);
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(h(Probe)));
  cleanup.push(() => {
    act(() => root.unmount());
    container.remove();
    off();
  });
  const draft = drafts.get(ErpDrafts.key(PAGE, 'Blk000000001'), {
    linkId: 'l',
    connectorId: 'vendors',
    source: { workspaceId: 'w', pageId: PAGE, blockId: 'Blk000000001' },
  });
  return { drafts, draft, shown, asker: () => asker };
}

describe('leaving ERP changes behind', () => {
  it('moves freely without changes, and asks with them, keeping the page shown', async () => {
    const { drafts, draft, shown } = await setup();
    location.hash = `#/p/${OTHER}`;
    await settle();
    expect(shown.at(-1)).toBe(`#/p/${OTHER}`);
    expect(dialog()).toBeNull();

    history.replaceState(null, '', `#/p/${PAGE}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await settle();
    draft.set(RECORD, 'vendorName', 'New');
    // A link to a block of the same page is no leaving.
    location.hash = `#/p/${PAGE}/Blk000000001`;
    await settle();
    expect(dialog()).toBeNull();

    location.hash = '#/trash';
    await settle();
    expect(dialog()!.textContent).toContain(E.leaveText);
    expect(shown.at(-1)).toBe(`#/p/${PAGE}/Blk000000001`);
    await act(async () => buttonIn(dialog()!, E.leaveStay).click());
    await settle();
    expect(location.hash).toBe(`#/p/${PAGE}/Blk000000001`);
    expect(drafts.pendingOn(PAGE)).toBe(true);

    location.hash = '#/trash';
    await settle();
    await act(async () => buttonIn(dialog()!, E.leaveGo).click());
    await settle();
    expect(shown.at(-1)).toBe('#/trash');
    expect(drafts.pendingOn(PAGE)).toBe(false);
  });

  it('has the browser ask before the tab goes, only with changes', async () => {
    const { draft } = await setup();
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    draft.set(RECORD, 'vendorName', 'New');
    expect(unload()).toBe(true);
  });

  it('has the desktop ask before its window closes, only with changes', async () => {
    const { draft, asker } = await setup();
    expect(await asker()!()).toBe(true);
    draft.set(RECORD, 'vendorName', 'New');
    const answer = asker()!();
    await settle();
    await act(async () => buttonIn(dialog()!, E.leaveStay).click());
    expect(await answer).toBe(false);
    const again = asker()!();
    await settle();
    await act(async () => buttonIn(dialog()!, E.leaveGo).click());
    expect(await again).toBe(true);
    expect(draft.pending()).toBe(false);
  });
});
