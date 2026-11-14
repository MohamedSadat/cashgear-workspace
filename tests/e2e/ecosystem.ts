// Phase 5's helpers for the Sheet and ERP specs: the mocks' controls (tests/mocks), workbooks made
// and saved through the API as Sheet saves them (a launch ticket redeemed from Sheet's origin, then
// sheet-session.1's save), the blocks driven as a person drives them (the slash menu, the picker,
// the ERP pop-up), links made the way the link screen makes them, and what a device and the server
// hold, read in full for the "nothing stored" checks.
//
// The real systems (tests/e2e/README.md): CGW_E2E_REAL_SHEET points the specs at Sheet's preview
// (http://127.0.0.1:4173, a web build made with VITE_CGW_SHEET for it) and CGW_E2E_REAL_ERP at
// UnifiedAPI and the ERP client (http://localhost:5299 and :4285, a web build made with
// VITE_CGW_ERP_API and VITE_CGW_ERP_CLIENT for them). The parts that need a mock's controls skip.
import { expect, type Locator, type Page } from '@playwright/test';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { XLSX_TYPE, writeXlsx } from '../mocks/sheet/xlsx.mjs';
import { API, mailTo, type TestAccount } from './cloud';
import { editor } from './helpers';

export type Api = Awaited<ReturnType<typeof apiSession>>;

/** This build's origin in the browser specs (vite preview). */
export const APP_ORIGIN = 'http://127.0.0.1:4273';

export const REAL_SHEET = !!process.env.CGW_E2E_REAL_SHEET;
export const REAL_ERP = !!process.env.CGW_E2E_REAL_ERP;
/** The mock Sheet (always started by Playwright, used for its controls). */
export const MOCK_SHEET = 'http://127.0.0.1:4283';
/** The Sheet origin this build frames and launches. */
export const SHEET_ORIGIN =
  process.env.CGW_E2E_SHEET_ORIGIN ?? (REAL_SHEET ? 'http://127.0.0.1:4173' : MOCK_SHEET);
/** Cash Gear ERP's API and client for this build. */
export const ERP_API =
  process.env.CGW_E2E_ERP_API ?? (REAL_ERP ? 'http://localhost:5299' : 'http://127.0.0.1:4282');
export const ERP_CLIENT =
  process.env.CGW_E2E_ERP_CLIENT ?? (REAL_ERP ? 'http://localhost:4285' : 'http://127.0.0.1:4284');

/**
 * The ERP users the specs act as, by role: the mock's own names, or with CGW_E2E_REAL_ERP the
 * seeded LocalDB keys (CGW_E2E_ERP_KEYS, JSON, overrides them).
 */
