// Phase 11's single sign-on for the specs (sso.spec.ts, and the accessibility and Arabic walks of
// Settings → Single sign-on): the mock OpenID Connect provider's controls (tests/mocks/oidc on
// http://127.0.0.1:4287, which Playwright starts; the e2e stack reads a domain's TXT record from its
// `/__mock/dns`, `Sso__DnsBaseUrl`), the section as an owner reads it, and a scene with each of its
// screens: the provider set and not tested yet, a domain proven and one not, a refusal said, and
// the three questions it asks (removing the provider, requiring sign-on, removing a domain).
import type { Browser, Page } from '@playwright/test';
import { expect } from './fixtures';
import { API, newAccount } from './cloud';
import { signedInWorkspace } from './database';
import { sessionOf, workspaceIdOf, type Api } from './ecosystem';

export const MOCK = process.env.E2E_OIDC_URL ?? 'http://127.0.0.1:4287';

/** The sign-in page's link to the organisation's sign-in, in the API's words. */
export const ORGANISATION = "Sign in with your organisation's account";

/**
 * The refusals the section is answered with (a domain's record not found yet, a discovery down,
 * sign-on not tested): a browser logs each 4xx as a console error, so the specs allow these.
 */
export const SSO_REFUSED = /status of 400 .*\/api\/v1\/workspaces\/[0-9a-f-]{36}\/sso\//;

/** A control of the mock provider (`/__mock/*`), on the root or a realm. */
export async function mock(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `${path}: ${response.status} ${await response.text()}`).toBe(true);
}

/** A realm of the mock of its own, with a client registered for the API's callback. */
export async function realmWithClient(run: string) {
  const realm = `${MOCK}/realms/e2e-sso-${run}`;
  const clientId = `cgw-e2e-${run}`;
  const clientSecret = `e2e+secret%${run}`;
  await mock(`${realm}/__mock/clients`, {
    clientId,
    clientSecret,
    redirectUris: [`${API}/account/sso/callback`],
  });
  return { realm, clientId, clientSecret };
}

/** The interface's words these helpers use, in each language. */
export const SSO_WORDS = {
  en: {
    cancel: 'Cancel',
    require: 'Require sign-in through the provider',
    removeProvider: 'Remove the provider',
    verify: (domain: string) => `Verify ${domain}`,
    remove: (domain: string) => `Remove ${domain}`,
  },
  ar: {
    cancel: 'إلغاء',
    require: 'إلزام تسجيل الدخول عبر المزوّد',
    removeProvider: 'إزالة المزوّد',
    verify: (domain: string) => `تحقّق من ${domain}`,
    remove: (domain: string) => `إزالة ${domain}`,
  },
} as const;

/**
 * Settings → Single sign-on, read (an owner's). Already on Settings, the page is loaded again: the
 * app routes by the hash, so going to the same address would not read the section again.
 */
export async function ssoSettings(page: Page) {
  if (new URL(page.url()).hash === '#/settings') await page.reload();
  else await page.goto('/#/settings');
  const section = page.getByTestId('sso-settings');
  await expect(section.getByTestId('sso-provider-form')).toBeVisible({ timeout: 30000 });
  return section;
}

export interface SsoScene {
  api: Api;
  workspaceId: string;
  /** A domain proven, and one whose record is not in DNS. */
  verified: string;
  pending: string;
  /** Names that are the person's, the workspace's, the provider's or the domains' (Arabic check). */
  names: string[];
  dispose(): Promise<void>;
}

/**
 * An owner's synced workspace with a provider (a realm of the mock, its secret set, not tested
 * yet) and two domains: one proven through the mock's DNS, one not; made in English through the
 * routes, the app signed in on `page`.
 */
export async function ssoScene(
  page: Page,
  name: string,
  signer: () => Promise<Browser>,
): Promise<SsoScene> {
  const run = `${Date.now()}`;
  const account = await newAccount(name);
  const space = `${name} space`;
  await signedInWorkspace(page, account, space, null, signer);
  const api = await sessionOf(account);
  const workspaceId = await workspaceIdOf(api, space);
  const { realm, clientId, clientSecret } = await realmWithClient(run);
  const sso = `/api/v1/workspaces/${workspaceId}/sso`;
  await api.put(`${sso}/provider`, { issuer: realm, clientId, clientSecret });
  const verified = `verified-${run}.test`;
  const pending = `pending-${run}.test`;
  const added = (await api.post(`${sso}/domains`, { domain: verified })) as {
    record: { name: string; value: string };
  };
  await mock(`${MOCK}/__mock/dns`, { name: added.record.name, txt: [added.record.value] });
  await api.post(`${sso}/domains/${verified}/verify`, {});
  await api.post(`${sso}/domains`, { domain: pending });
  return {
    api,
    workspaceId,
    verified,
    pending,
    names: [
      account.name,
      account.email,
      space,
      realm,
      clientId,
      verified,
      pending,
      'OpenID Connect',
      `${API}/account/sso/callback`,
    ].sort((a, b) => b.length - a.length),
    dispose: () => api.dispose(),
  };
}

/**
 * The scene's screens in the app's language now, each handed to `check` once drawn: the section
 * with the provider and both domains after the unproven one's Verify was refused (said in words),
 * then each question it asks, cancelled: removing the provider, requiring sign-on for the proven
 * domain, removing the unproven one.
 */
export async function ssoScreens(
  page: Page,
  scene: SsoScene,
  language: 'en' | 'ar',
  check: (screen: string) => Promise<void>,
) {
  const words = SSO_WORDS[language];
  const section = await ssoSettings(page);
  const pending = section.locator(`[data-sso-domain="${scene.pending}"]`);
  const verified = section.locator(`[data-sso-domain="${scene.verified}"]`);
  await expect(pending.getByTestId('sso-record-value')).toBeVisible({ timeout: 30000 });
  await expect(verified.getByRole('switch')).not.toBeChecked();
  await expect(section.getByTestId('sso-secret-state')).toBeVisible();
  await expect(section.getByTestId('sso-tested')).toBeVisible();
  // The unproven domain's record is not in DNS: its Verify is refused, in words.
  await pending.getByRole('button', { name: words.verify(scene.pending), exact: true }).click();
  await expect(section.getByTestId('sso-domains-status')).toContainText(scene.pending);
  await check('single sign-on: the provider, a domain proven and one not, a refusal said');

  const ask = page.getByRole('alertdialog');
  await section.getByRole('button', { name: words.removeProvider, exact: true }).click();
  await expect(ask).toBeVisible();
  await check('the provider’s removal asked');
  await ask.getByRole('button', { name: words.cancel, exact: true }).click();
  await expect(ask).toHaveCount(0);

  // The switch's own box is drawn by the library; its label is what a person presses.
  await verified.getByText(words.require, { exact: true }).click();
  await expect(ask).toBeVisible();
  await check('sign-on required for a domain, asked');
  await ask.getByRole('button', { name: words.cancel, exact: true }).click();
  await expect(ask).toHaveCount(0);
  await expect(verified.getByRole('switch')).not.toBeChecked();

  await pending.getByRole('button', { name: words.remove(scene.pending), exact: true }).click();
  await expect(ask).toBeVisible();
  await check('a domain’s removal asked');
  await ask.getByRole('button', { name: words.cancel, exact: true }).click();
  await expect(ask).toHaveCount(0);
}
