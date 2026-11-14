// Phase 6's helpers for the collaboration specs, against the server stack (its hub, the worker's
// relay and mention pass): two or three people in one workspace (the others members by
// invitation), each in a browser profile of their own; keystrokes timed on one clock from the
// typist's key to the other page's DOM change; the hub's frames as a page receives them; the
// hub's socket cut and refused (Playwright's routeWebSocket); and what a page alerted.
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { newAccount, signIn, signedIn, syncStatus, type TestAccount } from './cloud';
import { APP, signedInWorkspace, treeRow } from './database';
import { invite, workspaceIdOf, type Api } from './ecosystem';
import { editor, newPage, waitSaved } from './helpers';

export const HUB = /\/api\/v1\/realtime(\?|$)/;

/**
 * Console lines a page may log that are not the app's: the browser's own line for a WebSocket
 * handshake that failed (CLAUDE.md, Phase 6), and, while the API is down or a person has lost a
 * page, the browser's line for each refused request.
 */
export const HANDSHAKE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:5280\/api\/v1\/realtime/;
export const API_DOWN =
  /net::ERR_CONNECTION_REFUSED|net::ERR_CONNECTION_RESET|net::ERR_EMPTY_RESPONSE/;

/** Records, in every page of a context: each typed key's time, and every alert or notice shown. */
export function probes() {
  const w = window as unknown as { __keys: number[]; __alerts: string[] };
  w.__keys = [];
  w.__alerts = [];
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey) w.__keys.push(Date.now());
    },
    true,
  );
  const seen = new WeakSet<Element>();
  const look = () => {
    for (const el of document.querySelectorAll('.cgw-notice, [role="alert"]')) {
      if (seen.has(el) || !el.textContent?.trim()) continue;
      seen.add(el);
      w.__alerts.push(el.textContent.trim());
    }
  };
  new MutationObserver(look).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

export interface Person {
  account: TestAccount;
  api: Api;
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** The account's user id. */
  id: string;
  /** The hub's messages this person's page received (watched from before it connected). */
  hub: HubFrames;
}

/** Fails on page errors and console errors but the ones `allowed`. */
export function watch(page: Page, allowed: RegExp[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const line = `${message.text()} ${message.location().url ?? ''}`.trim();
    if (!allowed.some((a) => a.test(line))) errors.push(line);
  });
  return errors;
}

export async function userId(api: Api, workspaceId: string, email: string) {
  const members = (await api.get(`/api/v1/workspaces/${workspaceId}/members`)) as {
    userId: string;
    email: string;
  }[];
  return members.find((m) => m.email.toLowerCase() === email.toLowerCase())!.userId;
}

export interface Team {
  workspaceId: string;
  owner: Person;
  members: Person[];
  close(): Promise<void>;
}

/**
 * An owner signed in on `page` with a synced workspace, and members invited by mail and accepted,
 * each signed in on a browser profile of their own (`allowed` console lines for all of them).
 */
export async function team(
  page: Page,
  browser: Browser,
  names: string[],
  { workspace = 'Team space', allowed = [] as RegExp[] } = {},
): Promise<Team> {
  await page.context().addInitScript(probes);
  const ownerErrors = watch(page, allowed);
  const ownerHub = hubFrames(page);
  const ownerAccount = await newAccount(names[0]);
  await signedInWorkspace(page, ownerAccount, workspace, null, async () => browser);
  const ownerApi = await apiSession(ownerAccount);
  const workspaceId = await workspaceIdOf(ownerApi, workspace);
  const owner: Person = {
    account: ownerAccount,
    api: ownerApi,
    context: page.context(),
    page,
    errors: ownerErrors,
    id: await userId(ownerApi, workspaceId, ownerAccount.email),
    hub: ownerHub,
  };
  const members: Person[] = [];
  for (const name of names.slice(1))
    members.push(await member(browser, ownerApi, workspaceId, name, allowed));
  return {
    workspaceId,
    owner,
    members,
    async close() {
      for (const person of [owner, ...members]) await person.api.dispose().catch(() => {});
      for (const person of members) await person.context.close().catch(() => {});
    },
  };
}

/**
 * A member of the workspace by invitation (accepted through the API), signed in on a browser
 * profile of their own, synced.
 */