const REAL_KEYS: Record<ErpUser, string> = {
  alice: 'ws-test-kit-viewer',
  bob: 'ws-test-kit-limited',
  carol: 'ws-test-kit-none',
  dan: 'ws-test-kit-admin',
};
export type ErpUser = 'alice' | 'bob' | 'carol' | 'dan';
const erpKeys: Record<ErpUser, string> = {
  ...REAL_KEYS,
  ...(process.env.CGW_E2E_ERP_KEYS ? JSON.parse(process.env.CGW_E2E_ERP_KEYS) : {}),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The browser's line for a view's picture the server does not have yet: `GET …/previews/{hash}`
 * answers 404 by design (the block then asks the embed for one), and browsers log every 4xx.
 */
export const NO_PICTURE_YET =
  /status of 404 .* https?:\/\/[^ /]+\/api\/v1\/workbooks\/[0-9a-f-]{36}\/previews\/[0-9a-f]{64}$/;

/**
 * Page errors and console errors, each with the address it came from, less the lines `allowed`
 * names (helpers.ts's `watchErrors`, which has no address to tell an expected 404 by).
 */
export function watchAppErrors(page: Page, allowed: RegExp[] = [NO_PICTURE_YET]): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const line = `${message.text()} ${message.location().url ?? ''}`.trim();
    if (!allowed.some((a) => a.test(line))) errors.push(line);
  });
  return errors;
}
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------------------- the mocks
async function control(base: string, path: string, body?: unknown) {
  const response = await fetch(`${base}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${base}/__mock/${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export interface SheetMockEvent {
  page: string;
  kind: string;
  [key: string]: unknown;
}

/** The mock Sheet's controls. */
export const mockSheet = {
  reset: () => control(MOCK_SHEET, 'reset', {}),
  fault: (fault: { code: string; times?: number; on?: string }) =>
    control(MOCK_SHEET, 'fault', fault),
  state: async () => (await control(MOCK_SHEET, 'state')) as { events: SheetMockEvent[] },
};

export interface ErpMockState {
  markers: Record<string, string[]>;
  records: Record<
    string,
    { company: string; id: string; key: string; values: Record<string, unknown> }[]
  >;
  sessions: { user: string; linkId: string; live: boolean; ended: boolean }[];
  links: { linkId: string; workspaceId: string; revokedAt: string | null }[];
}

/** The mock ERP's controls (on its API). */
export const mockErp = {
  reset: () => control(ERP_API, 'reset', {}),
  state: async () => (await control(ERP_API, 'state')) as ErpMockState,
  clock: (advanceMs: number) => control(ERP_API, 'clock', { advanceMs }),
  fault: (fault: Record<string, unknown>) => control(ERP_API, 'fault', fault),
  clearFaults: () => control(ERP_API, 'fault', { clear: true }),
  revokeLink: (linkId: string) => control(ERP_API, 'revoke-link', { linkId }),
  linkTicket: async (user: ErpUser) =>
    (await control(ERP_API, 'link-ticket', { user })) as { ticket: string; url: string },
  connectTicket: async (user: ErpUser, workspaceId: string, linkId: string) =>
    (
      (await control(ERP_API, 'connect-ticket', { user, workspaceId, linkId })) as {
        ticket: string;
      }
    ).ticket,
};

/** Every distinctive value the mock ERP holds: its made-up words, in both companies. */
export async function erpMarkers(): Promise<string[]> {
  if (REAL_ERP) {
    const named = (process.env.CGW_E2E_ERP_MARKERS ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 3);
    if (!named.length)
      throw new Error(
        'CGW_E2E_REAL_ERP needs CGW_E2E_ERP_MARKERS: distinctive values the seeded tenant holds',
      );
    return named;
  }
  const state = await mockErp.state();
  return Object.values(state.markers).flat();
}

// ------------------------------------------------------------------------------- the API
/** A signed-in API session for an account (scripts/cloud-account.mjs). */
export const sessionOf = (account: TestAccount) => apiSession(account);

export async function workspaceIdOf(api: Api, name: string): Promise<string> {
  const all = (await api.get('/api/v1/workspaces')) as { id: string; name: string }[];
  const found = all.find((w) => w.name === name);
  if (!found) throw new Error(`No workspace ${name}`);
  return found.id;
}

/** A workbook made through the API (no version until one is saved). */
export async function newWorkbook(api: Api, workspaceId: string, name: string, book?: Uint8Array) {
  const made = (await api.post(`/api/v1/workspaces/${workspaceId}/workbooks`, {
    id: null,
    name,
  })) as { id: string };
  if (book) await saveVersion(api, made.id, book);
  return made.id;
}

/** Workbook bytes: one sheet of rows (the mock's writer, as Sheet's files are read). */
export const workbookOf = (rows: (string | number | boolean)[][], name = 'Sheet1') =>
  writeXlsx({ sheets: [{ name, rows }] }) as Uint8Array;

/** A budget with an English sheet, a right-to-left Arabic one and a hidden one. */
export const budgetBook = () =>
  writeXlsx({
    sheets: [
      {
        name: 'Budget',
        rows: [
          ['Item', 'Q1', 'Q2', 'Approved'],
          ['Rent', 1200, 1250, true],
          ['Travel', 300.5, 280, false],
          ['Software', 99, 120, true],
        ],
      },
      {
        name: 'الميزانية',
        rtl: true,
        rows: [
          ['البند', 'الربع الأول'],
          ['الإيجار', 1200],
        ],
      },
      { name: 'Hidden notes', state: 'hidden', rows: [['Not listed']] },
    ],
  }) as Uint8Array;

/** A one-time launch ticket, as "Open in Cash Gear Sheet" asks for one. */
export async function launchTicket(api: Api, workbookId: string) {
  const { url } = (await api.post(`/api/v1/workbooks/${workbookId}/launch`)) as { url: string };
  const ticket = /#launch=([A-Za-z0-9_-]{43})$/.exec(url)?.[1];
  if (!ticket) throw new Error(`No ticket in ${url}`);
  return { url, ticket };
}

/** sheet-session.1 from Sheet's origin (the mock's, on the server's list in every stack). */
export const sheetSession = (path: string, init: RequestInit & { origin?: string } = {}) =>
  fetch(`${API}/api/v1/sheet-sessions${path}`, {
    method: 'POST',
    redirect: 'error',
    ...init,
    headers: { Origin: init.origin ?? MOCK_SHEET, ...(init.headers as Record<string, string>) },
  });

/** A new version saved as Sheet saves one: a session from a launch ticket, If-Match/If-None-Match. */
export async function saveVersion(api: Api, workbookId: string, bytes: Uint8Array) {
  const { ticket } = await launchTicket(api, workbookId);
  const redeemed = await sheetSession('/redeem', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  expect(redeemed.status).toBe(200);
  const { token } = (await redeemed.json()) as { token: string };
  const session = { 'X-Workspace-File-Session': token };
  const current = (await (
    await sheetSession('/workbook', { method: 'GET', headers: session })
  ).json()) as { etag: string | null };
  const saved = await sheetSession('/workbook/versions', {
    headers: {
      ...session,
      'Content-Type': XLSX_TYPE,
      ...(current.etag ? { 'If-Match': current.etag } : { 'If-None-Match': '*' }),
    },
    body: bytes,
  });
  expect(saved.status).toBe(201);
  const version = (await saved.json()) as { versionId: string; etag: string };
  await sheetSession('/end', { headers: session });
  return version;
}

/** A member of the workspace by invitation (accepted through the API). */
export async function invite(owner: Api, workspaceId: string, account: TestAccount) {
  await owner.post(`/api/v1/workspaces/${workspaceId}/invites`, {
    email: account.email,
    role: 'member',
  });
  const token = /\/#\/invite\/([A-Za-z0-9_-]+)/.exec(await mailTo(account.email, '/#/invite/'));
  if (!token) throw new Error(`No invitation link in the mail to ${account.email}`);
  const api = await sessionOf(account);
  await api.post('/api/v1/invites/accept', { token: token[1] });
  return api;
}

// ------------------------------------------------------------------------------- the sheet block
export const sheetBlock = (page: Page, nth = 0) => editor(page).locator('.cgw-sheet').nth(nth);
/** The live embed's document (the mock Sheet's table). */
export const liveFrame = (block: Locator) => block.frameLocator('.cgw-sheet-live iframe');

/** A new workbook from the slash menu's "Workbook", named in its dialog; its id. */
export async function insertNewWorkbook(page: Page, name: string): Promise<string> {
  await page.keyboard.type('/workbook');
  await page.getByRole('option', { name: /^Workbook/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New workbook' });
  await dialog.getByLabel('Name').fill(name);
  const made = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/workspaces\/[^/]+\/workbooks$/.test(r.url()),
  );
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const answer = await made;
  expect(answer.status()).toBe(201);
  await expect(dialog).toHaveCount(0);
  return ((await answer.json()) as { id: string }).id;
}

/** The attributes of the page's blocks of a type, from the editor's own document. */
export const blockAttrs = (page: Page, type: string) =>
  page.evaluate((type) => {
    interface Node {
      type: string;
      attrs?: Record<string, unknown>;
      content?: Node[];
    }
    const view = document.querySelector('.cgw-page .ProseMirror') as
      (Element & { editor?: { getJSON(): Node } }) | null;
    const out: Record<string, unknown>[] = [];
    const walk = (node: Node) => {
      if (node.type === type) out.push(node.attrs ?? {});
      node.content?.forEach(walk);
    };
    if (view?.editor) walk(view.editor.getJSON());
    return out;
  }, type);

/** A workbook that exists, from the slash menu's "Existing workbook", found by its name. */
export async function insertExistingWorkbook(page: Page, name: string) {
  await page.keyboard.type('/existing');
  await page.getByRole('option', { name: /^Existing workbook/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a workbook' });
  await dialog.getByRole('combobox').fill(name);
  await dialog.getByRole('option', { name: new RegExp(escapeRegExp(name)) }).click();
  await expect(dialog).toHaveCount(0);
}

/** The block's live view drawn: `loaded`, the frame shown with a cell holding `text`. */
export async function expectLive(block: Locator, text?: string) {
  await expect(block).toHaveAttribute('data-state', 'loaded', { timeout: 30000 });
  await expect(block.locator('.cgw-sheet-live[data-shown] iframe')).toBeVisible();
  if (text !== undefined && !REAL_SHEET)
    await expect(liveFrame(block).locator('td', { hasText: text }).first()).toBeVisible();
}

/** The next picture an editor sends for a workbook (`PUT …/previews/{viewHash}`). */
export const pictureSent = (page: Page, workbookId: string) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      r.url().includes(`/api/v1/workbooks/${workbookId}/previews/`),
    { timeout: 30000 },
  );

// ------------------------------------------------------------------------------- the ERP block
export const erpBlock = (page: Page, nth = 0) => editor(page).getByTestId('erp-view').nth(nth);

/** An empty ERP view block from the slash menu's "ERP data". */
export async function insertErpBlock(page: Page) {
  await page.keyboard.type('/erp');
  await page.getByRole('option', { name: /^ERP data/ }).click();
  await expect(erpBlock(page)).toBeVisible();
}

/**
 * A link between a workspace and the ERP's company, made as the link screen makes it: a link
 * ticket an ERP admin made, redeemed at the ERP from Workspace's origin, then recorded through
 * Workspace's `POST /erp-links`. Returns Workspace's link id and the ERP's.
 */
export async function linkWorkspace(api: Api, workspaceId: string, workspaceName: string) {
  const ticket = await linkTicket();
  const redeemed = await fetch(`${ERP_API}/api/system/WorkspaceLink/Redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({ ticket, workspaceId, workspaceName }),
  });
  expect(redeemed.status).toBe(200);
  const erp = (await redeemed.json()) as { linkId: string; company: string; companyName: string };
  const link = (await api.post(`/api/v1/workspaces/${workspaceId}/erp-links`, {
    erpLinkId: erp.linkId,
    erpBaseUrl: ERP_API,
    company: erp.company,
    companyName: erp.companyName,
  })) as { id: string };
  return { linkId: link.id, erpLinkId: erp.linkId, companyName: erp.companyName };
}

