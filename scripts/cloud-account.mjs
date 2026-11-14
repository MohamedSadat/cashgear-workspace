// Accounts and the API for Phase 3's scripts (kill tests during sync, bench/phase3.mjs), against
// the e2e server stack (scripts/server-stack.mjs --e2e on 127.0.0.1:5280), the way
// tests/e2e/cloud.ts makes them: sign-up through the API, the confirmation read from the stack's
// pickup folder, sign-in on the API's own page. `apiSession` is a signed-in cookie session for
// Node (reads and writes with the antiforgery header), used to check what the server holds.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '@playwright/test';
import { root } from './lib.mjs';

export const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:5280';
export const APP = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4273';
const MAILS = [join(root, '.cgw-dev/e2e/mail'), join(root, '.cgw-dev/mail')];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function answers(url, ms = 2000) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
}

export async function waitFor(url, ms) {
  const deadline = Date.now() + ms;
  while (!(await answers(url))) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + url);
    await sleep(300);
  }
}

/** The newest mail to an address in the stack's pickup folder, quoted-printable undone. */
export async function mailTo(address) {
  for (let i = 0; i < 300; i++) {
    for (const folder of MAILS) {
      let files;
      try {
        files = readdirSync(folder)
          .filter((f) => f.endsWith('.eml'))
          .map((f) => join(folder, f))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
          .slice(0, 80);
      } catch {
        continue;
      }
      for (const path of files) {
        let text;
        try {
          text = readFileSync(path, 'utf8')
            .replace(/=\r?\n/g, '')
            .replace(/=3D/g, '=');
        } catch {
          continue; // Still being written: read on the next round.
        }
        if (text.toLowerCase().includes(address.toLowerCase())) return text;
      }
    }
    await sleep(100);
  }
  throw new Error(`No mail to ${address}`);
}

/** A confirmed account. */
export async function newAccount(displayName = 'Kill test') {
  const email = `p3-${Date.now()}-${randomBytes(4).toString('hex')}@example.test`;
  const password = `a long test password ${randomBytes(6).toString('hex')}`;
  const register = await fetch(`${API}/api/v1/account/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, locale: 'en' }),
  });
  if (register.status !== 202) throw new Error(`Sign-up answered ${register.status}`);
  const escaped = API.replace(/[.:/]/g, '\\$&');
  const link = (await mailTo(email)).match(new RegExp(`${escaped}/account/confirm[^\\s"<>]+`));
  if (!link) throw new Error('No confirmation link in the mail');
  const url = new URL(link[0].replace(/&amp;/g, '&'));
  const confirmed = await fetch(`${API}/api/v1/account/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: url.searchParams.get('userId'),
      code: url.searchParams.get('code'),
    }),
  });
  if (confirmed.status !== 204) throw new Error(`Confirming answered ${confirmed.status}`);
  return { email, password, name: displayName };
}

/** A signed-in cookie session in Node: `get`, `post` (antiforgery header added) and `dispose`. */
export async function apiSession(account) {
  const api = await request.newContext({ baseURL: API });
  const form = await (await api.get('/account/signin')).text();
  const token = form.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
  if (!token) throw new Error('No antiforgery token on the sign-in page');
  const signedIn = await api.post('/account/signin', {
    form: {
      __RequestVerificationToken: token
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&amp;/g, '&'),
      Email: account.email,
      Password: account.password,
      ReturnUrl: '',
    },
    maxRedirects: 0,
  });
  if (signedIn.status() !== 302) throw new Error(`Sign-in answered ${signedIn.status()}`);
  const csrf = await (await api.get('/api/v1/account/antiforgery')).json();
  const headers = { [csrf.header ?? 'X-CSRF-TOKEN']: csrf.token };
  const json = async (response, path) => {
    if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? null : response.json();
  };
  return {
    get: async (path) => json(await api.get(path), path),
    /** The status and body, for answers that are not 2xx. */
    raw: async (path) => {
      const response = await api.get(path);
      return { status: response.status(), body: await response.text() };
    },
    post: async (path, data) => json(await api.post(path, { data, headers }), path),
    put: async (path, data) => json(await api.put(path, { data, headers }), path),
    patch: async (path, data) => json(await api.patch(path, { data, headers }), path),
    del: async (path) => json(await api.delete(path, { headers }), path),
    dispose: () => api.dispose(),
  };
}

/** Signs a browser page in on the API's page, which sends it back to the app with the cookie. */
export async function signInPage(page, account, back = `${APP}/`) {
  await page.goto(`${API}/account/signin?returnUrl=${encodeURIComponent(back)}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.origin !== new URL(API).origin, { timeout: 30000 });
}

/**
 * The desktop app's sign-in, as tests/e2e/desktop-cloud.spec.ts does it: the app writes the
 * authorise URL to CGW_AUTH_URL_FILE instead of opening the system browser; a browser page signs
 * in there, confirms, and is sent to the app's loopback listener.
 */
export async function desktopSignIn(page, browser, authUrlFile, account) {
  const { existsSync, rmSync } = await import('node:fs');
  rmSync(authUrlFile, { force: true });
  await page.getByRole('button', { name: 'Sign in to sync' }).first().click();
  for (let i = 0; !existsSync(authUrlFile); i++) {
    if (i > 150) throw new Error('The app wrote no authorise URL');
    await sleep(100);
  }
  const authorize = readFileSync(authUrlFile, 'utf8').trim();
  const tab = await browser.newPage();
  try {
    await tab.goto(authorize);
    await tab.getByLabel('Email').fill(account.email);
    await tab.getByLabel('Password').fill(account.password);
    await tab.getByRole('button', { name: 'Sign in' }).click();
    await tab.getByRole('button', { name: 'Continue' }).click();
    await tab.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/callback/);
  } finally {
    await tab.close();
  }
}

/** Plain text of a ProseMirror JSON node (the worker's derived JSON), its blocks joined by "\n". */
export function nodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(nodeText).join('');
}

/** The server's derived document of a page: its top-level blocks' body texts and its head. */
export async function serverDoc(api, pageId) {
  const answer = await api.get(`/api/v1/pages/${pageId}/doc/json`);
  const json = typeof answer.json === 'string' ? JSON.parse(answer.json) : answer.json;
  const blocks = (json?.content ?? []).map((block) => nodeText((block.content ?? [])[0]));
  return { upToSeq: Number(answer.upToSeq), schemaVersion: Number(answer.schemaVersion), blocks };
}