export async function member(
  browser: Browser,
  ownerApi: Api,
  workspaceId: string,
  name: string,
  allowed: RegExp[] = [],
): Promise<Person> {
  const account = await newAccount(name);
  const api = await invite(ownerApi, workspaceId, account);
  const context = await browser.newContext({
    baseURL: APP,
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(probes);
  const page = await context.newPage();
  const errors = watch(page, allowed);
  const hub = hubFrames(page);
  await page.goto(`${APP}/`);
  await signIn(page, account, `${APP}/`);
  await signedIn(page, account);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  return {
    account,
    api,
    context,
    page,
    errors,
    id: await userId(ownerApi, workspaceId, account.email),
    hub,
  };
}

export const pageIdOf = (page: Page) => new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)![1];

/**
 * A page made by the owner with these paragraphs (typed, then saved and synced), opened by each
 * member from the sidebar. Returns its id and its blocks' ids in order.
 */
export async function sharedPage(t: Team, title: string, paragraphs: string[]) {
  const { page } = t.owner;
  await newPage(page, title);
  for (const [i, text] of paragraphs.entries()) {
    if (i) await page.keyboard.press('Enter');
    await page.keyboard.type(text);
  }
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const pageId = pageIdOf(page);
  for (const member of t.members) await openPage(member.page, title, paragraphs.at(-1)!);
  const ids = await editor(page).evaluate((root) =>
    [...root.querySelectorAll(':scope [data-block]')].map((b) => b.getAttribute('data-block-id')!),
  );
  return { pageId, ids };
}

/** The page's own "Page actions" (the top bar's; a tree row under the pointer has one too). */
export const pageActions = (page: Page) =>
  page.getByRole('region', { name: 'Page' }).getByRole('button', { name: 'Page actions' });

// ------------------------------------------------------------------------------- comments
/** The page's comments panel. */
export const panel = (page: Page) => page.getByTestId('comments-panel');
/** A thread in the panel. */
export const threadOf = (page: Page, threadId: string) =>
  panel(page).locator(`[data-thread-id="${threadId}"]`);

/** Shows the page's comments from the page menu (open stays open). */
export async function showComments(page: Page) {
  if (await panel(page).isVisible()) return;
  await pageActions(page).click();
  await page.getByRole('menuitem', { name: 'Show or hide comments' }).click();
  await expect(panel(page)).toBeVisible();
}

/**
 * Selects `length` characters of a block's text from `from`, by the keys, and waits until the
 * editor holds that selection (it reads the browser's a moment after each key: a shortcut pressed
 * at once, faster than anyone types, could act on the selection before the last key).
 */
export async function select(page: Page, blockId: string, from: number, length: number) {
  await caretIn(page, blockId, 'start');
  for (let i = 0; i < from; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < length; i++) await page.keyboard.press('Shift+ArrowRight');
  const expected = await page.evaluate(() => getSelection()!.toString());
  expect(expected).toHaveLength(length);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const view = document.querySelector('.cgw-page .ProseMirror') as unknown as {
          editor: {
            state: {
              selection: { from: number; to: number };
              doc: { textBetween(a: number, b: number): string };
            };
          };
        };
        const { selection, doc } = view.editor.state;
        return doc.textBetween(selection.from, selection.to);
      }),
    )
    .toBe(expected);
}

/** Writes in a composer: text, with "@" mentions chosen from its list by name. */
export async function compose(
  page: Page,
  composer: Locator,
  parts: (string | { mention: string })[],
) {
  await composer.click();
  for (const part of parts) {
    if (typeof part === 'string') {
      await page.keyboard.type(part);
      continue;
    }
    await page.keyboard.type(`@${part.mention.slice(0, 2)}`);
    const list = page.getByRole('listbox', { name: 'Mention' });
    await expect(list.getByRole('option', { name: part.mention })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
  }
  await page.keyboard.press('Control+Enter');
}

/** The newest thread made on this page, once the server holds it. */
export async function newestThread(page: Page) {
  const item = panel(page).locator('[data-thread-id][data-state="saved"]').last();
  await expect(item).toBeVisible({ timeout: 20000 });
  return (await item.getAttribute('data-thread-id'))!;
}

/** Opens a page from the sidebar and waits for its text. */
export async function openPage(page: Page, title: string, text: string) {
  await treeRow(page, title).click({ timeout: 30000 });
  await expect(page.getByLabel('Page title')).toHaveValue(title);
  await expect(editor(page)).toContainText(text, { timeout: 30000 });
}

/** The presence bar shows these people (and only them) on the page. */
export async function seesOnPage(page: Page, names: string[], timeout = 20000) {
  const bar = page.getByTestId('presence-bar');
  if (!names.length) return expect(bar).toHaveCount(0, { timeout });
  await expect(bar).toBeVisible({ timeout });
  for (const name of names) await expect(bar.getByRole('img', { name })).toBeVisible({ timeout });
  await expect(bar.getByRole('img')).toHaveCount(names.length, { timeout });
}

/** A block's body by id. */
export const blockBody = (page: Page, blockId: string) =>
  editor(page).locator(`[data-block-id="${blockId}"] > .cgw-body`);

/** Puts the caret in a block's body (the editor focused), at its start or end. */
export async function caretIn(page: Page, blockId: string, at: 'start' | 'end') {
  // At the start of its first line, not its middle: a comment's marker at the end of the text
  // may sit there, and a click on it opens the thread and leaves the focus where it was.
  const body = blockBody(page, blockId);
  const box = (await body.boundingBox())!;
  await body.click({ position: { x: 3, y: Math.min(10, box.height / 2) } });
  await page.keyboard.press(at === 'start' ? 'Home' : 'End');
}

/** Watches a block's text in a page: every DOM change's time and the block's text then. */
export async function watchBlock(page: Page, blockId: string) {
  await page.evaluate((id) => {
    const w = window as unknown as { __seen: [number, string][] };
    const body = () =>
      document.querySelector(`.cgw-page .cgw-editor [data-block-id="${id}"] > .cgw-body`);
    w.__seen = [[Date.now(), body()?.textContent ?? '']];
    new MutationObserver(() => w.__seen.push([Date.now(), body()?.textContent ?? ''])).observe(
      document.querySelector('.cgw-page .cgw-editor')!,
      {
        subtree: true,
        childList: true,
        characterData: true,
      },
    );
  }, blockId);
}

export const keysOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __keys: number[] }).__keys.splice(0));
export const seenOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __seen: [number, string][] }).__seen);
export const alertsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts);

