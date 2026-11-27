// Phase 10's search by meaning (IMPLEMENTATION_PLAN.md, Phase 10, M10.2 and M10.3) in Chrome and
// Edge, against the server stack with its API and worker pointed at the mock providers
// (tests/mocks/ai: Anthropic's Messages API and Voyage AI's embeddings, `Ai__VoyageBaseUrl`):
//   - Settings: an owner sets the Voyage AI key (never shown again) and turns search by meaning on,
//     while AI's completions stay off; the pages are embedded and the progress says so;
//   - the palette finds a page from a question that shares none of its words, in English, in Arabic
//     and across the two, under "Related by meaning", and `ask` cites it; never a page the person
//     cannot read;
//   - a page restricted or trashed stops counting at once;
//   - with search by meaning off, the embeddings provider receives nothing, the route refuses, and
//     turning it off again sends nothing more.
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor } from './helpers';
import { pageActions, restrict, team, type Team } from './collab';
import {
  ANTHROPIC_KEY,
  MEANING,
  MOCK_AI,
  QUESTIONS,
  VOYAGE_KEY,
  embeddingsOn,
  meaningGroup,
  meaningTitles,
  mockEmbeddings,
  paletteSearch,
  untilMeaningFinds,
  untilTrashedOnServer,
  writePage,
} from './meaning';

test.skip(desktop, 'Two people in browser profiles of their own, and the mock providers');

let current: Team | null = null;
test.beforeEach(async () => mockEmbeddings.reset());
test.afterEach(async () => {
  await current?.close();
  current = null;
});

const option = (page: Page, title: string, language: 'en' | 'ar' = 'en') =>
  meaningGroup(page, language).getByRole('option', { name: new RegExp(title) });

/** What the mock Anthropic provider was last asked for `ask`, as text. */
async function lastAsk() {
  const requests = (
    (await (await fetch(`${MOCK_AI}/__mock/requests?action=ask`)).json()) as {
      requests: { body: { messages: { role: string; content: unknown }[] } }[];
    }
  ).requests;
  expect(requests.length, 'an ask request').toBeGreaterThan(0);
  return JSON.stringify(requests.at(-1)!.body.messages);
}

