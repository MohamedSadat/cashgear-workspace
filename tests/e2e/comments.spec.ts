// Phase 6's comments, mentions and presence in Chrome and Edge, against the server stack: a comment
// made on a selection stays on its block when the block moves and the text around and inside it
// changes; replies, mentions in comments and their notifications; resolving and reopening; a
// thread on a removed block. A person mentioned in a page finds it in their inbox and is taken to
// the block; someone who cannot read the page gets nothing. Each person sees the other in the top
// bar, beside the page in the sidebar and as a named cursor, until they leave; a share link's view
// shows none of it.
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { syncStatus } from './cloud';
import { treeRow } from './database';
import {
  HUB,
  blockBody,
  caretIn,
  compose,
  inboxOf,
  newestThread,
  openPage,
  pageActions,
  panel,
  restrict,
  select,
  seesOnPage,
  serverHolds,
  sharedPage,
  showComments,
  sleep,
  team,
  threadOf,
  watch,
  type Team,
} from './collab';

test.skip(desktop, 'Two people in browser profiles of their own');

let current: Team | null = null;
test.afterEach(async () => {
  await current?.close();
  current = null;
});

/**
 * The text a block shows highlighted for comments (decorations drawn over it, such as another
 * person's selection, may split it into several spans).
 */
const highlighted = (page: Page, blockId: string) =>
  blockBody(page, blockId)
    .locator('.cgw-commented')
    .allTextContents()
    .then((parts) => parts.join(''));

/** The inbox's entry with this text, opened. */
async function openFromInbox(page: Page, text: string | RegExp) {
  await page.getByTestId('inbox-link').click();
  const item = page.getByTestId('inbox-list').locator('.cgw-inbox-item', { hasText: text });
  await expect(item).toBeVisible({ timeout: 30000 });
  await expect(item).toHaveClass(/is-unread/);
  await item.getByRole('link').click();
}

