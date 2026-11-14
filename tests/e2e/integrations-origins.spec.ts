// Phase 5: "Neither integration can be driven from a page on an origin that is not on the
// allow-list" (IMPLEMENTATION_PLAN.md, Phase 5), in Chrome and Edge, against the server stack and
// the mocks. The foreign page is served by a small server of this spec's own on a free port of
// 127.0.0.1 (not Playwright's `route`: Chrome does not let a fulfilled page frame 127.0.0.1):
//   - it cannot frame Sheet's embed (`frame-ancestors`), and the embed opened as its window does
//     not take its `init`;
//   - Workspace's page, opened by it, ignores its `ready` and `loaded` posing as Sheet (and its own
//     CSP keeps a frame of another origin out of the page), and ignores a `cgw-erp-connect` from
//     any origin but the ERP client's, or from the client's pop-up with another state;
//   - the sheet-session Redeem and both ERP Redeems refuse a foreign `Origin` (and none) before
//     they look at the ticket: the same ticket then works from an allowed origin.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { newPage, waitSaved } from './helpers';
import { API, newAccount, syncStatus } from './cloud';
import { pageId, signedInWorkspace, signers } from './database';
import {
  APP_ORIGIN,
  ERP_API,
  ERP_CLIENT,
  MOCK_SHEET,
  REAL_ERP,
  REAL_SHEET,
  SHEET_ORIGIN,
  connectTicket,
  erpBlock,
  insertErpBlock,
  insertExistingWorkbook,
  launchTicket,
  linkTicket,
  linkWorkspace,
  mockErp,
  mockSheet,
  newWorkbook,
  sessionOf,
  sheetBlock,
  sheetSession,
  watchAppErrors,
  workbookOf,
  workspaceIdOf,
} from './ecosystem';

test.skip(desktop, 'Pages on other origins are browser pages');

const cloud = signers();
test.afterEach(() => cloud.close());