export interface Delays {
  count: number;
  /** Keystrokes never seen on the other page. */
  missing: number;
  p50: number;
  p95: number;
  max: number;
  over300: number;
  all: number[];
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

/**
 * Each of the typist's keystrokes (its key times, in order) to the first moment the other page's
 * block held that many of the typist's characters (`mine` tells them from everyone else's).
 */
export function delays(keys: number[], seen: [number, string][], mine: RegExp): Delays {
  const count = (text: string) => (text.match(new RegExp(mine.source, 'g')) ?? []).length;
  const base = count(seen[0]?.[1] ?? '');
  const all: number[] = [];
  let missing = 0;
  let j = 0;
  for (let k = 1; k <= keys.length; k++) {
    while (j < seen.length && count(seen[j][1]) - base < k) j++;
    if (j >= seen.length) {
      missing++;
      continue;
    }
    all.push(Math.max(0, seen[j][0] - keys[k - 1]));
  }
  return {
    count: keys.length,
    missing,
    p50: percentile(all, 0.5),
    p95: percentile(all, 0.95),
    max: Math.max(...all),
    over300: all.filter((d) => d > 300).length,
    all,
  };
}

export type HubFrames = ReturnType<typeof hubFrames>;

/**
 * The hub's messages a page receives, with the time each arrived (this process's clock), from the
 * sockets it opens after this is called.
 */
export function hubFrames(page: Page) {
  const frames: { at: number; target: string; args: unknown[] }[] = [];
  let sockets = 0;
  page.on('websocket', (ws) => {
    if (!HUB.test(ws.url())) return;
    sockets++;
    ws.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8');
      for (const part of text.split('\u001e')) {
        if (!part) continue;
        try {
          const message = JSON.parse(part) as { type?: number; target?: string; arguments?: [] };
          if (message.type === 1 && message.target)
            frames.push({ at: Date.now(), target: message.target, args: message.arguments ?? [] });
        } catch {
          // Not a hub message.
        }
      }
    });
  });
  return {
    frames,
    get sockets() {
      return sockets;
    },
  };
}

/**
 * The hub's socket for a browser profile, through Playwright: passed to the server until `block`,
 * which closes the open ones and refuses every new one (each closed as it opens) until `unblock`.
 */
export async function hubSwitch(context: BrowserContext, blocked = false) {
  const open = new Set<WebSocketRoute>();
  let refused = 0;
  await context.routeWebSocket(HUB, (ws) => {
    if (blocked) {
      refused++;
      void ws.close({ code: 1011, reason: 'Blocked by the test' });
      return;
    }
    ws.connectToServer();
    open.add(ws);
  });
  return {
    get refused() {
      return refused;
    },
    async block() {
      blocked = true;
      for (const ws of open) await ws.close({ code: 1011, reason: 'Blocked by the test' });
      open.clear();
    },
    unblock() {
      blocked = false;
    },
  };
}

