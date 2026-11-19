// Phase 11 (M11.3): single sign-on in Chrome and Edge, against the server stack and the mock OpenID
// Connect provider (tests/mocks/oidc on http://127.0.0.1:4287, which Playwright starts; the e2e
// stack reads a domain's TXT record from its DNS stand-in, `Sso__DnsBaseUrl`). An owner sets up the
// workspace's provider and proves a domain; a person of that domain signs in on the API's page
// through the provider, with no password, and lands in the app as a member of the workspace; with
// sign-on required for the domain, a password of the domain is refused (the page offers the
// organisation's sign-in instead), while the owner still signs in with theirs.
//
// The server's refusals (a wrong signature, issuer, audience, nonce or expiry, `alg: none`, a key
// never published, a state or a code used twice, an address outside the domains, an unverified
// address, discovery down) are SsoTests'. Here: a real browser's redirects, cookies and CSP
// (`form-action` on the way to the provider and back) end to end.
//
// TODO(C2/C3): Settings → Single sign-on is not built yet: the owner's steps go through the routes
// with `api`. Each TODO names what the screen must offer, so this spec can drive it instead.
//
//   pnpm exec playwright test tests/e2e/sso.spec.ts --project chrome --project edge
import type { Browser, Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { watchErrors } from './helpers';
import { API, link, mailTo, signedIn, type TestAccount } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';

const MOCK = process.env.E2E_OIDC_URL ?? 'http://127.0.0.1:4287';
const APP = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4273';
const ORGANISATION = "Sign in with your organisation's account";

test.skip(
  desktop,
  "The desktop signs in through the system browser, a browser's redirects (SsoTests: its consent and code)",
);

/** A control of the mock provider (`/__mock/*`), on the root or a realm. */
async function mock(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `${path}: ${response.status} ${await response.text()}`).toBe(true);
}

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
  test.setTimeout(240000);
  const browser = page.context().browser()!;
  const run = `${Date.now()}`;
  const domain = `e2e-${run}.test`;
  const realm = `${MOCK}/realms/e2e-sso-${run}`;
  const clientId = `cgw-e2e-${run}`;
  const clientSecret = `e2e+secret%${run}`;
  await mock(`${realm}/__mock/clients`, {
    clientId,
    clientSecret,
    redirectUris: [`${API}/account/sso/callback`],
  });

  // The owner: an account of the domain with a password, and the workspace.
  const owner = await register(`owner@${domain}`, 'Acme Owner');
  const ownerApi = await apiSession(owner);
  const workspaceId = crypto.randomUUID();
  await ownerApi.post('/api/v1/workspaces', { id: workspaceId, name: `Acme ${run}` });
  const sso = `/api/v1/workspaces/${workspaceId}/sso`;

  // TODO(C2/C3): Settings → Single sign-on, for owners only: fields "Issuer", "Client ID" and
  // "Client secret" (the secret never shown again, "A secret is set" instead), "Let people of the
  // domains join as members" (on), "Session length (hours)" (24), the redirect address to register
  // at the provider (the answer's `redirectUri`, with a copy button), and Save; a discovery that
  // fails says so in words (`sso.discoveryFailed`).
  const provider = (await ownerApi.put(`${sso}/provider`, {
    issuer: realm,
    clientId,
    clientSecret,
  })) as { hasSecret: boolean; testedAt: string | null };
  expect(provider.hasSecret).toBe(true);
  expect(provider.testedAt).toBeNull();
  expect(((await ownerApi.get(sso)) as { redirectUri: string }).redirectUri).toBe(
    `${API}/account/sso/callback`,
  );

  // TODO(C2/C3): "Add a domain" (the domain typed), then its TXT record shown as a name and a value
  // to copy, and "Verify" (`sso.dnsNotFound` said in words while the record is not there yet).
  const added = (await ownerApi.post(`${sso}/domains`, { domain })) as {
    record: { name: string; value: string };
  };
  expect(added.record.name).toBe(`_cashgear-workspace.${domain}`);
  await mock(`${MOCK}/__mock/dns`, { name: added.record.name, txt: [added.record.value] });
  const verified = (await ownerApi.post(`${sso}/domains/${domain}/verify`, {})) as {
    verifiedAt: string | null;
  };
  expect(verified.verifiedAt).not.toBeNull();

  // A person of the domain signs in through the provider: no password, an account made, a member.
  const errors = watchErrors(page);
  await signInThroughProvider(page, realm, `ada@${domain}`, 'Ada Lovelace');
  await signedIn(page, { email: `ada@${domain}`, password: '', name: 'Ada Lovelace' });
  const me = (await (await page.context().request.get(`${API}/api/v1/account/me`)).json()) as {
    email: string;
    hasPassword: boolean;
  };
  expect(me.email).toBe(`ada@${domain}`);
  expect(me.hasPassword).toBe(false);
  const theirs = (await (await page.context().request.get(`${API}/api/v1/workspaces`)).json()) as {
    id: string;
    role: string;
  }[];
  expect(theirs).toContainEqual(expect.objectContaining({ id: workspaceId, role: 'member' }));
  // TODO(C2): the workspace switcher lists "Acme …" for her, and opens it.
  expect(errors).toEqual([]);

  // Someone of the domain with a password, before sign-on is required.
  const pat = await register(`pat@${domain}`, 'Pat');

  // Required sign-on needs an owner's sign-in through the provider first.
  // TODO(C2/C3): the domain's "Require sign-in through the provider" switch, off and explained
  // until an owner has signed in through it (`sso.notTested`), then on, saying that the domain's
  // other sessions end and its owners keep their password.
  const untested = await ownerApi.raw(`${sso}`);
  expect(JSON.parse(untested.body).provider.testedAt).toBeNull();
  const ownerBrowser = await profile(browser);
  await signInThroughProvider(ownerBrowser.page, realm, owner.email);
  await signedIn(ownerBrowser.page, owner);
  expect(
    ((await ownerApi.get(sso)) as { provider: { testedAt: string | null } }).provider.testedAt,
  ).not.toBeNull();
  const required = (await ownerApi.patch(`${sso}/domains/${domain}`, { required: true })) as {
    required: boolean;
  };
  expect(required.required).toBe(true);

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

  for (const opened of [ownerBrowser, patBrowser, ownerByPassword]) await opened.context.close();
  await ownerApi.dispose();
});
