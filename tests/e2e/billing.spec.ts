// Phase 18 (M18.2): Cash Gear's AI subscription paid through Paddle, against the e2e stack and the
// mock Paddle (tests/mocks/paddle, port 4291, its webhooks to the stack's API; two plans of its
// catalogue, Starter at 9.00 and Team at 29.00 USD a month: scripts/server-stack.mjs).
//
// What is proven:
//   - an owner subscribes in Paddle's checkout, opened from Settings → AI on the Sites process's pay
//     page (the mock's stand-in for Paddle.js over it), and the workspace's plan and its allowance
//     follow within a minute of paying (the budget: webhook to the allowance shown, 60 s), with no
//     card or payment detail ever reaching the app;
//   - Paddle's portal cancels at the period's end: the plan holds, Settings says until when, and ends
//     when the period does; a renewal that fails keeps the plan while Paddle retries and ends it when
//     the retries end;
//   - the plan's part of Settings under Axe and in Arabic.
import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test, desktop } from './fixtures';
import { team, type Team } from './collab';
import { englishIn } from './erp12';

test.skip(desktop, 'Settings is the web build’s; the desktop opens the same links in its browser');

const PADDLE = process.env.CGW_MOCK_PADDLE_URL ?? 'http://127.0.0.1:4291';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let current: Team | null = null;
test.afterEach(async () => {
  await current?.close();
  current = null;
});

const billing = (page: Page) => page.getByTestId('billing');
const control = async (name: string, body: object = {}) =>
  (await fetch(`${PADDLE}/__mock/${name}`, { method: 'POST', body: JSON.stringify(body) })).json();
const subscriptions = async () =>
  (
    (await (await fetch(`${PADDLE}/__mock/state`)).json()) as {
      subscriptions: { id: string; status: string; custom_data: { cgwWorkspaceId: string } }[];
    }
  ).subscriptions;

/** The plan's part of Settings → AI, once it has read the plans. */
async function openPlans(page: Page) {
  await page.goto('/#/settings/ai');
  await expect(billing(page).locator('[data-plan="team"]')).toBeVisible({ timeout: 30_000 });
}