/** The top-level blocks' ids and texts in the server's derived document (the worker's JSON). */
export async function serverBlocks(api: Api, pageId: string) {
  const raw = await api.raw(`/api/v1/pages/${pageId}/doc/json`);
  if (raw.status !== 200) return null;
  const answer = JSON.parse(raw.body) as { json: unknown };
  const json = (typeof answer.json === 'string' ? JSON.parse(answer.json) : answer.json) as {
    content?: { attrs?: { id?: string }; content?: unknown[] }[];
  };
  const text = (node: unknown): string => {
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text') return n.text ?? '';
    // A person is "@" in the server's own text too (names change).
    if (n.type === 'userMention') return '@';
    return (n.content ?? []).map(text).join('');
  };
  return (json?.content ?? []).map((block) => ({
    id: block.attrs?.id ?? '',
    text: text((block.content ?? [])[0] ?? {}),
  }));
}

/** Waits until the server's derived text of a block is `expected`. */
export async function serverHolds(api: Api, pageId: string, blockId: string, expected: string) {
  await expect
    .poll(
      async () => (await serverBlocks(api, pageId))?.find((b) => b.id === blockId)?.text ?? null,
      { timeout: 60000, intervals: [250, 500, 1000] },
    )
    .toBe(expected);
}

/** Types into two pages at once, each at its own pace. */
export async function typeBoth(a: Page, aText: string, b: Page, bText: string, delay: number) {
  await Promise.all([a.keyboard.type(aText, { delay }), b.keyboard.type(bText, { delay })]);
}

/** The notifications of a person, newest first. */
export async function inboxOf(api: Api) {
  return (await api.get('/api/v1/account/notifications?limit=50')) as {
    notifications: {
      id: string;
      kind: string;
      pageId: string;
      blockId: string | null;
      threadId: string | null;
      actor: { id: string; name: string };
      excerpt: string;
    }[];
    unread: number;
  };
}

/** Restricts a page to these people (the owner `full`). */
export async function restrict(t: Team, pageId: string, people: { id: string; level: string }[]) {
  await t.owner.api.put(`/api/v1/pages/${pageId}/permissions`, {
    restricted: true,
    entries: [
      { principalType: 'user', principalId: t.owner.id, level: 'full' },
      ...people.map((p) => ({ principalType: 'user', principalId: p.id, level: p.level })),
    ],
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The comments, the inbox and the presence bar with something in each (for Axe and the Arabic
 * walk): Ada and Ben on a page; Ada's open thread on a selection with Ben's reply (Ada's inbox:
 * a reply); Ben's thread on the second block naming Ada (her inbox: a mention in a comment),
 * resolved by Ada. Made in English; Ben stays on the page.
 */
export async function commentScene(page: Page) {
  const t = await team(page, page.context().browser()!, ['Ada', 'Ben']);
  const ada = t.owner;
  const ben = t.members[0];
  const { pageId, ids } = await sharedPage(t, 'Review together', [
    'Alpha beta gamma delta.',
    'A second paragraph to resolve.',
  ]);
  await select(ada.page, ids[0], 6, 10);
  await ada.page.keyboard.press('Control+Alt+KeyM');
  await ada.page.keyboard.type('Is this range right?');
  await ada.page.keyboard.press('Control+Enter');
  const open = await newestThread(ada.page);
  await showComments(ben.page);
  await expect(threadOf(ben.page, open)).toBeVisible({ timeout: 20000 });
  await threadOf(ben.page, open).getByRole('button', { name: 'Reply' }).click();
  await compose(ben.page, threadOf(ben.page, open).getByRole('textbox', { name: 'Your reply' }), [
    'Looks right to me.',
  ]);
  await expect(threadOf(ada.page, open)).toContainText('Looks right to me.', { timeout: 20000 });
  await caretIn(ben.page, ids[1], 'end');
  await ben.page.keyboard.press('Control+Alt+KeyM');
  await compose(
    ben.page,
    panel(ben.page).getByTestId('comment-draft').getByRole('textbox', { name: 'New comment' }),
    [{ mention: 'Ada' }, 'can this be resolved?'],
  );
  await expect(panel(ada.page).locator('[data-thread-id]')).toHaveCount(2, { timeout: 20000 });
  const done = (await panel(ada.page)
    .locator('[data-thread-id]')
    .evaluateAll(
      (els, known) => els.map((el) => el.getAttribute('data-thread-id')).find((id) => id !== known),
      open,
    ))!;
  await threadOf(ada.page, done).getByRole('button', { name: 'Resolve' }).click();
  await expect(threadOf(ada.page, done)).toHaveCount(0);
  await expect
    .poll(async () => (await inboxOf(ada.api)).notifications.map((n) => n.kind).sort(), {
      timeout: 30000,
    })
    .toEqual(['commentMention', 'reply']);
  return { t, pageId, ids, open, done };
}