let server: Server;
let foreign = '';
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://foreign');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (url.pathname === '/frame')
      return res.end(
        `<!doctype html><title>Another site</title><iframe id="embed" title="Sheet" src="${SHEET_ORIGIN}/embed"></iframe>`,
      );
    res.end('<!doctype html><title>Another site</title><p>A page on another origin.</p>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  foreign = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/** A source the mock embed can read (its own fixture, ACAO *), as the foreign page's `init`. */
const INIT = {
  type: 'init',
  contract: 'sheet-embed.1',
  source: {
    kind: 'url',
    url: `${MOCK_SHEET}/__mock/fixture/budget.xlsx`,
    etag: '"foreign-0001"',
  },
  view: { kind: 'range', sheet: null, range: null },
  theme: 'light',
  direction: 'ltr',
  locale: 'en',
};

/** Opens `url` from the foreign page as a window it holds (`window.held`); that window's page. */
async function openFromForeign(foreignPage: Page, url: string) {
  const opened = foreignPage.waitForEvent('popup');
  await foreignPage.evaluate((url) => {
    (window as unknown as { held: Window | null }).held = window.open(url, 'held');
  }, url);
  const held = await opened;
  await held.waitForLoadState('domcontentloaded');
  return held;
}

test('a page on another origin cannot frame the embed, nor make the embed take its init', async ({
  page,
}) => {
  test.skip(REAL_SHEET, "The mock's own record of what its embed did is the evidence here");
  await mockSheet.reset();
  // Framed: refused by the embed's frame-ancestors, so its script never runs.
  await page.goto(`${foreign}/frame`);
  await page.waitForTimeout(2000);
  const child = page.frames().find((f) => f !== page.mainFrame());
  expect(child, 'the frame element is there').toBeTruthy();
  const ran = await child!
    .evaluate(() => document.getElementById('status')?.getAttribute('data-state') ?? null)
    .catch(() => null);
  expect(ran, 'the embed did not run in the foreign frame').toBeNull();
  expect((await mockSheet.state()).events.filter((e) => e.page === 'embed')).toEqual([]);

  // Its own window: the embed runs (it reports `ready`), but an `init` from its opener on another
  // origin is not from its parent, nor from an origin on its list: never taken, never answered.
  const embed = await openFromForeign(page, `${SHEET_ORIGIN}/embed`);
  await expect(embed.locator('#status')).toHaveAttribute('data-state', 'waiting');
  const answered = await page.evaluate(
    (init) =>
      new Promise<number>((done) => {
        const channel = new MessageChannel();
        let answers = 0;
        channel.port1.onmessage = () => answers++;
        (window as unknown as { held: Window }).held.postMessage(init, '*', [channel.port2]);
        setTimeout(() => done(answers), 3000);
      }),
    INIT,
  );
  expect(answered).toBe(0);
  await expect(embed.locator('#status')).toHaveAttribute('data-state', 'waiting');
  const events = (await mockSheet.state()).events.filter((e) => e.page === 'embed');
  expect(events.map((e) => e.kind)).toEqual(['ready']);
  await embed.close();
});

test("Workspace's page ignores a window on another origin posing as Sheet, and frames no other origin", async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  const account = await newAccount('Posed');
  await signedInWorkspace(page, account, 'Posed space', null, cloud.signer);
  const api = await sessionOf(account);
  try {
    const workspaceId = await workspaceIdOf(api, 'Posed space');
    await newWorkbook(api, workspaceId, 'Real book', workbookOf([['Real'], [1]]));
    await newPage(page, 'Posed page');
    await insertExistingWorkbook(page, 'Real book');
    await expect(sheetBlock(page)).toHaveAttribute('data-state', 'loaded', { timeout: 30000 });
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const id = pageId(page);

    // Sheet does not answer this time (its embed's address refused), so the block waits for a
    // `ready` that only Sheet's frame may send. The foreign page opens Workspace and sends its own.
    await context.route(`${SHEET_ORIGIN}/embed`, (route) => route.abort());
    const foreignPage = await context.newPage();
    await foreignPage.goto(`${foreign}/`);
    const workspace = await openFromForeign(foreignPage, `${APP_ORIGIN}/#/p/${id}`);
    const errors = watchAppErrors(workspace, [/ERR_FAILED|ERR_BLOCKED/]);
    const block = sheetBlock(workspace);
    await expect(block).toHaveAttribute('data-state', 'connecting', { timeout: 30000 });
    const answers = await foreignPage.evaluate(
      async ({ loaded, ready }) => {
        const held = (window as unknown as { held: Window }).held;
        const channel = new MessageChannel();
        let heard = 0;
        channel.port1.onmessage = () => heard++;
        held.postMessage(ready, '*', [channel.port2]);
        held.postMessage(loaded, '*');
        // As if Workspace had taken the port: what a real embed would send next.
        channel.port1.postMessage(loaded);
        await new Promise((r) => setTimeout(r, 3000));
        return heard;
      },
      {
        ready: { type: 'ready', contracts: ['sheet-embed.1'] },
        loaded: {
          type: 'loaded',
          etag: '"posing-0001"',
          view: { kind: 'range', sheet: 'Sheet1', range: 'A1' },
          sheets: [{ name: 'Sheet1', direction: 'ltr' }],
          charts: [],
          size: { width: 200, height: 40 },
          capped: false,
        },
      },
    );
    expect(answers, 'Workspace sent the posing window nothing (no init)').toBe(0);
    await expect(block).toHaveAttribute('data-state', 'connecting');
    await expect(block.locator('.cgw-sheet-live[data-shown]')).toHaveCount(0);
    // With no `ready` from Sheet's own frame, the block gives up as Sheet being unavailable.
    await expect(block).toHaveAttribute('data-state', 'error:source.unavailable', {
      timeout: 30000,
    });
    await expect(block).toContainText("Couldn't load the live view.");

    // A frame of another origin is not even loaded into Workspace's page (frame-src).
    const violated = await workspace.evaluate(
      (src) =>
        new Promise<string>((done) => {
          document.addEventListener('securitypolicyviolation', (e) => done(e.violatedDirective), {
            once: true,
          });
          const frame = document.createElement('iframe');
          frame.src = src;
          document.body.append(frame);
          setTimeout(() => done('none'), 5000);
        }),
      `${foreign}/`,
    );
    expect(violated).toBe('frame-src');
    await context.unroute(`${SHEET_ORIGIN}/embed`);
    expect(errors.filter((e) => !/Content Security Policy|frame-src/.test(e))).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test("the ERP connect takes its ticket only from the ERP client's pop-up, with its own state", async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  if (!REAL_ERP) await mockErp.reset();
  const account = await newAccount('Connector');
  await signedInWorkspace(page, account, 'Connect space', null, cloud.signer);
  const api = await sessionOf(account);
  try {
    const workspaceId = await workspaceIdOf(api, 'Connect space');
    const link = await linkWorkspace(api, workspaceId, 'Connect space');
    await newPage(page, 'Connect page');
    await insertErpBlock(page);
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const id = pageId(page);

    // Workspace opened by the foreign page, which so holds its window.
    const foreignPage = await context.newPage();
    await foreignPage.goto(`${foreign}/`);
    const workspace = await openFromForeign(foreignPage, `${APP_ORIGIN}/#/p/${id}`);
    const block = erpBlock(workspace);
    const opened = workspace.waitForEvent('popup');
    await block.getByRole('button', { name: 'Connect to Cash Gear ERP' }).click();
    const popup = await opened;
    await popup.waitForLoadState('domcontentloaded');
    expect(new URL(popup.url()).origin).toBe(ERP_CLIENT);
    const params = new URL(popup.url()).searchParams;
    const state = params.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await expect(block.getByTestId('erp-connecting')).toBeVisible();

    // A good ticket with the right state, from the foreign page: ignored.
    const stolen = await connectTicket('carol', workspaceId, link.erpLinkId);
    await foreignPage.evaluate(
      ([ticket, state]) =>
        (window as unknown as { held: Window }).held.postMessage(
          { type: 'cgw-erp-connect', ticket, state },
          '*',
        ),
      [stolen, state],
    );
    await workspace.waitForTimeout(1500);
    await expect(block.getByTestId('erp-connecting')).toBeVisible();
    // From the ERP client's own pop-up, but with another state: ignored too.
    const wrong = await connectTicket('carol', workspaceId, link.erpLinkId);
    await popup.evaluate(
      ([ticket, origin]) =>
        window.opener.postMessage(
          { type: 'cgw-erp-connect', ticket, state: 'A'.repeat(22) },
          origin,
        ),
      [wrong, APP_ORIGIN],
    );
    await workspace.waitForTimeout(1500);
    await expect(block.getByTestId('erp-connecting')).toBeVisible();
    if (!REAL_ERP)
      expect((await mockErp.state()).sessions, 'no session was opened with either ticket').toEqual(
        [],
      );

    // The person connects in the pop-up: that ticket, and only it, is redeemed.
    const closed = popup.waitForEvent('close');
    if (REAL_ERP) {
      const ticket = await connectTicket('alice', workspaceId, link.erpLinkId);
      await popup.evaluate(
        ([ticket, state, origin]) => {
          window.opener.postMessage({ type: 'cgw-erp-connect', ticket, state }, origin);
          window.close();
        },
        [ticket, state, APP_ORIGIN],
      );
    } else {
      await popup.locator('#user').selectOption('alice');
      await popup.locator('#connect').click();
    }
    await closed;
    await expect(block.getByTestId('erp-choose')).toBeVisible({ timeout: 30000 });
    if (!REAL_ERP) {
      const sessions = (await mockErp.state()).sessions;
      expect(sessions.map((s) => s.user)).toEqual(['alice']);
    }
  } finally {
    await api.dispose();
  }
});

test('the sheet-session and ERP Redeems refuse another origin before they read the ticket', async ({
  page,
}) => {
  test.setTimeout(180000);
  if (!REAL_ERP) await mockErp.reset();
  const account = await newAccount('Redeemer');
  await signedInWorkspace(page, account, 'Redeem space', null, cloud.signer);
  const api = await sessionOf(account);
  await page.goto(`${foreign}/`);
  /** A POST the foreign page can send without a preflight; its answer is opaque to it. */
  const fromForeignPage = (url: string, body: unknown) =>
    page.evaluate(
      async ([url, body]) => {
        await fetch(url as string, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(body),
        }).catch(() => undefined);
      },
      [url, body],
    );
  const post = (url: string, body: unknown, origin?: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });
  const codeOf = async (response: Response) => {
    const body = (await response.json()) as { code?: string; errors?: { code: string }[] };
    return body.code ?? body.errors?.[0]?.code;
  };
  try {
    const workspaceId = await workspaceIdOf(api, 'Redeem space');

    // sheet-session.1's Redeem (Workspace's server).
    const workbookId = await newWorkbook(api, workspaceId, 'Guarded', workbookOf([['x']]));
    const { ticket } = await launchTicket(api, workbookId);
    const redeem = `${API}/api/v1/sheet-sessions/redeem`;
    for (const origin of [foreign, undefined, 'https://sheet.cashgearerp.com.evil.test']) {
      const refused = await post(redeem, { ticket }, origin);
      expect(refused.status, `Origin ${origin ?? '(none)'}`).toBe(403);
      expect(await codeOf(refused)).toBe('origin.denied');
    }
    await fromForeignPage(redeem, { ticket });
    const taken = await sheetSession('/redeem', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(taken.status).toBe(200);
    const { token } = (await taken.json()) as { token: string };
    // Once only.
    const again = await sheetSession('/redeem', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(again.status).toBe(401);
    expect(await codeOf(again)).toBe('ticket.invalid');
    await sheetSession('/end', { headers: { 'X-Workspace-File-Session': token } });

    // erp-connect.1's link Redeem and session Redeem (the ERP).
    const link = await linkTicket();
    const linkRedeem = `${ERP_API}/api/system/WorkspaceLink/Redeem`;
    const linkBody = { ticket: link, workspaceId, workspaceName: 'Redeem space' };
    for (const origin of [foreign, undefined]) {
      const refused = await post(linkRedeem, linkBody, origin);
      expect(refused.status, `Origin ${origin ?? '(none)'}`).toBe(403);
      expect(await codeOf(refused)).toBe('origin.denied');
    }
    await fromForeignPage(linkRedeem, linkBody);
    const linked = await post(linkRedeem, linkBody, APP_ORIGIN);
    expect(linked.status).toBe(200);
    const erpLink = (await linked.json()) as { linkId: string };
    const connect = await connectTicket('alice', workspaceId, erpLink.linkId);
    const sessionRedeem = `${ERP_API}/api/connect/Session/Redeem`;
    const sessionBody = { ticket: connect, workspaceId };
    for (const origin of [foreign, undefined]) {
      const refused = await post(sessionRedeem, sessionBody, origin);
      expect(refused.status, `Origin ${origin ?? '(none)'}`).toBe(403);
      expect(await codeOf(refused)).toBe('origin.denied');
    }
    await fromForeignPage(sessionRedeem, sessionBody);
    const session = await post(sessionRedeem, sessionBody, APP_ORIGIN);
    expect(session.status).toBe(200);
    const opened = (await session.json()) as { token: string; linkId: string };
    expect(opened.linkId).toBe(erpLink.linkId);
    await fetch(`${ERP_API}/api/connect/Session/End`, {
      method: 'POST',
      headers: { 'X-Connect-Session': opened.token, Origin: APP_ORIGIN },
    });
  } finally {
    await api.dispose();
  }
});