/** A link ticket an ERP admin made ("Link Cash Gear Workspace" in the ERP client). */
export async function linkTicket(): Promise<string> {
  if (!REAL_ERP) return (await mockErp.linkTicket('dan')).ticket;
  const made = await fetch(`${ERP_API}/api/system/WorkspaceLink/CreateTicket`, {
    method: 'POST',
    headers: { 'X-API-Key': erpKeys.dan },
  });
  expect(made.status).toBe(200);
  return /\/erp-link\/([A-Za-z0-9_-]{43})/.exec(((await made.json()) as { url: string }).url)![1];
}

/** A connect ticket for an ERP user, as the client's connect page makes one. */
export async function connectTicket(user: ErpUser, workspaceId: string, erpLinkId: string) {
  if (!REAL_ERP) return mockErp.connectTicket(user, workspaceId, erpLinkId);
  const made = await fetch(`${ERP_API}/api/system/WorkspaceConnect/CreateTicket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': erpKeys[user] },
    body: JSON.stringify({ workspaceId, linkId: erpLinkId }),
  });
  expect(made.status).toBe(200);
  return ((await made.json()) as { ticket: string }).ticket;
}

/** The block's Connect (or Connect again), in either language: the button of its message. */
export const connectButton = (block: Locator) =>
  block
    .getByTestId(/^erp-(not-connected|popup-closed|expired|connect-error)$/)
    .getByRole('button')
    .first();

/**
 * Connects the block as an ERP user through the ERP client's pop-up: the person clicks Connect
 * (the pop-up opens inside the click), picks the user on the mock client's page and connects; the
 * page posts the ticket to its opener and closes. With the real client its sign-in is its own: the
 * ticket is made with the user's key and posted from inside the client's page, as the page does.
 */
export async function connectErp(page: Page, block: Locator, user: ErpUser) {
  const opened = page.waitForEvent('popup');
  await connectButton(block).click();
  const popup = await opened;
  await popup.waitForLoadState('domcontentloaded');
  expect(new URL(popup.url()).origin).toBe(ERP_CLIENT);
  const closed = popup.waitForEvent('close', { timeout: 30000 });
  if (REAL_ERP) {
    const params = new URL(popup.url()).searchParams;
    const ticket = await connectTicket(user, params.get('workspace')!, params.get('link')!);
    await popup.evaluate(
      ([ticket, state, origin]) => {
        window.opener.postMessage({ type: 'cgw-erp-connect', ticket, state }, origin);
        window.close();
      },
      [ticket, params.get('state')!, new URL(page.url()).origin],
    );
  } else {
    await popup.locator('#user').selectOption(user);
    await popup.locator('#connect').click();
  }
  await closed;
}

/**
 * The desktop's connect: the app opens the ERP client in the system browser and waits for the
 * `cashgear-workspace://erp#ticket=…&state=…` link to come back. In tests the system browser is
 * stood in for: the opener plugin's call (`plugin:opener|open_url`, which reaches the native side
 * as a fetch to `http://ipc.localhost`) is answered in the window and its URL kept, as
 * CGW_AUTH_URL_FILE keeps the sign-in's; the connect ticket is made for the user as the client's
 * page makes one; and the return reaches the page as the native side hands it on, the `deep-link`
 * event with the link rebuilt from its two values (crates/cgw-native `ErpReturn::link`, emitted by
 * `open_links`). A second start of the app cannot carry it here: with CGW_DATA_DIR the app runs
 * without the single-instance plugin, so a second start would be a second app on the same store.
 */
export async function connectErpDesktop(page: Page, block: Locator, user: ErpUser) {
  await page.evaluate(() => {
    const w = window as unknown as { __cgwOpened?: string[] };
    if (w.__cgwOpened) return;
    w.__cgwOpened = [];
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('http://ipc.localhost/plugin%3Aopener%7Copen_url')) {
        w.__cgwOpened!.push(String(init?.body ?? ''));
        return Promise.resolve(
          new Response('null', {
            headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
          }),
        );
      }
      return original(input, init);
    };
  });
  await connectButton(block).click();
  await expect(block.getByTestId('erp-connecting')).toContainText('Finish in your browser');
  const body = await (
    await page.waitForFunction(
      () => (window as unknown as { __cgwOpened: string[] }).__cgwOpened.at(-1),
      null,
      { timeout: 15000 },
    )
  ).jsonValue();
  const opened = new URL((JSON.parse(body as string) as { url: string }).url);
  expect(opened.origin).toBe(ERP_CLIENT);
  expect(opened.pathname).toBe('/workspace-connect');
  expect(opened.searchParams.get('return')).toBe('desktop');
  const state = opened.searchParams.get('state')!;
  const ticket = await connectTicket(
    user,
    opened.searchParams.get('workspace')!,
    opened.searchParams.get('link')!,
  );
  await page.evaluate(
    (link) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'deep-link', payload: link }),
    `cashgear-workspace://erp#ticket=${ticket}&state=${state}`,
  );
}

