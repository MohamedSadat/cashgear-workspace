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
// ceremony end to end, started from Settings → Account → Passkeys (added, listed, removed there),
// the autofill's field, the pages under Axe in English and Arabic, and Settings' passkeys under
// Axe in both themes and languages with no English of their own in Arabic.
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
  // Edge's virtual authenticator answers the autofill's ask as the page opens, and the page then
  // signs in by itself before the field can be read: check the field only while it is there.
  const autofill = await page
    .getByLabel('Email')
    .getAttribute('autocomplete', { timeout: 5000 })
    .catch(() => null);
  if (autofill !== null) expect(autofill).toBe('username webauthn');
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
  await page.goto(`${APP}/#/settings/account`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: 'Sign in to sync' }),
  ).toBeVisible({ timeout: 20000 });
}

/** Settings → Account → Passkeys (packages/shell/src/cloud/PasskeysSettings.tsx). */
const passkeysSection = (page: Page) => page.getByTestId('passkeys-settings');

/** A passkey's row in Settings, by its name. */
const listed = (page: Page, name: string) =>
  passkeysSection(page)
    .getByTestId('passkeys-list')
    .getByRole('listitem')
    .filter({ hasText: name });

/**
 * Settings' "Add a passkey": the API's page in this tab, in the interface language, with this
 * app's Settings as `return`; named there and added (a sign-in of the last ten minutes, so no
 * password asked again), then back to Settings.
 */
async function addFromSettings(page: Page, name: string) {
  await passkeysSection(page).getByRole('button', { name: 'Add a passkey' }).click();
  await page.waitForURL((url) => url.origin === API && url.pathname === '/account/passkeys/new');
  const asked = new URL(page.url());
  expect(asked.searchParams.get('return')).toBe(`${APP}/#/settings/account`);
  expect(asked.searchParams.get('lang')).toBe('en');
  await expect(page.getByRole('heading', { name: 'Add a passkey' })).toBeVisible();
  await page.getByLabel('Name, to tell your passkeys apart').fill(name);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.waitForURL(`${APP}/#/settings/account`, { timeout: 30000 });
}

