// Phase 11 (M11.2): passkeys in Chrome and Edge, through the browsers' own WebAuthn testing domain
// (a virtual authenticator over CDP: `WebAuthn.enable`, `WebAuthn.addVirtualAuthenticator`),
// against the app built for `localhost` (scripts/web-localhost.mjs: the app on
// http://localhost:4268, its API the e2e stack's one process under its other name,
// http://localhost:5280). WebAuthn takes no IP address as its relying party, and the rest of the
// run is on 127.0.0.1 for Phase 2's cookies: a session made here is one of its own.
//
// Every ceremony runs on the API's own pages (AccountPages, /account/passkey.js); the server's
// refusals (another origin or relying party, a challenge used twice, a counter going back, another
// account's passkey) are PasskeyTests', through a software authenticator. Here: a real browser's
// ceremony end to end, the autofill's field, and the pages under Axe in English and Arabic.
//
// Needs (phase-11-s2.md): the e2e stack, and `node scripts/web-localhost.mjs --build` then
// `--serve` (Playwright's start list for this spec); then
//   pnpm exec playwright test tests/e2e/passkeys.spec.ts --project chrome --project edge
import AxeBuilder from '@axe-core/playwright';
import type { CDPSession, Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { watchErrors } from './helpers';
import { newAccount, signedIn, type TestAccount } from './cloud';

const APP = process.env.E2E_LOCALHOST_APP ?? 'http://localhost:4268';
const API = process.env.E2E_LOCALHOST_API ?? 'http://localhost:5280';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const REFUSED = 'The passkey was not accepted. Try again, or sign in with your password.';

test.skip(
  desktop,
  "The desktop signs in through the system browser, a browser's ceremony (PasskeyTests: its consent and code)",
);

interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  signCount: number;
}

interface Authenticator {
  cdp: CDPSession;
  credentials(): Promise<VirtualCredential[]>;
  remove(): Promise<void>;
}

/** A platform authenticator with a discoverable key and user verification, as a laptop's. */
async function virtualAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    cdp,
    credentials: async () =>
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId }))
        .credentials as VirtualCredential[],
    remove: async () => {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    },
  };
}

const signInPage = (back = `${APP}/`) =>
  `${API}/account/signin?returnUrl=${encodeURIComponent(back)}`;

/** The password on the API's page (on `localhost`), back to the localhost app. */
async function signInWithPassword(page: Page, account: TestAccount) {
  await page.goto(signInPage());
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.origin === APP, { timeout: 30000 });
}

/**
 * "Sign in with a passkey". The page also asks for passkeys in the email field's autofill as it
 * opens (conditional mediation); should the browser answer that one first, the page goes on by
 * itself and the click finds nothing to press.
 */
async function signInWithPasskey(page: Page) {
  await page.goto(signInPage());
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username webauthn');
  await page
    .getByRole('button', { name: 'Sign in with a passkey' })
    .click({ timeout: 10000 })
    .catch(() => {});
}

/** The account's passkeys, read as the app reads them (the context's cookie). */
async function passkeys(page: Page) {
  const answer = await page.request.get(`${API}/api/v1/account/passkeys`);
  expect(answer.status()).toBe(200);
  return (
    (await answer.json()) as {
      passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
    }
  ).passkeys;
}

/** Settings' own Sign out: this browser's device ends. */
async function signOut(page: Page) {
  await page.goto(`${APP}/#/settings`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: 'Sign in to sync' }),
  ).toBeVisible({ timeout: 20000 });
}

