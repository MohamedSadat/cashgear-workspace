// Accounts for the Phase 2 specs, against the local server stack Playwright starts
// (scripts/server-stack.mjs --e2e): sign-up through the API, the confirmation mail read from the
// stack's pickup folder, sign-in on the API's own page as a person does.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

export const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:5280';
const root = resolve(import.meta.dirname, '../..');
const MAIL = join(root, 'test-results/mail');

export interface TestAccount {
  email: string;
  password: string;
  name: string;
}

let counter = 0;

/** The text of the newest mail to an address, quoted-printable undone. */
export async function mailTo(address: string, containing?: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    let files: string[] = [];
    try {
      files = readdirSync(MAIL)
        .filter((f) => f.endsWith('.eml'))
        .sort()
        .reverse();
    } catch {
      // The folder appears with the first mail.
    }
    for (const file of files) {
      const text = readFileSync(join(MAIL, file), 'utf8')
        .replace(/=\r?\n/g, '')
        .replace(/=3D/g, '=');
      if (
        text.toLowerCase().includes(address.toLowerCase()) &&
        (!containing || text.includes(containing))
      )
        return text;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No mail to ${address}`);
}

export const link = (mail: string, pattern: RegExp) => {
  const match = mail.match(pattern);
  if (!match) throw new Error(`No link ${pattern} in the mail`);
  return match[0].replace(/&amp;/g, '&');
};

/** A confirmed account, made through the API as the sign-up page would. */
export async function newAccount(name = 'Tester'): Promise<TestAccount> {
  const email = `e2e-${Date.now()}-${++counter}@example.test`;
  const password = `a long password ${counter}`;
  const register = await fetch(`${API}/api/v1/account/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: name, locale: 'en' }),
  });
  expect(register.status).toBe(202);
  const confirm = link(
    await mailTo(email),
    new RegExp(`${API.replace(/[.:/]/g, '\\$&')}/account/confirm[^\\s"<>]+`),
  );
  expect((await fetch(confirm)).ok).toBe(true);
  return { email, password, name };
}

/** Signs in on the API's page, which sends the browser back to the app with the session cookie. */
export async function signIn(page: Page, account: TestAccount, back = '/') {
  const app = new URL(
    back,
    page.url().startsWith('http') ? page.url() : 'http://127.0.0.1:4273',
  ).toString();
  await page.goto(`${API}/account/signin?returnUrl=${encodeURIComponent(app)}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.origin !== new URL(API).origin, { timeout: 30000 });
}

/** The account's name in the sidebar: signed in, and the first check answered. */
export async function signedIn(page: Page, account: TestAccount) {
  await expect(page.getByRole('button', { name: `Account: ${account.name}` })).toBeVisible({
    timeout: 20000,
  });
}

export const syncStatus = (page: Page) => page.getByTestId('sync-status');
