// Phase 11 (M11.3): single sign-on in Chrome and Edge, against the server stack and the mock OpenID
// Connect provider (tests/mocks/oidc on http://127.0.0.1:4287, which Playwright starts; the e2e
// stack reads a domain's TXT record from its DNS stand-in, `Sso__DnsBaseUrl`). An owner sets up the
// workspace's provider and proves a domain in Settings → Single sign-on; a person of that domain
// signs in on the API's page through the provider, with no password, lands in the app as a member
// of the workspace, and is offered a password by mail in Settings → Account; required sign-on is
// refused until an owner has signed in through the provider, then turned on, after which a password
// of the domain is refused (the page offers the organisation's sign-in instead), while the owner
// still signs in with theirs.
//
// The server's refusals (a wrong signature, issuer, audience, nonce or expiry, `alg: none`, a key
// never published, a state or a code used twice, an address outside the domains, an unverified
// address, discovery down) are SsoTests'. Here: a real browser's redirects, cookies and CSP
// (`form-action` on the way to the provider and back) end to end, and the owner's screen.
//
//   pnpm exec playwright test tests/e2e/sso.spec.ts --project chrome --project edge
import type { Browser, Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { watchErrors } from './helpers';
import { API, link, mailTo, signedIn, type TestAccount } from './cloud';
import { signedInWorkspace } from './database';
import { escapeRegExp, watchAppErrors, workspaceIdOf } from './ecosystem';
import { MOCK, ORGANISATION, SSO_REFUSED, mock, realmWithClient, ssoSettings } from './sso';
import { apiSession } from '../../scripts/cloud-account.mjs';

const APP = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4273';

test.skip(
  desktop,
  "The desktop signs in through the system browser, a browser's redirects (SsoTests: its consent and code)",
);

/** A confirmed account with the given address, made through the API as the sign-up page would. */
async function register(email: string, name: string): Promise<TestAccount> {
  const password = `a long password ${Date.now()}`;
  const made = await fetch(`${API}/api/v1/account/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: name, locale: 'en' }),
  });
  expect(made.status).toBe(202);
  const confirm = new URL(
    link(
      await mailTo(email),
      new RegExp(`${API.replace(/[.:/]/g, '\\$&')}/account/confirm[^\\s"<>]+`),
    ),
  );
  const confirmed = await fetch(`${API}/api/v1/account/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: confirm.searchParams.get('userId'),
      code: confirm.searchParams.get('code'),
    }),
  });
  expect(confirmed.status).toBe(204);
  return { email, password, name };
}

/** A browser profile of its own (a person not signed in), with its console watched. */
async function profile(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page, errors: watchErrors(page) };
}

/**
 * "Sign in with your organisation's account" from the API's sign-in page, the person queued at
 * the provider first (its `/__mock/next`, so the provider's page is skipped), back to the app.
 */
async function signInThroughProvider(page: Page, realm: string, email: string, name?: string) {
  await mock(`${realm}/__mock/next`, name ? { email, name } : { email });
  await page.goto(`${API}/account/signin?returnUrl=${encodeURIComponent(`${APP}/`)}`);
  await page.getByRole('link', { name: ORGANISATION }).click();
  await expect(page.getByRole('heading', { name: ORGANISATION })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL((url) => url.origin === new URL(APP).origin, { timeout: 30000 });
}

test('a person of a verified domain signs in through the workspace’s provider with no password, joins as a member, and required sign-on refuses their domain’s passwords but the owner’s', async ({
  page,
}) => {
  test.setTimeout(300000);
  const browser = page.context().browser()!;
  const run = `${Date.now()}`;
  const domain = `e2e-${run}.test`;
  const { realm, clientId, clientSecret } = await realmWithClient(run);
  const callback = `${API}/account/sso/callback`;

  // The owner: an account of the domain with a password, signed in in the app, and the workspace.
  const owner = await register(`owner@${domain}`, 'Acme Owner');
  const space = `Acme ${run}`;
  await signedInWorkspace(page, owner, space, null, async () => browser);
  const ownerApi = await apiSession(owner);
  const workspaceId = await workspaceIdOf(ownerApi, space);
  const sso = `/api/v1/workspaces/${workspaceId}/sso`;
  // The section's refusals below are 400s, which the browser logs; nothing else may be.
  const ownerErrors = watchAppErrors(page, [SSO_REFUSED]);

  // Settings → Single sign-on: the redirect address to register at the provider, copied.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
  const section = await ssoSettings(page);
  await expect(section.getByTestId('sso-redirect')).toHaveText(callback);
  await section.getByRole('button', { name: 'Copy the redirect address', exact: true }).click();
  await expect(
    section.getByRole('button', { name: 'Copied the redirect address', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(callback);

  // The provider: a discovery that fails says so in words and saves nothing; then it is saved,
  // and its secret is never shown again.
  const form = section.getByTestId('sso-provider-form');
  const providerStatus = section.getByTestId('sso-provider-status');
  await expect(section.getByTestId('sso-secret-state')).toHaveText('No secret is set.');
  await form.getByLabel('Issuer', { exact: true }).fill(realm);
  await form.getByLabel('Client ID', { exact: true }).fill(clientId);
  await form.getByLabel('Client secret', { exact: true }).fill(clientSecret);
  await expect(
    form.getByRole('checkbox', { name: /^People of these domains join the workspace as members/ }),
  ).toBeChecked();
  await expect(form.getByLabel('Session length (hours)', { exact: true })).toHaveValue('24');
  await mock(`${realm}/__mock/fault`, { kind: 'discoveryDown' });
  await form.getByRole('button', { name: 'Save the provider', exact: true }).click();
  await expect(providerStatus).toHaveText(
    `The provider’s settings could not be read from ${realm}. Check the issuer, and that the provider can be reached.`,
  );
  expect(((await ownerApi.get(sso)) as { provider: unknown }).provider).toBeNull();
  await mock(`${realm}/__mock/fault`, { kind: null });
  await form.getByRole('button', { name: 'Save the provider', exact: true }).click();
  await expect(providerStatus).toHaveText('The provider is saved.');
  await expect(section.getByTestId('sso-secret-state')).toHaveText(
    'A secret is set. It is never shown again: type a new one to replace it.',
  );
  await expect(form.getByLabel('Client secret', { exact: true })).toHaveValue('');
  await expect(section.getByTestId('sso-tested')).toContainText('Not tested yet.');
  await expect(section).not.toContainText(clientSecret);
  const saved = (await ownerApi.get(sso)) as {
    provider: Record<string, unknown>;
    redirectUri: string;
  };
  expect(saved.provider).toMatchObject({
    issuer: realm,
    clientId,
    hasSecret: true,
    joinAsMember: true,
    sessionHours: 24,
    testedAt: null,
  });
  expect(JSON.stringify(saved)).not.toContain(clientSecret);
  expect(saved.redirectUri).toBe(callback);

  // A domain: its TXT record to create, Verify refused while DNS does not have it, then proven.
  const domains = section.getByTestId('sso-domains');
  const domainsStatus = section.getByTestId('sso-domains-status');
  await domains.getByLabel('Domain to add', { exact: true }).fill(domain);
  await domains.getByRole('button', { name: 'Add the domain', exact: true }).click();
  await expect(domainsStatus).toHaveText(
    `${domain} is added. Create its record, then press Verify.`,
  );
  const row = domains.locator(`[data-sso-domain="${domain}"]`);
  await expect(row).toContainText('Not verified yet');
  await expect(row.getByTestId('sso-record-name')).toHaveText(`_cashgear-workspace.${domain}`);
  const value = (await row.getByTestId('sso-record-value').textContent())!;
  expect(value).toMatch(/^cgw-verify=[A-Za-z0-9_-]+$/);
  await row
    .getByRole('button', { name: `Copy the record value for ${domain}`, exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);
  await row.getByRole('button', { name: `Verify ${domain}`, exact: true }).click();
  await expect(domainsStatus).toHaveText(
    `The record for ${domain} was not found yet. DNS can take a while to show a new record: try again in a few minutes.`,
  );
  await mock(`${MOCK}/__mock/dns`, { name: `_cashgear-workspace.${domain}`, txt: [value] });
  await row.getByRole('button', { name: `Verify ${domain}`, exact: true }).click();
  await expect(domainsStatus).toHaveText(`${domain} is verified.`);
  await expect(row).toContainText('Verified');
  const required = row.getByRole('switch', {
    name: `Require sign-in through the provider for ${domain}`,
    exact: true,
  });
  await expect(required).not.toBeChecked();

  // Required sign-on before an owner has signed in through the provider: asked, then refused,
  // saying how to test it.
  const ask = page.getByRole('alertdialog');
  await row.getByText('Require sign-in through the provider', { exact: true }).click();
  await expect(ask).toContainText(`Require sign-on for ${domain}?`);
  await ask.getByRole('button', { name: 'Require sign-on', exact: true }).click();
  await expect(domainsStatus).toHaveText(
    "Sign-on cannot be required yet: an owner must first sign in through the provider. Sign out, then on the sign-in page choose “Sign in with your organisation's account”.",
  );
  await expect(required).not.toBeChecked();

  // A person of the domain signs in through the provider: no password, an account made, a member,
  // her workspace open; Settings → Account offers her a password by mail.
  const ada = await profile(browser);
  const adaEmail = `ada@${domain}`;
  await signInThroughProvider(ada.page, realm, adaEmail, 'Ada Lovelace');
  await signedIn(ada.page, { email: adaEmail, password: '', name: 'Ada Lovelace' });
  const me = (await (await ada.context.request.get(`${API}/api/v1/account/me`)).json()) as {
    email: string;
    hasPassword: boolean;
    ssoRequired: boolean;
  };
  expect(me).toMatchObject({ email: adaEmail, hasPassword: false, ssoRequired: false });
  const theirs = (await (await ada.context.request.get(`${API}/api/v1/workspaces`)).json()) as {
    id: string;
    role: string;
  }[];
  expect(theirs).toContainEqual(expect.objectContaining({ id: workspaceId, role: 'member' }));
  await expect(
    ada.page.getByRole('button', { name: new RegExp(escapeRegExp(space)) }).first(),
  ).toBeVisible({ timeout: 30000 });
  await ada.page.goto(`${APP}/#/settings/account`);
  const password = ada.page.getByTestId('password-settings');
  await expect(password).toContainText(
    `This account has no password: it signs in through your organisation’s account. You can set one too, by a link sent to ${adaEmail}.`,
    { timeout: 30000 },
  );
  await expect(ada.page.getByTestId('passkeys-settings')).toBeVisible();
  // A member is not shown single sign-on at all (it is the Members tab's, after 0.19.0).
  await ada.page.getByRole('tab', { name: 'Members' }).click();
  await expect(ada.page.getByTestId('members')).toBeVisible({ timeout: 30000 });
  await expect(ada.page.getByTestId('sso-settings')).toHaveCount(0);
  await ada.page.getByRole('tab', { name: 'Account' }).click();
  await password.getByRole('button', { name: 'Set a password', exact: true }).click();
  await expect(password.getByTestId('password-status')).toHaveText(
    `A link to set a password is on its way to ${adaEmail}. Open it, choose a password, then sign in with it whenever you like.`,
  );
  expect(await mailTo(adaEmail, '/account/reset')).toContain('/account/reset');
  expect(ada.errors).toEqual([]);

  // Someone of the domain with a password, before sign-on is required.
  const pat = await register(`pat@${domain}`, 'Pat');

  // The owner signs in through the provider once (another browser), which tests it; then turns
  // required sign-on on in Settings, asked first: the domain's other sessions end, owners keep
  // their password.
  const ownerBrowser = await profile(browser);
  await signInThroughProvider(ownerBrowser.page, realm, owner.email);
  await signedIn(ownerBrowser.page, owner);
  expect(
    ((await ownerApi.get(sso)) as { provider: { testedAt: string | null } }).provider.testedAt,
  ).not.toBeNull();
  const again = await ssoSettings(page);
  await expect(again.getByTestId('sso-tested')).toContainText('Tested');
  const againRow = again.locator(`[data-sso-domain="${domain}"]`);
  await againRow.getByText('Require sign-in through the provider', { exact: true }).click();
  await expect(ask).toContainText(
    'those signed in with a password or a passkey are signed out now, on every device. The workspace’s owners are not, and keep their password.',
  );
  await ask.getByRole('button', { name: 'Require sign-on', exact: true }).click();
  await expect(again.getByTestId('sso-domains-status')).toHaveText(
    `Sign-on is now required for ${domain}.`,
  );
  await expect(
    againRow.getByRole('switch', { name: `Require sign-in through the provider for ${domain}` }),
  ).toBeChecked();
  const domainNow = (
    (await ownerApi.get(sso)) as { domains: { domain: string; required: boolean }[] }
  ).domains.find((d) => d.domain === domain);
  expect(domainNow?.required).toBe(true);

  // Pat's password is refused; the page offers the organisation's sign-in, which signs Pat in.
  const patBrowser = await profile(browser);
  await patBrowser.page.goto(`${API}/account/signin?returnUrl=${encodeURIComponent(`${APP}/`)}`);
  await patBrowser.page.getByLabel('Email').fill(pat.email);
  await patBrowser.page.getByLabel('Password').fill(pat.password);
  await patBrowser.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    patBrowser.page.getByRole('heading', { name: 'Your organisation signs you in' }),
  ).toBeVisible();
  await expect(patBrowser.page.locator('[data-code="sso.required"]')).toBeVisible();
  expect(new URL(patBrowser.page.url()).origin).toBe(new URL(API).origin);
  await expect(patBrowser.page.getByLabel('Email')).toHaveValue(pat.email);
  await mock(`${realm}/__mock/next`, { email: pat.email });
  await patBrowser.page.getByRole('button', { name: 'Continue', exact: true }).click();
  await patBrowser.page.waitForURL((url) => url.origin === new URL(APP).origin, {
    timeout: 30000,
  });
  await signedIn(patBrowser.page, pat);
  // Pat's account has a password the domain no longer takes: Settings says the organisation signs
  // it in, and offers none.
  await patBrowser.page.goto(`${APP}/#/settings/account`);
  await expect(patBrowser.page.getByTestId('password-organisation')).toHaveText(
    'Your organisation signs this account in through its own sign-in: a password does not sign it in.',
    { timeout: 30000 },
  );
  await expect(
    patBrowser.page.getByRole('button', { name: 'Set a password', exact: true }),
  ).toHaveCount(0);
  expect(patBrowser.errors).toEqual([]);

  // The owner keeps their password.
  const ownerByPassword = await profile(browser);
  await ownerByPassword.page.goto(
    `${API}/account/signin?returnUrl=${encodeURIComponent(`${APP}/`)}`,
  );
  await ownerByPassword.page.getByLabel('Email').fill(owner.email);
  await ownerByPassword.page.getByLabel('Password').fill(owner.password);
  await ownerByPassword.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await ownerByPassword.page.waitForURL((url) => url.origin === new URL(APP).origin, {
    timeout: 30000,
  });
  await signedIn(ownerByPassword.page, owner);
  expect(ownerErrors).toEqual([]);

  for (const opened of [ada, ownerBrowser, patBrowser, ownerByPassword])
    await opened.context.close();
  await ownerApi.dispose();
});
