// Phase 7's AI in Chrome and Edge, against the server stack with its API pointed at the mock
// provider (tests/mocks/ai, `Ai__AnthropicBaseUrl`): with AI off, no AI control is shown and no
// request leaves for any provider, even when asked directly; with it on, each action's request to
// the provider holds only what that action needs, the answer enters the page only on Accept and
// Undo takes it back, and the key is never shown again; ask cites only pages the person can read;
// the ERP prepare fills a block's pending changes and nothing reaches Cash Gear ERP's Commit.
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { pageId } from './database';
import { pageActions, restrict, team, type Team } from './collab';
import {
  chooseConnector,
  connectErp,
  erpBlock,
  insertErpBlock,
  linkWorkspace,
  mockErp,
  searchHits,
} from './ecosystem';

test.skip(desktop, 'Two people in browser profiles of their own, and the mock provider');

/** The mock provider (tests/mocks/ai): what it was sent, never the key (only its hash). */
const MOCK_AI = process.env.CGW_MOCK_AI_URL ?? 'http://127.0.0.1:4286';
interface ProviderRequest {
  action: string | null;
  keyId: string | null;
  body: { model: string; system?: unknown; messages: { role: string; content: unknown }[] };
}
const mockAi = {
  reset: async () => void (await fetch(`${MOCK_AI}/__mock/reset`, { method: 'POST' })),
  requests: async () =>
    ((await (await fetch(`${MOCK_AI}/__mock/requests`)).json()) as { requests: ProviderRequest[] })
      .requests,
};
const userText = (request: ProviderRequest) =>
  request.body.messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as { type: string; text?: string }[]).map((b) => b.text ?? '').join('\n'),
    )
    .join('\n');
const lastOf = async (action: string) => {
  const all = (await mockAi.requests()).filter((r) => r.action === action);
  expect(all.length, `a ${action} request`).toBeGreaterThan(0);
  return all.at(-1)!;
};

const KEY = 'sk-mock-phase7-workspace-key-0001';

let current: Team | null = null;
test.beforeEach(async () => mockAi.reset());
test.afterEach(async () => {
  await current?.close();
  current = null;
});

const panel = (page: Page) => page.getByTestId('ai-panel');

/** Turns AI on for the workspace through the API, as an owner would in Settings. */
async function aiOn(t: Team) {
  await t.owner.api.put(`/api/v1/workspaces/${t.workspaceId}/ai-settings`, { apiKey: KEY });
  await t.owner.api.put(`/api/v1/workspaces/${t.workspaceId}/ai-settings`, { enabled: true });
}