/**
 * Everything the desktop's store keeps (crates/cgw-store): `workspace.db` and its WAL as bytes,
 * the asset files beside them, and, from a copy opened with Node's SQLite, every table's rows and
 * the FTS index's own terms (`fts5vocab`: the index stores terms prefix-compressed, so its bytes
 * alone would not show one).
 */
export async function sqliteDump(dataDir: string) {
  const { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const files: { name: string; bytes: Buffer }[] = [];
  for (const name of ['workspace.db', 'workspace.db-wal'])
    if (existsSync(join(dataDir, name)))
      files.push({ name, bytes: readFileSync(join(dataDir, name)) });
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push({ name: path.slice(dataDir.length + 1), bytes: readFileSync(path) });
    }
  };
  walk(join(dataDir, 'assets'));
  const copy = mkdtempSync(join(tmpdir(), 'cgw-store-copy-'));
  try {
    copyFileSync(join(dataDir, 'workspace.db'), join(copy, 'workspace.db'));
    if (existsSync(join(dataDir, 'workspace.db-wal')))
      copyFileSync(join(dataDir, 'workspace.db-wal'), join(copy, 'workspace.db-wal'));
    const db = new DatabaseSync(join(copy, 'workspace.db'));
    const rows: string[] = [];
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r.name));
    for (const table of tables)
      for (const row of db.prepare(`SELECT * FROM "${table}"`).all())
        for (const value of Object.values(row))
          rows.push(
            value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value),
          );
    db.exec("CREATE VIRTUAL TABLE temp.cgw_vocab USING fts5vocab(main, 'search', 'row')");
    const terms = db
      .prepare('SELECT term FROM temp.cgw_vocab')
      .all()
      .map((r) => String(r.term));
    db.close();
    return { files, rows: rows.join('\n'), terms, tables };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** Which of `values` appear in any of the byte buffers (as UTF-8, and ASCII folded). */
