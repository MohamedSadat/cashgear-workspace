// Phase 6's acceptance criteria 1 to 4 in Chrome and Edge, against the server stack (the hub in the
// API's process, the worker's validation and the relay): two people typing in one paragraph see
// each other's keys within 300 ms and end with the same text; with the hub's socket blocked,
// editing goes on over HTTP with nothing shown but the status; the API process recycled while
// both type loses no edit; a person whose access is taken away stops receiving updates at once
// (the limit is 60 seconds).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, desktop } from './fixtures';
import { editor } from './helpers';
import { syncStatus } from './cloud';
import { restartApi } from '../../scripts/stack-control.mjs';
import {
  API_DOWN,
  HANDSHAKE,
  alertsOf,
  blockBody,
  caretIn,
  delays,
  hubSwitch,
  keysOf,
  restrict,
  seenOf,
  seesOnPage,
  serverBlocks,
  serverHolds,
  sharedPage,
  sleep,
  team,
  typeBoth,
  watchBlock,
  type Delays,
  type Team,
} from './collab';

test.skip(desktop, 'Two people in browser profiles of their own: desktop-cloud.spec.ts');

const results = resolve(import.meta.dirname, '../../bench/results');
let current: Team | null = null;
test.afterEach(async () => {
  await current?.close();
  current = null;
});

/** Lowercase letters only (Ada's) and capitals only (Ben's), so each person's keys can be counted. */
const ADA = 'thequickbrownfoxjumpsoverthelazydogandkeepsontypingwords';
const BEN = 'PACKMYBOXWITHFIVEDOZENLIQUORJUGSANDTHENSOMEMORELETTERS';

const summary = (d: Delays) =>
  `${d.count} keys: p50 ${d.p50} ms, p95 ${d.p95} ms, max ${d.max} ms, over 300 ms: ${d.over300}, never seen: ${d.missing}`;