test('a passkey added from Settings signs in on its own, and once removed is refused', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const authenticator = await virtualAuthenticator(page);
  const account = await newAccount('Passkey Pat');
  await signInWithPassword(page, account);
  await signedIn(page, account);

  // Adding one: Settings → Account's "Add a passkey" opens the API's page in this tab, with this
  // app's Settings as `return`; within ten minutes of the sign-in it adds at once, then comes back.
  await page.goto(`${APP}/#/settings/account`);
  await expect(passkeysSection(page).getByText('No passkeys yet.')).toBeVisible({ timeout: 20000 });
  await addFromSettings(page, 'Virtual key');
  const made = await authenticator.credentials();
  expect(made).toHaveLength(1);
  expect(made[0].isResidentCredential).toBe(true);
  const [added] = await passkeys(page);
  expect(added.name).toBe('Virtual key');
  expect(added.lastUsedAt).toBeNull();
  // Back in Settings, the list read again shows it: its name, when it was added, never used.
  await expect(listed(page, 'Virtual key')).toBeVisible({ timeout: 20000 });
  await expect(listed(page, 'Virtual key')).toContainText('Added');
  await expect(listed(page, 'Virtual key')).toContainText('Not used yet');

  // Signed out, the passkey alone signs in, and the session makes a device of its own.
  await signOut(page);
  await signInWithPasskey(page);
  await page.waitForURL((url) => url.origin === APP, { timeout: 30000 });
  await signedIn(page, account);
  const [used] = await passkeys(page);
  expect(used.lastUsedAt).not.toBeNull();
  expect((await authenticator.credentials())[0].signCount).toBeGreaterThan(0);

  // Removed in Settings → Account (asked first), it stops at once.
  await page.goto(`${APP}/#/settings/account`);
  await expect(listed(page, 'Virtual key')).toContainText('Last used', { timeout: 20000 });
  await listed(page, 'Virtual key').getByRole('button', { name: 'Remove Virtual key' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Remove the passkey “Virtual key”?' });
  await expect(ask).toContainText('You can no longer sign in with it.');
  await expect(ask).toContainText('until you sign them out under “Devices signed in”');
  await ask.getByRole('button', { name: 'Remove the passkey' }).click();
  await expect(ask).toBeHidden();
  await expect(passkeysSection(page).getByRole('status')).toHaveText('“Virtual key” is removed.');
  await expect(passkeysSection(page).getByText('No passkeys yet.')).toBeVisible();
  expect(await passkeys(page)).toEqual([]);
  expect(used.id).toBe(added.id);

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

/** The section's own words the walk presses (packages/shell/src/cloud/passkeysWords.ts). */
const WORDS = {
  en: { rename: 'Rename', remove: 'Remove', name: 'Name of the passkey', cancel: 'Cancel' },
  ar: { rename: 'إعادة تسمية', remove: 'إزالة', name: 'اسم مفتاح المرور', cancel: 'إلغاء' },
};

/** Axe on one part of the page (the section, or the dialog drawn over it). */
async function axeOn(page: Page, scope: string, screen: string) {
  const result = await new AxeBuilder({ page }).include(scope).withTags(WCAG).analyze();
  return result.violations.map(
    (v) =>
      `${screen}: ${v.id} (${v.impact}) ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(' ')}: ${n.failureSummary?.split('\n')[1] ?? ''}`)
        .join('\n'),
  );
}

/** Latin letters in what a part of the page shows or names, the passkey's own name aside. */
async function latinIn(page: Page, scope: string, screen: string, theirs: string) {
  return page.evaluate(
    ({ scope, screen, theirs }) => {
      const found: string[] = [];
      for (const root of document.querySelectorAll<HTMLElement>(scope)) {
        const named = [...root.querySelectorAll('[aria-label], [title], [placeholder]')].flatMap(
          (el) => ['aria-label', 'title', 'placeholder'].map((a) => el.getAttribute(a) ?? ''),
        );
        for (const text of [root.innerText, ...named])
          if (/[A-Za-z]/.test(text.split(theirs).join(' ')))
            found.push(`${screen}: ${text.trim()}`);
      }
      return found;
    },
    { scope, screen, theirs },
  );
}

// Settings → Account → Passkeys with a passkey listed (only a real ceremony makes one, and only on
// `localhost`, so the walk is here rather than in a11y.spec.ts and arabic.spec.ts): the list, a
// passkey being renamed, its removal asked; Axe in light and dark, English and Arabic, and no
// English of the section's own in Arabic (the passkey's name is the person's).
test('Settings’ passkeys pass Axe in both themes and languages, and the Arabic has no English of its own', async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors = watchErrors(page);
  await virtualAuthenticator(page);
  const account = await newAccount('Walk Wafa');
  await signInWithPassword(page, account);
  await signedIn(page, account);
  await page.goto(`${APP}/#/settings/account`);
  await addFromSettings(page, 'Virtual key');
  const problems: string[] = [];
  const english: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    for (const language of ['en', 'ar'] as const) {
      await page.evaluate(
        ([theme, language]) => {
          localStorage.setItem('cgw-theme', theme);
          localStorage.setItem('cgw-language', language);
        },
        [theme, language],
      );
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
      const words = WORDS[language];
      const row = listed(page, 'Virtual key');
      await expect(row).toBeVisible({ timeout: 20000 });
      const check = async (screen: string, scope: string) => {
        const name = `${screen} (${theme}, ${language})`;
        problems.push(...(await axeOn(page, scope, name)));
        if (language === 'ar') english.push(...(await latinIn(page, scope, name, 'Virtual key')));
      };
      await check('the list', '[data-testid="passkeys-settings"]');

      await row.getByRole('button', { name: `${words.rename} Virtual key` }).click();
      await expect(passkeysSection(page).getByLabel(words.name)).toBeFocused();
      await check('renaming', '[data-testid="passkeys-settings"]');
      await passkeysSection(page).getByRole('button', { name: words.cancel, exact: true }).click();
      await expect(row.getByRole('button', { name: `${words.rename} Virtual key` })).toBeFocused();

      await row.getByRole('button', { name: `${words.remove} Virtual key` }).click();
      const ask = page.getByRole('alertdialog');
      await expect(ask).toBeVisible();
      await check('removing asked', '.cgw-dialog');
      await ask.getByRole('button', { name: words.cancel, exact: true }).click();
      await expect(ask).toBeHidden();
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
  expect(english, english.join('\n')).toEqual([]);
  expect(errors).toEqual([]);
});