export function foundInBytes(files: { name: string; bytes: Buffer }[], values: string[]) {
  const hits: string[] = [];
  for (const { name, bytes } of files)
    for (const value of values) {
      const forms = [value, value.toLowerCase()];
      if (forms.some((form) => bytes.includes(Buffer.from(form, 'utf8'))))
        hits.push(`${value} in ${name}`);
    }
  return hits;
}

/** Picks a connector from the block's list (by its English label). */
export async function chooseConnector(block: Locator, label: string) {
  await block.getByTestId('erp-choose').getByRole('button', { name: label, exact: true }).click();
  await expect(block.getByTestId('erp-table')).toBeVisible({ timeout: 30000 });
}

/** The "Records a–b of n" line. */
export const erpRange = (block: Locator) => block.getByTestId('erp-range');

// ------------------------------------------------------------------------------- what is stored
/**
 * Everything this origin keeps on the device, as text: every IndexedDB database and object store
 * (values and keys; bytes decoded as UTF-8, Blobs read), localStorage, sessionStorage and Cache
 * Storage (every cached response's body).
 */
export async function deviceDump(page: Page): Promise<{ text: string; summary: string[] }> {
  return page.evaluate(async () => {
    const parts: string[] = [];
    const summary: string[] = [];
    const decoder = new TextDecoder('utf-8');
    const pending: Promise<void>[] = [];
    const walk = (value: unknown, depth = 0): void => {
      if (depth > 64 || value === null || value === undefined) return;
      if (typeof value === 'string') return void parts.push(value);
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
        return void parts.push(String(value));
      if (value instanceof ArrayBuffer) return void parts.push(decoder.decode(value));
      if (ArrayBuffer.isView(value))
        return void parts.push(
          decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        );
      if (value instanceof Blob)
        return void pending.push(
          value.arrayBuffer().then((b) => void parts.push(decoder.decode(b))),
        );
      if (value instanceof Date) return void parts.push(value.toISOString());
      if (value instanceof Map) {
        for (const [k, v] of value) {
          walk(k, depth + 1);
          walk(v, depth + 1);
        }
        return;
      }
      if (Array.isArray(value) || value instanceof Set) {
        for (const v of value) walk(v, depth + 1);
        return;
      }
      if (typeof value === 'object')
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          parts.push(k);
          walk(v, depth + 1);
        }
    };
    const request = <T>(r: IDBRequest<T>) =>
      new Promise<T>((done, fail) => {
        r.onsuccess = () => done(r.result);
        r.onerror = () => fail(r.error);
      });
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((done, fail) => {
        const open = indexedDB.open(info.name!);
        open.onsuccess = () => done(open.result);
        open.onerror = () => fail(open.error);
      });
      for (const name of [...db.objectStoreNames]) {
        const store = db.transaction(name, 'readonly').objectStore(name);
        const [values, keys] = await Promise.all([
          request(store.getAll()),
          request(store.getAllKeys()),
        ]);
        walk(values);
        walk(keys);
        summary.push(`idb ${info.name}/${name}: ${values.length}`);
      }
      db.close();
    }
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)!;
        parts.push(key, storage.getItem(key) ?? '');
      }
    }
    summary.push(
      `localStorage: ${localStorage.length}`,
      `sessionStorage: ${sessionStorage.length}`,
    );
    if (typeof caches !== 'undefined')
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        for (const r of requests) {
          parts.push(r.url);
          const response = await cache.match(r);
          if (response) parts.push(decoder.decode(await response.arrayBuffer()));
        }
        summary.push(`cache ${name}: ${requests.length}`);
      }
    await Promise.all(pending);
    return { text: parts.join('\n'), summary };
  });
}