test('a comment stays on its block when the block moves and the text around it changes; replies, mentions, resolving', async ({
  page,
}) => {
  test.setTimeout(360000);
  const t = (current = await team(page, page.context().browser()!, ['Ada', 'Ben']));
  const ada = t.owner;
  const ben = t.members[0];
  const { pageId, ids } = await sharedPage(t, 'Review', [
    'First paragraph.',
    'Alpha beta gamma delta.',
    'Third paragraph to remove.',
  ]);
  const [first, middle, third] = ids;

  // Ada comments on "beta gamma" with Ctrl+Alt+M.
  await select(ada.page, middle, 6, 10);
  await ada.page.keyboard.press('Control+Alt+KeyM');
  const draft = panel(ada.page).getByTestId('comment-draft');
  await expect(draft).toBeVisible();
  await expect(draft.locator('blockquote')).toHaveText('beta gamma');
  await expect(draft.getByRole('textbox', { name: 'New comment' })).toBeFocused();
  await ada.page.keyboard.type('Is this range right?');
  await ada.page.keyboard.press('Control+Enter');
  const thread = await newestThread(ada.page);
  await expect.poll(() => highlighted(ada.page, middle)).toBe('beta gamma');

  // Ben sees it, on the same words.
  await showComments(ben.page);
  await expect(threadOf(ben.page, thread)).toContainText('Is this range right?', {
    timeout: 20000,
  });
  await expect(threadOf(ben.page, thread).locator('.cgw-thread-quote')).toHaveText('beta gamma');
  await expect.poll(() => highlighted(ben.page, middle)).toBe('beta gamma');

  // Ben edits before, inside and after the range: the range takes what was typed inside only.
  await caretIn(ben.page, middle, 'start');
  await ben.page.keyboard.type('Before ');
  await caretIn(ben.page, middle, 'start');
  for (let i = 0; i < 'Before Alpha beta'.length; i++) await ben.page.keyboard.press('ArrowRight');
  await ben.page.keyboard.type('-x');
  await caretIn(ben.page, middle, 'end');
  for (let i = 0; i < ' delta.'.length; i++) await ben.page.keyboard.press('ArrowLeft');
  await ben.page.keyboard.type('!');
  await caretIn(ben.page, middle, 'end');
  await ben.page.keyboard.type(' (after)');
  const edited = 'Before Alpha beta-x gamma! delta. (after)';
  await expect(blockBody(ada.page, middle)).toHaveText(edited, { timeout: 10000 });
  await expect.poll(() => highlighted(ada.page, middle)).toBe('beta-x gamma');
  await expect.poll(() => highlighted(ben.page, middle)).toBe('beta-x gamma');

  // Ben moves the block up (Alt+Shift+ArrowUp): same id, now first; the thread goes with it.
  await caretIn(ben.page, middle, 'end');
  await ben.page.keyboard.press('Alt+Shift+ArrowUp');
  const order = (p: Page) =>
    editor(p).evaluate((root) =>
      [...root.querySelectorAll(':scope [data-block]')].map((b) => b.getAttribute('data-block-id')),
    );
  await expect.poll(() => order(ben.page)).toEqual([middle, first, third]);
  await expect.poll(() => order(ada.page), { timeout: 10000 }).toEqual([middle, first, third]);
  for (const p of [ada.page, ben.page]) {
    // Highlighted on that block (its words, or the whole block once they cannot be found), and
    // listed, not as on a removed block.
    const moved = editor(p).locator(`[data-block-id="${middle}"]`);
    await expect(moved.locator(`[data-comment-thread="${thread}"]`)).toHaveCount(1);
    await expect(moved.locator('.cgw-commented, .cgw-body.is-commented').first()).toBeVisible();
    await showComments(p);
    await expect(threadOf(p, thread)).toBeVisible();
    await expect(threadOf(p, thread).getByTestId('thread-removed')).toHaveCount(0);
  }
  await serverHolds(ada.api, pageId, middle, edited);

  // Ben replies: Ada's inbox has it.
  await threadOf(ben.page, thread).getByRole('button', { name: 'Reply' }).click();
  await compose(ben.page, threadOf(ben.page, thread).getByRole('textbox', { name: 'Your reply' }), [
    'Looks right to me.',
  ]);
  await expect(
    threadOf(ben.page, thread).getByTestId('comment').filter({ hasText: 'Looks right to me.' }),
  ).toHaveAttribute('data-state', 'saved', { timeout: 20000 });
  await expect(threadOf(ada.page, thread)).toContainText('Looks right to me.', { timeout: 20000 });
  await expect
    .poll(async () => (await inboxOf(ada.api)).notifications.map((n) => n.kind), {
      timeout: 20000,
    })
    .toContain('reply');

  // Ada answers, naming Ben: Ben's inbox has a mention in a comment, which opens the thread.
  await threadOf(ada.page, thread).getByRole('button', { name: 'Reply' }).click();
  await compose(ada.page, threadOf(ada.page, thread).getByRole('textbox', { name: 'Your reply' }), [
    'Thanks, ',
    { mention: 'Ben' },
    ' — resolving.',
  ]);
  await expect(threadOf(ada.page, thread).locator('.cgw-comment-mention.is-user')).toHaveText(
    '@Ben',
  );
  await openFromInbox(ben.page, 'Ada mentioned you in a comment on “Review”');
  await expect(ben.page).toHaveURL(new RegExp(`#/p/${pageId}$`));
  await expect(threadOf(ben.page, thread)).toBeFocused({ timeout: 20000 });
  await expect(threadOf(ben.page, thread)).toContainText('Thanks, @Ben — resolving.');
  // Ada's own inbox: Ben's reply.
  await openFromInbox(ada.page, 'Ben replied in a thread on “Review”');
  await expect(threadOf(ada.page, thread)).toBeFocused({ timeout: 20000 });

  // Resolved by Ada: gone from Ben's open list, under "Resolved"; reopened by Ben.
  await threadOf(ada.page, thread).getByRole('button', { name: 'Resolve' }).click();
  await expect(threadOf(ben.page, thread)).toHaveCount(0, { timeout: 20000 });
  const resolved = panel(ben.page).getByRole('button', { name: 'Resolved: 1' });
  await expect(resolved).toBeEnabled();
  await resolved.click();
  // (The name is isolated for right to left: a format character on each side.)
  await expect(threadOf(ben.page, thread)).toContainText(/Resolved by \W?Ada\W?, /);
  await expect(blockBody(ben.page, middle).locator('.cgw-commented')).toHaveCount(0);
  await threadOf(ben.page, thread).getByRole('button', { name: 'Reopen' }).click();
  await expect(
    panel(ada.page)
      .getByRole('list', { name: 'Open comments' })
      .locator(`[data-thread-id="${thread}"]`),
  ).toBeVisible({ timeout: 20000 });
  await expect(editor(ada.page).locator(`[data-comment-thread="${thread}"]`)).toHaveCount(1);

  // A thread on the whole third block (the caret, no selection); Ben deletes the block.
  await caretIn(ada.page, third, 'end');
  await ada.page.keyboard.press('Control+Alt+KeyM');
  await expect(
    panel(ada.page).getByTestId('comment-draft').locator('.cgw-thread-quote-text'),
  ).toHaveText('On the whole block');
  await ada.page.keyboard.type('Remove this?');
  await ada.page.keyboard.press('Control+Enter');
  await expect(panel(ada.page).locator('[data-thread-id]')).toHaveCount(2, { timeout: 20000 });
  const blockThread = (await panel(ada.page)
    .locator('[data-thread-id]')
    .evaluateAll(
      (els, known) => els.map((el) => el.getAttribute('data-thread-id')).find((id) => id !== known),
      thread,
    ))!;
  await expect(threadOf(ben.page, blockThread)).toContainText('Remove this?', { timeout: 20000 });
  await caretIn(ben.page, third, 'end');
  await ben.page.keyboard.press('Control+Slash');
  await ben.page.getByRole('menuitem', { name: /^Delete/ }).click();
  await expect.poll(() => order(ada.page), { timeout: 10000 }).toEqual([middle, first]);
  for (const p of [ada.page, ben.page]) {
    await expect(threadOf(p, blockThread).getByTestId('thread-removed')).toHaveText(
      'On a block that was removed',
      { timeout: 20000 },
    );
    await expect(threadOf(p, thread).getByTestId('thread-removed')).toHaveCount(0);
  }
  await expect(syncStatus(ada.page)).toHaveText('Synced', { timeout: 30000 });
  expect(ada.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
});

test('a person mentioned in a page finds it in their inbox and is taken to the block; someone who cannot read the page gets nothing', async ({
  page,
}) => {
  test.setTimeout(300000);
  const t = (current = await team(page, page.context().browser()!, ['Ada', 'Ben', 'Cleo']));
  const ada = t.owner;
  const [ben, cleo] = t.members;
  // A page only Ada and Ben may read (Cleo is a member, but not on this page).
  await newPage(ada.page, 'Plans');
  await ada.page.keyboard.type('Nothing here yet.');
  await waitSaved(ada.page);
  await expect(syncStatus(ada.page)).toHaveText('Synced', { timeout: 30000 });
  const pageId = new URL(ada.page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)![1];
  await restrict(t, pageId, [{ id: ben.id, level: 'edit' }]);
  await expect(treeRow(cleo.page, 'Plans')).toHaveCount(0, { timeout: 20000 });

  // Ada names both in one paragraph, from the "@" menu (people first).
  await ada.page.keyboard.press('Enter');
  await ada.page.keyboard.type('Ask ');
  // (A chosen mention is followed by a space.)
  for (const [person, after] of [
    ['Ben', 'and '],
    ['Cleo', 'to review.'],
  ]) {
    await ada.page.keyboard.type(`@${person.slice(0, 2)}`);
    const option = ada.page.getByRole('option', { name: person, exact: true });
    await expect(option).toBeVisible();
    await ada.page.keyboard.press('Enter');
    await ada.page.keyboard.type(after);
  }
  const block = await editor(ada.page).locator('[data-block]').last().getAttribute('data-block-id');
  await expect(blockBody(ada.page, block!)).toHaveText('Ask @Ben and @Cleo to review.');
  await waitSaved(ada.page);

  // The worker's pass: one entry for Ben, on that block.
  await expect
    .poll(async () => (await inboxOf(ben.api)).notifications, { timeout: 60000 })
    .toHaveLength(1);
  const [entry] = (await inboxOf(ben.api)).notifications;
  expect(entry).toMatchObject({ kind: 'mention', pageId, blockId: block, threadId: null });
  expect(entry.actor.id).toBe(ada.id);
  expect(entry.excerpt).toBe('Ask @ and @ to review.');
  // Cleo cannot read the page: nothing, though the same pass wrote Ben's.
  await sleep(3000);
  expect(await inboxOf(cleo.api)).toMatchObject({ notifications: [], unread: 0 });
  await cleo.page.getByTestId('inbox-link').click();
  await expect(cleo.page.getByText('Nothing here yet. When someone mentions you')).toBeVisible();
  // Nor did Ada (the writer) get one.
  expect((await inboxOf(ada.api)).notifications).toEqual([]);

  // Ben opens it from the inbox: the page, at the block.
  await openFromInbox(ben.page, 'Ada mentioned you in “Plans”');
  await expect(ben.page).toHaveURL(new RegExp(`#/p/${pageId}/${block}$`));
  await expect(blockBody(ben.page, block!)).toBeInViewport({ timeout: 20000 });
  await expect(blockBody(ben.page, block!)).toHaveText('Ask @Ben and @Cleo to review.');
  // Read now.
  await expect.poll(async () => (await inboxOf(ben.api)).unread).toBe(0);
  expect(ada.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
  expect(cleo.errors).toEqual([]);
});

test("each sees the other on the page, beside it in the sidebar and as a named cursor, until they leave; a share link's view shows none of it", async ({
  page,
}, testInfo) => {
  test.setTimeout(300000);
  const t = (current = await team(page, page.context().browser()!, ['Ada', 'Ben']));
  const ada = t.owner;
  const ben = t.members[0];
  await newPage(ada.page, 'Elsewhere');
  await ada.page.keyboard.type('Another page.');
  await waitSaved(ada.page);
  const { pageId, ids } = await sharedPage(t, 'Together', ['Hello there.', 'A second line.']);
  // Both on the page: the top bar, the sidebar.
  await seesOnPage(ada.page, ['Ben']);
  await seesOnPage(ben.page, ['Ada']);
  await expect(
    treeRow(ada.page, 'Together').getByRole('img', { name: 'Open now by Ben' }),
  ).toBeVisible();
  await expect(
    treeRow(ben.page, 'Together').getByRole('img', { name: 'Open now by Ada' }),
  ).toBeVisible();
  // Named cursors where each is typing.
  await caretIn(ben.page, ids[1], 'end');
  await caretIn(ada.page, ids[0], 'end');
  const caret = (p: Page, name: string) =>
    editor(p).locator(`.cgw-presence-caret[data-name="${name}"]`);
  await expect(caret(ada.page, 'Ben')).toHaveCount(1, { timeout: 10000 });
  await expect(caret(ben.page, 'Ada')).toHaveCount(1, { timeout: 10000 });
  const caretInBlock = (p: Page, blockId: string, name: string) =>
    editor(p).locator(`[data-block-id="${blockId}"] .cgw-presence-caret[data-name="${name}"]`);
  await expect(caretInBlock(ada.page, ids[1], 'Ben')).toHaveCount(1);
  await expect(caretInBlock(ben.page, ids[0], 'Ada')).toHaveCount(1);
  // Ben's cursor follows his caret.
  await caretIn(ben.page, ids[0], 'start');
  await expect(caretInBlock(ada.page, ids[0], 'Ben')).toHaveCount(1, { timeout: 10000 });

  // Ben leaves for another page: gone from Ada's page within a few seconds.
  const left = Date.now();
  await openPage(ben.page, 'Elsewhere', 'Another page.');
  await seesOnPage(ada.page, [], 5000);
  await expect(caret(ada.page, 'Ben')).toHaveCount(0);
  const gone = Date.now() - left;
  await expect(
    treeRow(ada.page, 'Elsewhere').getByRole('img', { name: 'Open now by Ben' }),
  ).toBeVisible({ timeout: 5000 });
  await expect(treeRow(ada.page, 'Together').getByTestId('side-presence')).toHaveCount(0);
  testInfo.annotations.push({
    type: 'left',
    description: `Ben gone from Ada's page after ${gone} ms`,
  });
  console.log(`Ben gone from Ada's page after ${gone} ms`);

  // A share link's view of the page: no comments, presence or people.
  await openPage(ben.page, 'Together', 'A second line.');
  await seesOnPage(ada.page, ['Ben']);
  await caretIn(ada.page, ids[1], 'end');
  await ada.page.keyboard.type(' Ask ');
  await ada.page.keyboard.type('@Be');
  await ada.page.getByRole('option', { name: 'Ben', exact: true }).click();
  await ada.page.keyboard.type('please.');
  await expect(blockBody(ada.page, ids[1])).toHaveText('A second line. Ask @Ben please.');
  await select(ada.page, ids[0], 0, 5);
  await ada.page.keyboard.press('Control+Alt+KeyM');
  await ada.page.keyboard.type('A comment readers of the link must not see.');
  await ada.page.keyboard.press('Control+Enter');
  await newestThread(ada.page);
  await waitSaved(ada.page);
  await expect(syncStatus(ada.page)).toHaveText('Synced', { timeout: 30000 });
  await serverHolds(ada.api, pageId, ids[1], 'A second line. Ask @ please.');
  await pageActions(ada.page).click();
  await ada.page.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = ada.page.getByRole('dialog', { name: /Share/ });
  await dialog.getByRole('button', { name: 'Create a view link' }).click();
  const shareLink = (await dialog.getByTestId('share-link').textContent())!.trim();
  await ada.page.keyboard.press('Escape');
  const anonymousContext = await page.context().browser()!.newContext();
  const anonymous = await anonymousContext.newPage();
  const anonymousErrors = watch(anonymous);
  let sockets = 0;
  anonymous.on('websocket', (ws) => HUB.test(ws.url()) && sockets++);
  await anonymous.goto(shareLink);
  await expect(anonymous.getByText('A second line. Ask @')).toBeVisible({ timeout: 20000 });
  await expect(anonymous.getByText('Hello there.')).toBeVisible();
  await sleep(3000);
  for (const testId of ['presence-bar', 'side-presence', 'comments-panel', 'comment'])
    await expect(anonymous.getByTestId(testId)).toHaveCount(0);
  await expect(
    anonymous.locator('.cgw-presence-caret, .cgw-commented, .cgw-commented-pin, .is-commented'),
  ).toHaveCount(0);
  const text = await anonymous.locator('body').innerText();
  expect(text).not.toContain('Ben');
  expect(text).not.toContain('Ada');
  expect(text).not.toContain('A comment readers of the link must not see.');
  expect(sockets).toBe(0);
  await anonymousContext.close();
  expect(anonymousErrors).toEqual([]);
  expect(ada.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
});