test('a passkey added from Settings signs in on its own, and once removed is refused', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const authenticator = await virtualAuthenticator(page);
  const account = await newAccount('Passkey Pat');
  await signInWithPassword(page, account);
  await signedIn(page, account);

  // Adding one: the API's page, within ten minutes of the sign-in, back to Settings after.
  // TODO(C2): Settings → Account's "Add a passkey" opens this page with the app's address as
  // `return` (C2 provides the button; then replace the goto with):
  //   await page.goto(`${APP}/#/settings`);
  //   await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.goto(`${API}/account/passkeys/new?return=${encodeURIComponent(`${APP}/#/settings`)}`);
  await expect(page.getByRole('heading', { name: 'Add a passkey' })).toBeVisible();
  await page.getByLabel('Name, to tell your passkeys apart').fill('Virtual key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.waitForURL(`${APP}/#/settings`, { timeout: 30000 });
  const made = await authenticator.credentials();
  expect(made).toHaveLength(1);
  expect(made[0].isResidentCredential).toBe(true);
  const [added] = await passkeys(page);
  expect(added.name).toBe('Virtual key');
  expect(added.lastUsedAt).toBeNull();
  // TODO(C2): Settings → Account lists it (name, added, last used), e.g.
  //   await expect(page.getByRole('listitem').filter({ hasText: 'Virtual key' })).toBeVisible();

  // Signed out, the passkey alone signs in, and the session makes a device of its own.
  await signOut(page);
  await signInWithPasskey(page);
  await page.waitForURL((url) => url.origin === APP, { timeout: 30000 });
  await signedIn(page, account);
  const [used] = await passkeys(page);
  expect(used.lastUsedAt).not.toBeNull();
  expect((await authenticator.credentials())[0].signCount).toBeGreaterThan(0);

  // Removed, it stops at once.
  // TODO(C2): Settings → Account → the passkey's "Remove" (C2's button and its confirmation).
  const csrf = (await (await page.request.get(`${API}/api/v1/account/antiforgery`)).json()) as {
    token: string;
    headerName: string;
  };
  const removed = await page.request.delete(`${API}/api/v1/account/passkeys/${used.id}`, {
    headers: { [csrf.headerName]: csrf.token },
  });
  expect(removed.status()).toBe(204);
  expect(await passkeys(page)).toEqual([]);

  // The authenticator still holds it; the API refuses it, and the browser stays on its page.
  await signOut(page);
  await signInWithPasskey(page);
  await expect(page.getByText(REFUSED)).toBeVisible({ timeout: 20000 });
  expect(new URL(page.url()).origin).toBe(API);
  expect((await page.request.get(`${API}/api/v1/account/session`)).ok()).toBe(true);
  expect(
    ((await (await page.request.get(`${API}/api/v1/account/session`)).json()) as { account: null })
      .account,
  ).toBeNull();
  expect(errors).toEqual([]);
});

test('the passkey pages pass Axe in English and Arabic, the script their only one', async ({
  browser,
}) => {
  // Axe's own script goes in through the debugging protocol, beside the pages' Trusted Types.
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  const authenticator = await virtualAuthenticator(page);
  const account = await newAccount('Axe Ada');
  await signInWithPassword(page, account);
  // A passkey, so the deletion page offers one too; then no authenticator at all, so nothing
  // answers the sign-in page's autofill while Axe reads it.
  await page.goto(`${API}/account/passkeys/new?return=${encodeURIComponent(`${APP}/#/settings`)}`);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.waitForURL(`${APP}/#/settings`, { timeout: 30000 });
  await authenticator.remove();
  for (const lang of ['en', 'ar']) {
    for (const url of [
      `${API}/account/signin?lang=${lang}`,
      `${API}/account/passkeys/new?lang=${lang}&return=${encodeURIComponent(`${APP}/#/settings`)}`,
      `${API}/account/delete?lang=${lang}`,
    ]) {
      const answer = await page.goto(url);
      expect(answer?.headers()['content-security-policy']).toContain("script-src 'self'");
      expect(answer?.headers()['content-security-policy']).not.toContain('unsafe');
      await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
      // The script ran: what needs a browser with passkeys is shown.
      await expect(page.locator('[data-passkey-start]').first()).toBeVisible();
      const result = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(result.violations, `${url}: ${JSON.stringify(result.violations, null, 2)}`).toEqual(
        [],
      );
    }
  }
  await context.close();
});