/** Subscribes in the checkout's tab and pays; the time the pay button was pressed. */
async function subscribe(page: Page, context: BrowserContext, plan: string) {
  const opened = context.waitForEvent('page');
  await billing(page)
    .getByRole('button', { name: `Subscribe to ${plan}` })
    .click();
  const checkout = await opened;
  await checkout.waitForURL(/localhost:5290\/_pay\/en\?_ptxn=txn_/, { timeout: 30_000 });
  const frame = checkout.frameLocator('iframe[title="Paddle checkout"]');
  await expect(frame.getByRole('button', { name: 'Pay', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const paidAt = Date.now();
  await frame.getByRole('button', { name: 'Pay', exact: true }).click();
  await expect(checkout.getByRole('status')).toHaveText(/^Payment received\./, { timeout: 30_000 });
  // The pay page is on the Sites origin: no cookie, nothing of the person's.
  expect(await checkout.context().cookies('http://localhost:5290')).toEqual([]);
  await checkout.close();
  return paidAt;
}

test('an owner subscribes in Paddle’s checkout and the plan and its allowance follow within a minute', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await control('reset');
  current = await team(page, browser, ['Billing owner'], { workspace: 'Billing space' });
  await openPlans(page);
  const plans = billing(page);
  await expect(plans.getByTestId('billing-plan')).toHaveText('The workspace is on no paid plan.');
  await expect(plans.locator('[data-plan="starter"]')).toContainText('$9.00 a month');
  await expect(plans.locator('[data-plan="team"]')).toContainText('$29.00 a month');
  await expect(plans.locator('[data-plan="team"]')).toContainText(
    '10,000,000 tokens a month for AI, 10,000,000 for search by meaning',
  );

  const paidAt = await subscribe(page, page.context(), 'Team');
  await expect(plans.getByTestId('billing-plan')).toHaveText(
    /^The workspace is on the Team plan\. Paid until /,
    { timeout: 60_000 },
  );
  const shownMs = Date.now() - paidAt;
  console.log(`billing: paid to plan shown ${shownMs} ms`);
  expect(shownMs).toBeLessThan(60_000);
  // The allowance follows the plan.
  await page
    .getByTestId('ai-key-source')
    .getByRole('radio', { name: 'Cash Gear’s subscription' })
    .check();
  await expect(page.getByTestId('ai-allowance')).toHaveText(
    'This month: 0 of 10,000,000 tokens used.',
    { timeout: 30_000 },
  );

  // The subscription carries the workspace's id; the app holds none of the payment.
  const [subscription] = await subscriptions();
  expect(subscription.custom_data.cgwWorkspaceId).toBe(current.workspaceId);
  expect(subscription.status).toBe('active');

  // Paddle's portal: cancelled at the period's end, the plan holds, then ends with the period.
  const portal = page.context().waitForEvent('page');
  await plans.getByTestId('billing-manage').click();
  const opened = await portal;
  await expect(opened.getByRole('heading', { name: 'Mock Paddle portal' })).toBeVisible({
    timeout: 30_000,
  });
  await opened.getByRole('button', { name: 'Cancel at the end of the period' }).click();
  await expect(opened.getByRole('status')).toHaveText('Done.');
  await opened.close();
  await page.reload();
  await expect(plans.getByTestId('billing-plan')).toHaveText(
    /^The workspace is on the Team plan\. It ends on .+: it was cancelled\.$/,
    { timeout: 60_000 },
  );
  await control('periodEnd', { subscriptionId: subscription.id });
  await expect
    .poll(
      async () => {
        await page.reload();
        return billing(page).getByTestId('billing-plan').textContent({ timeout: 30_000 });
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe('The workspace is on no paid plan.');
  expect(current.owner.errors).toEqual([]);
});

test('a failed payment keeps the plan while Paddle retries and ends it when the retries end', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await control('reset');
  current = await team(page, browser, ['Dunning owner'], { workspace: 'Dunning space' });
  await openPlans(page);
  await subscribe(page, page.context(), 'Starter');
  await expect(billing(page).getByTestId('billing-plan')).toHaveText(
    /^The workspace is on the Starter plan\./,
    { timeout: 60_000 },
  );
  const [subscription] = await subscriptions();
  await control('renew', { subscriptionId: subscription.id, fail: true });
  await page.reload();
  await expect(billing(page).getByTestId('billing-past-due')).toHaveText(
    'A payment failed. Paddle is trying again; the plan holds meanwhile.',
    { timeout: 60_000 },
  );
  await expect(billing(page).getByTestId('billing-plan')).toHaveText(
    /^The workspace is on the Starter plan\./,
  );
  await control('dunning', { subscriptionId: subscription.id, outcome: 'canceled' });
  await expect
    .poll(
      async () => {
        await page.reload();
        return billing(page).getByTestId('billing-plan').textContent({ timeout: 30_000 });
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe('The workspace is on no paid plan.');
  expect(current.owner.errors).toEqual([]);
});

test('the plan’s part of Settings under Axe and in Arabic', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await control('reset');
  current = await team(page, browser, ['Billing reader'], { workspace: 'Billing words' });
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await openPlans(page);
  const plans = billing(page);
  await expect(plans.getByTestId('billing-plan')).toHaveText('مساحة العمل ليست على خطة مدفوعة.');
  await expect(plans.getByRole('button', { name: 'اشترك في الفريق' })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include('[data-testid="billing"]').withTags(WCAG).analyze())
      .violations,
  ).toEqual([]);
  // Paddle's name is theirs; everything else is the app's, in Arabic, the currency by its name.
  await expect(plans.locator('[data-plan="team"]')).toContainText('دولار أمريكي');
  expect(
    await englishIn(plans, 'the plans', { within: ['input', 'select'], names: ['Paddle'] }),
  ).toEqual([]);
  expect(current.owner.errors).toEqual([]);
});