test('on, the palette and ask find pages by meaning, in English, in Arabic and across the two, and never one the person cannot read', async ({
  page,
  browser,
}) => {
  test.setTimeout(600000);
  current = await team(page, browser, ['Ada', 'Ben']);
  const t = current;
  const refunds = await writePage(page, MEANING.refunds.title, [MEANING.refunds.text]);
  await writePage(page, MEANING.leave.title, [MEANING.leave.text]);
  const hidden = await writePage(page, MEANING.hidden.title, [MEANING.hidden.text]);
  await writePage(page, MEANING.other.title, [MEANING.other.text]);
  await restrict(t, hidden, []);

  // Settings, as the owner: the key goes once and is never shown again; AI's completions stay off.
  await page.goto('/#/settings/ai');
  const settings = page.getByTestId('embeddings-settings');
  await expect(settings.getByTestId('embeddings-key-state')).toHaveText('No key is set.');
  await settings.getByLabel('Voyage AI API key').fill(VOYAGE_KEY);
  await settings.getByRole('button', { name: 'Save the Voyage AI key' }).click();
  await expect(settings.getByTestId('embeddings-key-state')).toContainText('A key is set');
  await expect(settings.getByLabel('Voyage AI API key')).toHaveValue('');
  await settings.getByLabel('Turn search by meaning on for this workspace').check();
  await expect(settings.getByLabel('Turn search by meaning on for this workspace')).toBeChecked();
  await expect(
    page.getByTestId('ai-settings').getByLabel('Turn AI on for this workspace'),
  ).not.toBeChecked();
  const read = JSON.stringify(
    await t.owner.api.get(`/api/v1/workspaces/${t.workspaceId}/ai-settings`),
  );
  expect(read).not.toContain(VOYAGE_KEY);
  expect(read).not.toContain(VOYAGE_KEY.slice(-8));
  // The worker embeds the pages as documents with the workspace's key; the progress says so.
  await untilMeaningFinds(t.owner.api, t.workspaceId, QUESTIONS.en, MEANING.refunds.title);
  await page.reload();
  await expect(page.getByTestId('embeddings-progress')).toContainText('Pages ready for search', {
    timeout: 60000,
  });
  const calls = await mockEmbeddings.calls();
  expect(calls.some((c) => c.inputType === 'document')).toBe(true);
  for (const call of calls) {
    expect(call.keyId).not.toBeNull();
    expect(call.outputDtype).toBe('int8');
    expect(JSON.stringify(call)).not.toContain(VOYAGE_KEY);
  }

  // Ben, a member: each question shares no word with the page it finds.
  const ben = t.members[0]!;
  await ben.page.goto(`/#/p/${refunds}`);
  await expect(editor(ben.page)).toContainText(MEANING.refunds.text, { timeout: 30000 });
  for (const [q, title] of [
    [QUESTIONS.en, MEANING.refunds.title],
    [QUESTIONS.ar, MEANING.leave.title],
    [QUESTIONS.enToAr, MEANING.leave.title],
    [QUESTIONS.arToEn, MEANING.refunds.title],
  ] as const) {
    const palette = await paletteSearch(ben.page, q);
    await expect(option(ben.page, title), q).toBeVisible({ timeout: 30000 });
    // Marked for a screen reader, and never the page he cannot read nor an unrelated one.
    await expect(option(ben.page, title)).toContainText('Found by meaning');
    await expect(palette).not.toContainText(MEANING.hidden.title);
    await expect(palette).not.toContainText(MEANING.other.title);
    await ben.page.keyboard.press('Escape');
  }
  const asked = await meaningTitles(ben.api, t.workspaceId, QUESTIONS.en);
  expect(asked.titles).toContain(MEANING.refunds.title);
  expect(asked.titles).not.toContain(MEANING.hidden.title);
  // The owner may read the restricted page: it is found for her.
  expect((await meaningTitles(t.owner.api, t.workspaceId, QUESTIONS.en)).titles).toContain(
    MEANING.hidden.title,
  );

  // Ask, with AI's completions on too: its sources are the word search's and the meaning
  // search's, and only what Ben may read.
  await t.owner.api.put(`/api/v1/workspaces/${t.workspaceId}/ai-settings`, {
    apiKey: ANTHROPIC_KEY,
  });
  await t.owner.api.put(`/api/v1/workspaces/${t.workspaceId}/ai-settings`, { enabled: true });
  await ben.page.reload();
  await expect(editor(ben.page)).toContainText(MEANING.refunds.text, { timeout: 30000 });
  await pageActions(ben.page).click();
  await ben.page.getByRole('menuitem', { name: 'AI…' }).click();
  const panel = ben.page.getByTestId('ai-panel');
  await panel.getByRole('radio', { name: 'Ask the workspace' }).check();
  await panel.getByLabel('Your question').fill(QUESTIONS.arToEn);
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  const sources = panel.locator('.cgw-ai-sources');
  await expect(sources.getByRole('link', { name: MEANING.refunds.title })).toBeVisible({
    timeout: 30000,
  });
  await expect(sources).not.toContainText(MEANING.hidden.title);
  const sent = await lastAsk();
  expect(sent).toContain(MEANING.refunds.title);
  expect(sent).not.toContain(MEANING.hidden.title);
  expect(sent).not.toContain('the board');
  expect(ben.errors).toEqual([]);
  expect(t.owner.errors).toEqual([]);
});

