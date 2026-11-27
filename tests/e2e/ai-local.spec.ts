// Phase 18 (M18.1): AI's answers written on this server by its own model, chosen in Settings → AI,
// against the e2e stack: its server has the completion model's stand-in package
// (tests/fixtures/completion-model: GenAI's runtime and guidance over a byte-level vocabulary, its
// answer fixed by its weights: double quotes until its limit, an empty answer of a JSON action's
// shape) (scripts/server-stack.mjs). The real model's answers are the spike's and the bench's.
//
// What is proven:
//   - an owner chooses the server's own model with no key and turns AI on; a summary streams into
//     the panel, in English and then in Arabic, and the mock provider (Anthropic's stand-in) is sent
//     nothing meanwhile;
//   - a JSON action (action items) answers within its schema;
//   - Settings → AI with the server's own model, under Axe and in Arabic.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, desktop } from './fixtures';
import { team, type Team } from './collab';
import { englishIn } from './erp12';
import { MOCK_AI, writePage } from './meaning';

test.skip(desktop, 'Settings and the panel are the web build’s; the desktop’s are the same code');

const MODEL = 'qwen3.5-4b';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let current: Team | null = null;
test.afterEach(async () => {
  await current?.close();
  current = null;
});

const aiSettings = (page: Page) => page.getByTestId('ai-settings');
const panel = (page: Page) => page.getByTestId('ai-panel');
const providerCalls = async () =>
  (
    (await (await fetch(`${MOCK_AI}/__mock/requests`)).json()) as {
      requests: unknown[];
    }
  ).requests.length;

async function chooseLocal(page: Page, label: string) {
  await page.goto('/#/settings/ai');
  const settings = aiSettings(page);
  await expect(settings.getByTestId('ai-key-source')).toBeVisible({ timeout: 30_000 });
  await settings.getByTestId('ai-key-source').getByRole('radio', { name: label }).check();
  await expect(settings.getByTestId('ai-local')).toBeVisible({ timeout: 30_000 });
}

async function ask(page: Page, action: string, button: string) {
  const arabic = button !== 'Ask';
  await page
    .getByRole('region', { name: arabic ? 'الصفحة' : 'Page' })
    .getByRole('button', { name: arabic ? 'إجراءات الصفحة' : 'Page actions' })
    .click();
  await page.getByRole('menuitem', { name: arabic ? 'الذكاء الاصطناعي…' : 'AI…' }).click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('radio', { name: action }).check();
  await panel(page).getByRole('button', { name: button, exact: true }).click();
}

test('AI on the server’s own model: no key, a summary streams in English and in Arabic, and nothing goes to a provider', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await fetch(`${MOCK_AI}/__mock/reset`, { method: 'POST' });
  current = await team(page, browser, ['Local AI owner'], { workspace: 'Local AI space' });
  const calls = await providerCalls();

  await chooseLocal(page, `This server’s own model (${MODEL}): no key`);
  const settings = aiSettings(page);
  await expect(settings.getByTestId('ai-local')).toHaveText(
    'Answers are written on this server: no text leaves it. They take longer than Claude’s, and shorter texts.',
  );
  // No key field and no model to choose.
  await expect(settings.getByLabel('Anthropic API key')).toHaveCount(0);
  const on = settings.getByRole('checkbox', { name: 'Turn AI on for this workspace' });
  await on.check();
  await expect(on).toBeChecked({ timeout: 30_000 });

  await writePage(page, 'Dammam warehouse', [
    'The racking was delivered on time, but the installers can send only two people.',
  ]);
  await ask(page, 'Summarise this page', 'Ask');
  // The stand-in writes until the local model's limit; the answer is shown as it comes.
  await expect(panel(page).getByTestId('ai-answer')).toContainText('""""', { timeout: 60_000 });
  await expect(panel(page).getByRole('button', { name: 'Insert at the top' })).toBeVisible({
    timeout: 60_000,
  });

  // A JSON action: held to its schema while it is written (the stand-in's empty list).
  await panel(page).getByRole('button', { name: 'Discard' }).click();
  await panel(page).getByRole('radio', { name: 'Find action items' }).check();
  await panel(page).getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(panel(page).getByTestId('ai-answer')).toBeVisible({ timeout: 60_000 });
  await expect(panel(page).getByTestId('ai-answer').getByRole('alert')).toHaveCount(0);

  // In Arabic: the same page, the summary again.
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await ask(page, 'تلخيص هذه الصفحة', 'اسأل');
  await expect(panel(page).getByTestId('ai-answer')).toContainText('""""', { timeout: 60_000 });

  // Nothing went to any provider meanwhile.
  expect(await providerCalls()).toBe(calls);
  expect(current.owner.errors).toEqual([]);
});

test('Settings → AI with the server’s own model, under Axe and in Arabic', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  current = await team(page, browser, ['Local AI reader'], { workspace: 'Local AI words' });
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await chooseLocal(page, `نموذج هذا الخادم نفسه (${MODEL}): بلا مفتاح`);
  const settings = aiSettings(page);
  expect(
    (await new AxeBuilder({ page }).include('[data-testid="ai-settings"]').withTags(WCAG).analyze())
      .violations,
  ).toEqual([]);
  // The model's and the providers' names are theirs; everything else is the app's, in Arabic.
  expect(
    await englishIn(settings, 'Settings → AI', {
      within: ['input', 'select'],
      names: [
        MODEL,
        'Anthropic',
        'Claude',
        'Voyage AI',
        'voyage-4-nano',
        'Local AI words',
        'Paddle',
      ],
    }),
  ).toEqual([]);
  expect(current.owner.errors).toEqual([]);
});