/** Which of `values` appear in `text` (case folded too: search indexes fold ASCII). */
export function found(text: string, values: string[]) {
  const lower = text.toLowerCase();
  return values.filter((v) => text.includes(v) || lower.includes(v.toLowerCase()));
}

/** The text a Yjs update or a version's bytes hold (UTF-8, as Yjs writes strings). */
export const bytesText = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');

/**
 * What the server holds of a page: its derived document (once the worker has `expect` in it), its
 * updates' bytes, and each version's bytes (one made now, as "Save a version" does, waited for).
 */
export async function serverPage(api: Api, pageId: string, expectInDoc: string) {
  let json = '';
  await expect
    .poll(
      async () => {
        const answer = (await api.get(`/api/v1/pages/${pageId}/doc/json`).catch(() => null)) as {
          json: string;
        } | null;
        json = answer?.json ?? '';
        return json.includes(expectInDoc);
      },
      { timeout: 60000 },
    )
    .toBe(true);
  const pull = (await api.get(`/api/v1/pages/${pageId}/doc?after=0`)) as {
    snapshot: string | null;
    updates: { data: string }[];
  };
  const updates = [pull.snapshot, ...pull.updates.map((u) => u.data)]
    .filter((d): d is string => !!d)
    .map(bytesText)
    .join('\n');
  await api.post(`/api/v1/pages/${pageId}/versions`, { name: 'After the ERP data', kind: null });
  const versions: string[] = [];
  await expect
    .poll(
      async () => {
        const list = (await api.get(`/api/v1/pages/${pageId}/versions`)) as {
          id: string;
          status: string;
        }[];
        return list.length > 0 && list.every((v) => v.status === 'ready');
      },
      { timeout: 60000 },
    )
    .toBe(true);
  for (const v of (await api.get(`/api/v1/pages/${pageId}/versions`)) as { id: string }[]) {
    const detail = (await api.get(`/api/v1/pages/${pageId}/versions/${v.id}`)) as {
      url: string | null;
    };
    if (!detail.url) continue;
    const response = await fetch(detail.url);
    versions.push(Buffer.from(await response.arrayBuffer()).toString('utf8'));
  }
  return { json, updates, versions };
}

/** Server search hits for a query in a workspace. */
export async function searchHits(api: Api, workspaceId: string, q: string) {
  const answer = (await api.get(
    `/api/v1/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}&limit=20`,
  )) as { hits: { pageId: string; title: string; snippet: string }[] };
  return answer.hits;
}

export { sleep };