test('a page restricted or trashed stops counting at once', async ({ page, browser }) => {
  test.setTimeout(600000);
  current = await team(page, browser, ['Ada', 'Ben']);
  const t = current;
  const refunds = await writePage(page, MEANING.refunds.title, [MEANING.refunds.text]);
  const leave = await writePage(page, MEANING.leave.title, [MEANING.leave.text]);
  await embeddingsOn(t.owner.api, t.workspaceId);
  const ben = t.members[0]!;
  await untilMeaningFinds(ben.api, t.workspaceId, QUESTIONS.en, MEANING.refunds.title);
  await untilMeaningFinds(ben.api, t.workspaceId, QUESTIONS.ar, MEANING.leave.title);

  // Restricted to the owner: the next question no longer finds it for Ben, with no wait for the
  // worker (the check is the same as word search's, at query time).
  await restrict(t, refunds, []);
  expect((await meaningTitles(ben.api, t.workspaceId, QUESTIONS.en)).titles).not.toContain(
    MEANING.refunds.title,
  );
  expect((await meaningTitles(t.owner.api, t.workspaceId, QUESTIONS.en)).titles).toContain(
    MEANING.refunds.title,
  );

  // Trashed by its owner: gone for everyone at once.
  await page.goto(`/#/p/${leave}`);
  await expect(editor(page)).toContainText(MEANING.leave.text, { timeout: 30000 });
  await pageActions(page).click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await untilTrashedOnServer(t.owner.api, t.workspaceId, leave);
  for (const api of [ben.api, t.owner.api]) {
    expect((await meaningTitles(api, t.workspaceId, QUESTIONS.ar)).titles).not.toContain(
      MEANING.leave.title,
    );
  }
  // Nor does the palette show it.
  await ben.page.reload();
  const palette = await paletteSearch(ben.page, QUESTIONS.ar);
  await ben.page.waitForTimeout(1500);
  await expect(palette).not.toContainText(MEANING.leave.title);
  expect(ben.errors).toEqual([]);
});

test('off, the embeddings provider receives nothing, the route refuses, and turning it off sends nothing more', async ({
  page,
  browser,
}) => {
  test.setTimeout(600000);
  current = await team(page, browser, ['Ada'], {
    // The meaning route's refusal while off, which the test asks for itself.
    allowed: [/status of 403 .*\/search\/meaning/],
  });
  const t = current;
  // AI's completions on, search by meaning off (as every workspace starts).
  await t.owner.api.put(`/api/v1/workspaces/${t.workspaceId}/ai-settings`, {
    apiKey: ANTHROPIC_KEY,
  });
  await t.owner.api.put(`/api/v1/workspaces/${t.workspaceId}/ai-settings`, { enabled: true });
  await writePage(page, MEANING.refunds.title, [MEANING.refunds.text]);
  await page.reload();
  await expect(editor(page)).toContainText(MEANING.refunds.text, { timeout: 30000 });
  // The palette asks nothing by meaning; ask answers from word search alone.
  const palette = await paletteSearch(page, QUESTIONS.en);
  await page.waitForTimeout(1500);
  await expect(meaningGroup(page)).toHaveCount(0);
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await pageActions(page).click();
  await page.getByRole('menuitem', { name: 'AI…' }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.getByRole('radio', { name: 'Ask the workspace' }).check();
  await panel.getByLabel('Your question').fill(QUESTIONS.en);
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(panel.locator('.cgw-ai-sources, .cgw-ai-text').first()).toBeVisible({
    timeout: 30000,
  });
  const refused = await t.owner.api.raw(
    `/api/v1/workspaces/${t.workspaceId}/search/meaning?q=${encodeURIComponent(QUESTIONS.en)}`,
  );
  expect(refused.status).toBe(403);
  expect(JSON.parse(refused.body)).toMatchObject({ code: 'ai.disabled' });
  // Some seconds for a worker that would embed: nothing left for the provider.
  await page.waitForTimeout(5000);
  expect(await mockEmbeddings.calls()).toEqual([]);

  // On, embedded, then off: the vectors go and nothing more is sent.
  await embeddingsOn(t.owner.api, t.workspaceId);
  await untilMeaningFinds(t.owner.api, t.workspaceId, QUESTIONS.en, MEANING.refunds.title);
  await t.owner.api.put(`/api/v1/workspaces/${t.workspaceId}/ai-settings`, {
    embeddings: { enabled: false },
  });
  const sentWhileOn = (await mockEmbeddings.calls()).length;
  await writePage(page, 'Later refund notes', ['Buyers asked to be reimbursed for damaged items.']);
  await page.waitForTimeout(5000);
  expect((await mockEmbeddings.calls()).length).toBe(sentWhileOn);
  expect(
    (await meaningTitles(t.owner.api, t.workspaceId, QUESTIONS.en)).status,
    'refused while off',
  ).toBe(403);
  expect(t.owner.errors).toEqual([]);
});
