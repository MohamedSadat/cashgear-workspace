// Phase 13 (M13.4, M13.5): search by meaning on this server, and AI on Cash Gear's subscription,
// chosen in Settings → AI, against the e2e stack: its server has the local model's stand-in package
// (tests/fixtures/local-model) and Cash Gear's keys for the mock providers, made at its start and
// kept in memory (scripts/server-stack.mjs), with an allowance of 1,000,000 tokens a month.
//
// What is proven:
//   - a workspace on the subscription uses AI with no key of its own: an owner chooses Cash Gear's
//     subscription, turns AI on with no key, a summary is written, and the month's use is shown
//     against the allowance (the refusal past it is the server's SubscriptionTests);
//   - with the local model, no text leaves the host for embeddings: an owner chooses it, turns search
//     by meaning on with no key, a page is found by a question, and the mock Voyage provider is sent
//     nothing meanwhile.
import type { Page } from '@playwright/test';
import { expect, test, desktop } from './fixtures';
import { waitSaved } from './helpers';
import { pageActions, team, type Team } from './collab';
import { MOCK_AI, mockEmbeddings, paletteSearch, writePage } from './meaning';

test.skip(desktop, 'Settings and the panel are the web build’s; the desktop’s are the same code');

let current: Team | null = null;
test.afterEach(async () => {
  await current?.close();
  current = null;
});

const aiSettings = (page: Page) => page.getByTestId('ai-settings');
const panel = (page: Page) => page.getByTestId('ai-panel');
const providerRequests = async () =>
  (
    (await (await fetch(`${MOCK_AI}/__mock/requests`)).json()) as {
      requests: { action: string | null }[];
    }
  ).requests;

test('a workspace on Cash Gear’s subscription uses AI with no key of its own, its use shown against the allowance', async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  await fetch(`${MOCK_AI}/__mock/reset`, { method: 'POST' });
  current = await team(page, browser, ['Plan owner'], { workspace: 'Plan space' });

  await page.goto('/#/settings/ai');
  const settings = aiSettings(page);
  await expect(settings.getByTestId('ai-key-source')).toBeVisible({ timeout: 30000 });
  await settings
    .getByTestId('ai-key-source')
    .getByRole('radio', { name: 'Cash Gear’s subscription', exact: true })
    .check();
  await expect(settings.getByTestId('ai-allowance')).toHaveText(
    'This month: 0 of 1,000,000 tokens used.',
    { timeout: 30000 },
  );
  // No key field on the subscription; AI turned on with no key of the workspace's own.
  await expect(settings.getByLabel('Anthropic API key')).toHaveCount(0);
  const on = settings.getByRole('checkbox', { name: 'Turn AI on for this workspace' });
  await on.check();
  await expect(on).toBeChecked();
  await expect(settings.getByRole('status')).toHaveText('Saved.');

  // A summary of a page, written with Cash Gear's key.
  await writePage(page, 'Quarter close', [
    'The quarterly close is due on Friday, with the invoices.',
  ]);
  await pageActions(page).click();
  await page.getByRole('menuitem', { name: 'AI…' }).click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('radio', { name: 'Summarise this page' }).check();
  await panel(page).getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Insert at the top' })).toBeVisible({
    timeout: 30000,
  });
  expect((await providerRequests()).filter((r) => r.action === 'summarise')).toHaveLength(1);

  // The month's use, counted against the allowance.
  await page.goto('/#/settings/ai');
  await expect(aiSettings(page).getByTestId('ai-allowance')).toHaveText(
    /^This month: [1-9][\d,]* of 1,000,000 tokens used\.$/,
    { timeout: 30000 },
  );
  for (const person of [current.owner]) expect(person.errors).toEqual([]);
});

test('search by meaning on this server: no key, and no text leaves the host for embeddings', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  await mockEmbeddings.reset();
  current = await team(page, browser, ['Local owner'], { workspace: 'Local space' });
  const before = (await mockEmbeddings.calls()).length;

  await page.goto('/#/settings/ai');
  const embeddings = page.getByTestId('embeddings-settings');
  await expect(embeddings.getByTestId('embeddings-source')).toBeVisible({ timeout: 30000 });
  await embeddings.getByRole('radio', { name: 'On this server (voyage-4-nano)' }).check();
  await expect(embeddings.getByTestId('embeddings-local')).toHaveText(
    'Pages are embedded on this server: no text leaves it for search by meaning. Choosing it embeds every page again.',
    { timeout: 30000 },
  );
  // No key, no model to choose: on as it is.
  await expect(embeddings.getByLabel('Voyage AI API key')).toHaveCount(0);
  const on = embeddings.getByRole('checkbox', {
    name: 'Turn search by meaning on for this workspace',
  });
  await on.check();
  await expect(on).toBeChecked({ timeout: 30000 });

  // A page, embedded on this server, found by a question sharing its words (the stand-in reads bytes).
  await writePage(page, 'Courier delivery schedule', [
    'Parcels leave the warehouse every morning by courier.',
  ]);
  await waitSaved(page);
  await page.goto('/#/settings/ai');
  await expect(embeddings.getByTestId('embeddings-progress')).toHaveText(
    /^Pages ready for search by meaning: (\d+) of \1\.$/,
    { timeout: 120000 },
  );
  const palette = await paletteSearch(page, 'courier delivery parcels warehouse');
  await expect(
    palette.getByRole('option', { name: /Courier delivery schedule/ }).first(),
  ).toBeVisible({
    timeout: 30000,
  });
  await page.keyboard.press('Escape');

  // Nothing went to Voyage AI: not the page, not the question.
  expect((await mockEmbeddings.calls()).length).toBe(before);
  for (const person of [current.owner]) expect(person.errors).toEqual([]);
});