/** Text typed into a new page, the last `select` characters selected. */
async function pageWith(page: Page, title: string, lines: string[], select = 0) {
  await newPage(page, title);
  await editor(page).click();
  for (const [index, line] of lines.entries()) {
    if (index) await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
  await waitSaved(page);
  for (let i = 0; i < select; i++) await page.keyboard.press('Shift+ArrowLeft');
}

async function ask(page: Page, action: string, fill?: { label: string; text: string }) {
  await panel(page).getByRole('radio', { name: action }).check();
  if (fill) await panel(page).getByLabel(fill.label).fill(fill.text);
  await panel(page).getByRole('button', { name: 'Ask', exact: true }).click();
}

async function openAiFromMenu(page: Page) {
  await pageActions(page).click();
  await page.getByRole('menuitem', { name: 'AI…' }).click();
  await expect(panel(page)).toBeVisible();
}

test('with AI off, no AI control is shown and no request leaves for any provider', async ({
  page,
  browser,
}) => {
  current = await team(page, browser, ['Ada']);
  await pageWith(page, 'Plain page', ['alpha beta gamma'], 5);
  await expect(page.locator('.cgw-bubble')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask AI' })).toHaveCount(0);
  await pageActions(page).click();
  await expect(page.getByRole('menuitem', { name: 'AI…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Asked directly, with the person's own session, the server refuses before building anything.
  const refused = await page.evaluate(
    async ({ workspaceId, pageId: id }) => {
      const api = 'http://127.0.0.1:5280';
      const csrf = (await (
        await fetch(`${api}/api/v1/account/antiforgery`, { credentials: 'include' })
      ).json()) as { token: string };
      const answer = await fetch(`${api}/api/v1/ai/complete`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf.token },
        body: JSON.stringify({
          workspaceId,
          action: 'summarise',
          pageId: id,
          language: 'en',
          input: { text: 'alpha beta gamma' },
        }),
      });
      return { status: answer.status, body: (await answer.json()) as { code?: string } };
    },
    { workspaceId: current.workspaceId, pageId: pageId(page) },
  );
  expect(refused).toMatchObject({ status: 403, body: { code: 'ai.disabled' } });
  expect(await mockAi.requests()).toEqual([]);
});

test('on, each action sends only what it needs, and its answer enters only on Accept', async ({
  page,
  browser,
}) => {
  current = await team(page, browser, ['Ada']);
  // Settings: the key goes once and is never shown again.
  await page.goto('/#/settings');
  const settings = page.getByTestId('ai-settings');
  await expect(settings).toContainText('No key is set.');
  await settings.getByLabel('Anthropic API key').fill(KEY);
  await settings.getByRole('button', { name: 'Save the key' }).click();
  await expect(settings.getByTestId('ai-key-state')).toContainText('A key is set');
  await expect(settings.getByLabel('Anthropic API key')).toHaveValue('');
  await settings.getByLabel('Turn AI on for this workspace').check();
  await expect(settings.getByLabel('Turn AI on for this workspace')).toBeChecked();
  const read = JSON.stringify(
    await current.owner.api.get(`/api/v1/workspaces/${current.workspaceId}/ai-settings`),
  );
  expect(read).not.toContain(KEY);
  expect(read).not.toContain(KEY.slice(-8));

  await pageWith(page, 'Working notes', ['alpha beta gamma', 'TODO call Laila', 'delta'], 0);
  // Rewrite: the selection alone goes.
  await editor(page).getByText('alpha beta gamma').click();
  await page.keyboard.press('End');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.getByRole('button', { name: 'Ask AI' }).click();
  await expect(panel(page).getByTestId('ai-selection')).toHaveText('gamma');
  await panel(page).getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Replace the selection' })).toBeVisible();
  const rewrite = await lastOf('rewrite');
  expect(userText(rewrite)).toContain('gamma');
  expect(userText(rewrite)).not.toContain('alpha');
  expect(userText(rewrite)).not.toContain('Laila');
  expect(rewrite.keyId).not.toBeNull();
  expect(JSON.stringify(rewrite)).not.toContain(KEY);
  // Not in the page until Accept; then one edit Undo takes back.
  await expect(editor(page)).not.toContainText('[rewritten]');
  await panel(page).getByRole('button', { name: 'Replace the selection' }).click();
  await expect(editor(page)).toContainText('alpha beta [rewritten] gamma');
  await editor(page).click();
  await page.keyboard.press('Control+KeyZ');
  await expect(editor(page)).not.toContainText('[rewritten]');
  await expect(editor(page)).toContainText('alpha beta gamma');

  // Summarise: the page's text (and title) go; the summary goes to the top on Accept.
  await openAiFromMenu(page);
  await ask(page, 'Summarise this page');
  await expect(panel(page).getByRole('button', { name: 'Insert at the top' })).toBeVisible();
  const summary = await lastOf('summarise');
  expect(userText(summary)).toContain('Working notes');
  expect(userText(summary)).toContain('TODO call Laila');
  await expect(editor(page)).not.toContainText('Summary:');
  await panel(page).getByRole('button', { name: 'Insert at the top' }).click();
  await expect(editor(page).locator('.cgw-text').first()).toContainText('Summary:');

  // Action items, as to-dos.
  await ask(page, 'Find action items');
  await panel(page).getByRole('button', { name: 'Add as to-dos' }).click();
  await expect(editor(page).getByRole('checkbox')).toHaveCount(1);
  await expect(editor(page)).toContainText('call Laila');

  // A database, previewed, then made under the page with a block showing it.
  await ask(page, 'Make a database', { label: 'What should the database hold?', text: 'Tasks' });
  await expect(panel(page).getByTestId('ai-database')).toContainText('First task');
  // A database is made from the prompt alone: none of the page's text goes with it.
  const database = await lastOf('generateDatabase');
  expect(userText(database)).toContain('Tasks');
  expect(userText(database)).not.toContain('Laila');
  await panel(page).getByRole('button', { name: 'Create the database' }).click();
  await expect(editor(page).locator('.cgw-db')).toContainText('First task', { timeout: 30000 });

  // A new page under this one, opened.
  const from = pageId(page);
  await ask(page, 'Write a new page', {
    label: 'What should the page be about?',
    text: 'Launch checklist',
  });
  await panel(page).getByRole('button', { name: 'Create the page' }).click();
  await expect.poll(() => pageId(page)).not.toBe(from);
  await expect(page.getByLabel('Page title')).toHaveValue('Launch checklist');
  await expect(editor(page)).toContainText('First point');
});

test('ask cites only pages the person can read, and sends no other page', async ({
  page,
  browser,
}) => {
  current = await team(page, browser, ['Ada', 'Ben']);
  await aiOn(current);
  await pageWith(page, 'Zephyr plan', ['The Zephyr budget is approved.']);
  const open = pageId(page);
  await pageWith(page, 'Zephyr secret', ['The Zephyr salaries are private.']);
  await restrict(current, pageId(page), []);
  // The server's search finds both for the owner once the worker has indexed them.
  await expect
    .poll(
      async () => (await searchHits(current!.owner.api, current!.workspaceId, 'Zephyr')).length,
      {
        timeout: 30000,
      },
    )
    .toBe(2);
  const ben = current.members[0];
  await ben.page.goto(`/#/p/${open}`);
  await expect(editor(ben.page)).toContainText('Zephyr budget', { timeout: 30000 });
  await openAiFromMenu(ben.page);
  await ask(ben.page, 'Ask the workspace', { label: 'Your question', text: 'Zephyr' });
  const sources = panel(ben.page).locator('.cgw-ai-sources');
  await expect(sources.getByRole('link', { name: 'Zephyr plan' })).toBeVisible();
  await expect(sources).not.toContainText('Zephyr secret');
  const asked = await lastOf('ask');
  expect(userText(asked)).toContain('Zephyr plan');
  expect(userText(asked)).not.toContain('Zephyr secret');
  expect(userText(asked)).not.toContain('salaries');
  // Inserted on Accept, with the sources named as mentions.
  await ben.page.getByRole('button', { name: 'Insert the answer' }).click();
  await expect(editor(ben.page)).toContainText('The pages say so');
});

test('the ERP prepare fills pending changes, and nothing reaches Commit', async ({
  page,
  browser,
}) => {
  current = await team(page, browser, ['Ada']);
  await aiOn(current);
  await mockErp.reset();
  await linkWorkspace(current.owner.api, current.workspaceId, 'Team space');
  await page.reload();
  await newPage(page, 'Vendor clean-up');
  await editor(page).click();
  await insertErpBlock(page);
  const block = erpBlock(page);
  // gina holds Vendors' Edit in the mock ERP (alice only views).
  await connectErp(page, block, 'gina');
  await chooseConnector(block, 'Vendors');
  await block.getByRole('button', { name: 'Edit data' }).click();
  await block.getByRole('button', { name: 'Prepare changes with AI' }).click();
  await block.getByLabel('What should change?').fill('Mark every name as checked by AI');
  await block.getByRole('button', { name: 'Prepare', exact: true }).click();
  await expect(block.getByTestId('erp-ai-status')).toContainText('AI prepared changes');
  await expect(block.getByText('Prepared by AI').first()).toBeVisible();
  const prepared = await lastOf('erpChanges');
  expect(userText(prepared)).toContain('vendors');
  // Proposals only: the ERP saw no commit, not even a dry run's stored commit.
  expect((await mockErp.audit()).commits).toBe(0);
  expect((await mockErp.audit()).audit).toEqual([]);
  await block.getByRole('button', { name: 'Discard changes' }).click();
});