test('two people typing in the same paragraph see each key within 300 ms and end with the same text', async ({
  page,
  browserName,
}, testInfo) => {
  test.setTimeout(240000);
  void browserName;
  const t = (current = await team(page, page.context().browser()!, ['Ada', 'Ben']));
  const ada = t.owner;
  const ben = t.members[0];
  const { pageId, ids } = await sharedPage(t, 'Together', ['123 456']);
  const block = ids[0];
  // Both on the page through the hub: each sees the other there.
  await seesOnPage(ada.page, ['Ben']);
  await seesOnPage(ben.page, ['Ada']);
  await watchBlock(ada.page, block);
  await watchBlock(ben.page, block);
  // Ada at the paragraph's end, Ben at its start, typing at once at about eight keys a second.
  await caretIn(ada.page, block, 'end');
  await caretIn(ben.page, block, 'start');
  await keysOf(ada.page);
  await keysOf(ben.page);
  const aText = ADA.slice(0, 50);
  const bText = BEN.slice(0, 50);
  await typeBoth(ada.page, aText, ben.page, bText, 120);
  const expected = `${bText}123 456${aText}`;
  await expect(blockBody(ada.page, block)).toHaveText(expected, { timeout: 15000 });
  await expect(blockBody(ben.page, block)).toHaveText(expected, { timeout: 15000 });
  const adaToBen = delays(await keysOf(ada.page), await seenOf(ben.page), /[a-z]/);
  const benToAda = delays(await keysOf(ben.page), await seenOf(ada.page), /[A-Z]/);
  const figures = { browser: testInfo.project.name, adaToBen, benToAda };
  mkdirSync(results, { recursive: true });
  writeFileSync(
    join(results, `phase6-typing-${testInfo.project.name}.json`),
    JSON.stringify(figures, null, 2) + '\n',
  );
  testInfo.annotations.push(
    { type: 'Ada to Ben', description: summary(adaToBen) },
    { type: 'Ben to Ada', description: summary(benToAda) },
  );
  console.log(`Ada to Ben: ${summary(adaToBen)}\nBen to Ada: ${summary(benToAda)}`);
  for (const d of [adaToBen, benToAda]) {
    expect(d.count).toBeGreaterThanOrEqual(40);
    expect(d.missing).toBe(0);
    expect(d.p95).toBeLessThanOrEqual(300);
  }
  // The server's derived document holds the same text.
  await serverHolds(ada.api, pageId, block, expected);
  expect(ada.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
});

test('with the hub blocked, editing goes on over HTTP and nothing is shown but the status', async ({
  page,
}) => {
  test.setTimeout(240000);
  // The browser's own line for each refused handshake is the only console error allowed.
  const t = (current = await team(page, page.context().browser()!, ['Ada', 'Ben'], {
    allowed: [HANDSHAKE],
  }));
  const ada = t.owner;
  const ben = t.members[0];
  // Ben's hub is refused from the start (a proxy that closes it); Ada's is cut mid-session.
  // (A route takes the sockets opened after it: both pages load again under theirs.)
  const benHub = await hubSwitch(ben.context, true);
  const adaHub = await hubSwitch(ada.context);
  for (const p of [ada, ben]) {
    await p.page.reload();
    await expect(syncStatus(p.page)).toHaveText('Synced', { timeout: 30000 });
  }
  const { pageId, ids } = await sharedPage(t, 'Over HTTP', ['Typed while the hub is away.']);
  const block = ids[0];
  // Ada is on the hub (her presence needs it), Ben is not: neither sees the other there.
  await expect.poll(() => benHub.refused, { timeout: 30000 }).toBeGreaterThan(0);
  await sleep(2000);
  await seesOnPage(ada.page, []);
  // Ben's edit reaches Ada, and Ada's reaches Ben, by the HTTP loop.
  await caretIn(ben.page, block, 'end');
  await ben.page.keyboard.type(' Ben was here.', { delay: 30 });
  await expect(blockBody(ada.page, block)).toContainText('Ben was here.', { timeout: 15000 });
  await adaHub.block();
  await caretIn(ada.page, block, 'end');
  await ada.page.keyboard.type(' Ada too.', { delay: 30 });
  await expect(blockBody(ben.page, block)).toContainText('Ada too.', { timeout: 15000 });
  const expected = 'Typed while the hub is away. Ben was here. Ada too.';
  for (const p of [ada, ben]) {
    await expect(blockBody(p.page, block)).toHaveText(expected);
    await expect(syncStatus(p.page)).toHaveAttribute('data-state', 'synced', { timeout: 30000 });
    await expect(syncStatus(p.page)).toHaveText('Synced');
  }
  await serverHolds(ada.api, pageId, block, expected);
  // Nothing was said but the status: no notice, no alert, on either page.
  expect(await alertsOf(ada.page)).toEqual([]);
  expect(await alertsOf(ben.page)).toEqual([]);
  expect(adaHub.refused + benHub.refused).toBeGreaterThan(1);
  expect(ada.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
});

test('the API process recycled while both type loses no edit, and both come back by themselves', async ({
  page,
}, testInfo) => {
  test.setTimeout(300000);
  // While the API is down, the browser logs each refused request and handshake.
  const t = (current = await team(page, page.context().browser()!, ['Ada', 'Ben'], {
    allowed: [HANDSHAKE, API_DOWN],
  }));
  const ada = t.owner;
  const ben = t.members[0];
  const { pageId, ids } = await sharedPage(t, 'Recycled', ['123 456']);
  const block = ids[0];
  await seesOnPage(ada.page, ['Ben']);
  await seesOnPage(ben.page, ['Ada']);
  const adaFrames = ada.hub;
  const benFrames = ben.hub;
  const sockets = [adaFrames.sockets, benFrames.sockets];
  await caretIn(ada.page, block, 'end');
  await caretIn(ben.page, block, 'start');
  // Both type for about 16 seconds; the API is ended and started again two seconds in.
  const aText = ADA.slice(0, 54);
  const bText = BEN.slice(0, 54);
  const typing = typeBoth(ada.page, aText, ben.page, bText, 300);
  await sleep(2000);
  const recycle = await restartApi();
  testInfo.annotations.push({
    type: 'recycle',
    description: `API down for ${recycle.readyAt - recycle.stoppedAt} ms`,
  });
  console.log(`Recycle: the API down for ${recycle.readyAt - recycle.stoppedAt} ms`);
  await typing;
  const expected = `${bText}123 456${aText}`;
  for (const p of [ada, ben]) {
    await expect(blockBody(p.page, block)).toHaveText(expected, { timeout: 60000 });
    await expect(syncStatus(p.page)).toHaveText('Synced', { timeout: 60000 });
  }
  // Every key typed, before, during and after the recycle, is in the server's derived document.
  await serverHolds(ada.api, pageId, block, expected);
  // Each reconnected by itself (a new socket after the restart) and is on the page again.
  expect(adaFrames.sockets).toBeGreaterThan(sockets[0]);
  expect(benFrames.sockets).toBeGreaterThan(sockets[1]);
  await seesOnPage(ada.page, ['Ben'], 60000);
  await seesOnPage(ben.page, ['Ada'], 60000);
  // And the hub carries edits again: a word of Ada's reaches Ben through a relay frame.
  const before = benFrames.frames.length;
  await ada.page.keyboard.type(' back', { delay: 50 });
  await expect(blockBody(ben.page, block)).toHaveText(`${expected} back`, { timeout: 5000 });
  expect(benFrames.frames.slice(before).some((f) => f.target === 'Updates')).toBe(true);
  expect(ada.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
});

/** A member with the page open loses it; then nothing the owner types reaches them. */
async function revoked(
  t: Team,
  pageId: string,
  block: string,
  take: () => Promise<void>,
  reason: string,
) {
  const ada = t.owner;
  const ben = t.members[0];
  const frames = ben.hub;
  // A key of Ada's reaches Ben first, through the hub.
  await caretIn(ada.page, block, 'end');
  await ada.page.keyboard.type(' seen', { delay: 30 });
  await expect(blockBody(ben.page, block)).toContainText('seen', { timeout: 5000 });
  await expect.poll(() => frames.frames.some((f) => f.target === 'Updates')).toBe(true);
  const takenAt = Date.now();
  await take();
  const answeredAt = Date.now();
  await expect
    .poll(() => frames.frames.find((f) => f.target === 'AccessRevoked'), { timeout: 60000 })
    .toBeTruthy();
  const told = frames.frames.find((f) => f.target === 'AccessRevoked')!;
  const toRevoked = told.at - answeredAt;
  expect((told.args[0] as { reason: string }).reason).toBe(reason);
  // The page leaves Ben's view (the feed's revoke removes it from the device).
  await expect(ben.page.getByRole('treeitem', { name: /Kept from Ben/ })).toHaveCount(0, {
    timeout: 60000,
  });
  const toGone = Date.now() - answeredAt;
  // Nothing typed after that reaches Ben: no frame, no text.
  const after = frames.frames.length;
  await ada.page.keyboard.type(' secret after the revoke', { delay: 30 });
  await expect(syncStatus(ada.page)).toHaveText('Synced', { timeout: 30000 });
  await serverHolds(
    ada.api,
    pageId,
    block,
    'Kept from Ben after this. seen secret after the revoke',
  );
  await sleep(5000);
  const late = frames.frames.slice(after);
  expect(late.filter((f) => f.target === 'Updates' || f.target === 'Awareness')).toEqual([]);
  await expect(editor(ben.page).getByText('secret after the revoke')).toHaveCount(0);
  expect(
    await ben.page.evaluate(() => document.body.innerText.includes('secret after the revoke')),
  ).toBe(false);
  return { toRevoked, toGone, sinceAsked: told.at - takenAt };
}

test('a member whose page is restricted without them stops receiving updates at once', async ({
  page,
}, testInfo) => {
  test.setTimeout(240000);
  // Ben's app may ask once more for what it lost (the browser logs each 403 or 404).
  const t = (current = await team(page, page.context().browser()!, ['Ada', 'Ben']));
  const ben = t.members[0];
  const lost = /status of 40[34] /;
  const { pageId, ids } = await sharedPage(t, 'Kept from Ben', ['Kept from Ben after this.']);
  await seesOnPage(ben.page, ['Ada']);
  const figures = await revoked(t, pageId, ids[0], () => restrict(t, pageId, []), 'access.denied');
  testInfo.annotations.push({
    type: 'restricted',
    description: `AccessRevoked ${figures.toRevoked} ms after the change was answered; the page gone from the sidebar after ${figures.toGone} ms`,
  });
  console.log(`Restricted: ${JSON.stringify(figures)}`);
  expect(figures.toRevoked).toBeLessThan(60000);
  // Ada's view is still the page; Ben's is not.
  await seesOnPage(t.owner.page, []);
  expect(t.owner.errors).toEqual([]);
  expect(ben.errors.filter((e) => !lost.test(e))).toEqual([]);
});

test('a member removed from the workspace stops receiving updates at once', async ({
  page,
}, testInfo) => {
  test.setTimeout(240000);
  const t = (current = await team(page, page.context().browser()!, ['Ada', 'Ben']));
  const ben = t.members[0];
  const lost = /status of 40[134] /;
  const { pageId, ids } = await sharedPage(t, 'Kept from Ben', ['Kept from Ben after this.']);
  await seesOnPage(ben.page, ['Ada']);
  const figures = await revoked(
    t,
    pageId,
    ids[0],
    () => t.owner.api.del(`/api/v1/workspaces/${t.workspaceId}/members/${ben.id}`),
    'member.removed',
  );
  testInfo.annotations.push({
    type: 'removed',
    description: `AccessRevoked ${figures.toRevoked} ms after the removal was answered; the page gone from the sidebar after ${figures.toGone} ms`,
  });
  console.log(`Removed: ${JSON.stringify(figures)}`);
  expect(figures.toRevoked).toBeLessThan(60000);
  expect(await serverBlocks(ben.api, pageId)).toBeNull();
  expect(t.owner.errors).toEqual([]);
  expect(ben.errors.filter((e) => !lost.test(e))).toEqual([]);
});
