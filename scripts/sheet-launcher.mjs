// Workspace's test launcher for Cash Gear Sheet's `sheet-session.1` contract suite (cashgear-sheet,
// packages/workspace-connector/src/contract.test.ts): one-time launch tickets from Workspace's
// real API, which only a signed-in Workspace user can make. There is no back door: every step is
// an API call a person's client makes, as real users.
//
//   node scripts/server-stack.mjs --e2e     (or pnpm dev:server), then in another terminal
//   node scripts/sheet-launcher.mjs         prints "Sheet launcher ready on http://127.0.0.1:4285"
//   (in cashgear-sheet) WORKSPACE_API_URL=http://127.0.0.1:5280
//     WORKSPACE_LAUNCHER_URL=http://127.0.0.1:4285 pnpm test
//
// At start it signs up three people (each confirmed from the stack's mail folder) and signs them
// in: `editor` owns a new workspace; `viewer` joins it by invitation and has view access to its
// workbooks (PUT /workbooks/{id}/permissions); `other` is in no workspace of theirs. `budget` gets
// one version: `editor` launches it, redeems the ticket from an allowed Origin and saves a small
// xlsx with If-None-Match: *.
//
//   POST / {user: 'editor' | 'viewer' | 'other', workbook: 'budget' | 'empty', access?, language?}
//     200 {ticket}  from POST /api/v1/workbooks/{id}/launch as that person (120 s, one use)
//     403 {error}   the API refused the launch (`other` is not a member)
//     400 {error}   anything else (502 {error} when the API fails otherwise)
//
// `empty` is a new workbook with no version for each launch, as the suite expects (it saves the
// first version). `access` ('edit' | 'view') cannot narrow a real ticket: the server binds a
// ticket to the person's level (editor edit, viewer view), so an `access` other than that level
// is 400. `language` ('en' | 'ar') is set on the person's account (PATCH /api/v1/account/me)
// before the launch, and is 'en' when left out; the server reads it when the ticket is redeemed.
//
// CGW_API (http://127.0.0.1:5280), CGW_LAUNCHER_PORT (4285), CGW_SHEET_ORIGIN (the Origin of the
// budget's first save, http://127.0.0.1:4173), CGW_MAIL (the stack's mail folder; by default
// .cgw-dev/e2e/mail, then .cgw-dev/mail). The passwords are random and kept in memory only.
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { XLSX_TYPE, writeXlsx } from '../tests/mocks/sheet/xlsx.mjs';
import { root } from './lib.mjs';

const API = (process.env.CGW_API ?? 'http://127.0.0.1:5280').replace(/\/+$/, '');
const PORT = Number(process.env.CGW_LAUNCHER_PORT ?? 4285);
const SHEET_ORIGIN = process.env.CGW_SHEET_ORIGIN ?? 'http://127.0.0.1:4173';
const MAILS = process.env.CGW_MAIL
  ? [process.env.CGW_MAIL]
  : [join(root, '.cgw-dev/e2e/mail'), join(root, '.cgw-dev/mail')];
const SESSION_HEADER = 'X-Workspace-File-Session';
const NAMES = { editor: 'Rana Editor', viewer: 'Sami Viewer', other: 'Omar Other' };
/** The ticket's access each person's level gives (an owner's `full` launches as `edit`). */
const LEVELS = { editor: 'edit', viewer: 'view' };
const WORKBOOKS = ['budget', 'empty'];
const FIELDS = ['user', 'workbook', 'access', 'language'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error {
  constructor(method, path, status, problem) {
    super(`${method} ${path}: ${status} ${problem.code ?? ''} ${problem.title ?? ''}`.trim());
    this.status = status;
    this.code = problem.code ?? null;
  }
}

async function problemOf(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { title: text.slice(0, 200) };
  }
}

const decodeHtml = (text) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

/** The newest mail to an address holding `containing`, quoted-printable undone. */
async function mailTo(address, containing) {
  const wanted = address.toLowerCase();
  for (let i = 0; i < 300; i++) {
    for (const folder of MAILS) {
      let files;
      try {
        files = readdirSync(folder).filter((f) => f.endsWith('.eml'));
      } catch {
        continue; // The folder appears with the first mail.
      }
      const newest = files
        .map((f) => {
          const path = join(folder, f);
          try {
            return [path, statSync(path).mtimeMs];
          } catch {
            return [path, 0];
          }
        })
        .sort((a, b) => b[1] - a[1])
        .slice(0, 200);
      for (const [path] of newest) {
        let text;
        try {
          text = readFileSync(path, 'utf8')
            .replace(/=\r?\n/g, '')
            .replace(/=3D/g, '=');
        } catch {
          continue; // Still being written (EBUSY on Windows): read on the next round.
        }
        if (text.toLowerCase().includes(wanted) && text.includes(containing)) return text;
      }
    }
    await sleep(100);
  }
  throw new Error(`No mail to ${address} in ${MAILS.join(' or ')}`);
}

/** One person: an account made through the API and a cookie session with the antiforgery header. */
class Person {
  constructor(role) {
    this.role = role;
    this.name = NAMES[role];
    this.email = `sheet-${role}-${Date.now()}-${randomBytes(4).toString('hex')}@example.test`;
    this.password = `a long launcher password ${randomBytes(12).toString('hex')}`;
    this.cookies = new Map();
    this.csrf = null;
    this.id = null;
    this.locale = 'en';
  }

  keep(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const gone = attributes.some((attribute) => {
        const [key, ...rest] = attribute.split('=');
        const k = key.trim().toLowerCase();
        if (k === 'max-age') return Number(rest.join('=')) <= 0;
        if (k === 'expires') return Date.parse(rest.join('=')) <= Date.now();
        return false;
      });
      if (gone || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async send(path, { method = 'GET', json, body, headers = {} } = {}) {
    const all = { ...headers };
    if (this.cookies.size) all.Cookie = [...this.cookies].map(([n, v]) => `${n}=${v}`).join('; ');
    if (json !== undefined) all['Content-Type'] = 'application/json';
    if (this.csrf && method !== 'GET') all[this.csrf.headerName] = this.csrf.token;
    const response = await fetch(`${API}${path}`, {
      method,
      headers: all,
      body: json !== undefined ? JSON.stringify(json) : body,
      redirect: 'manual',
    });
    this.keep(response);
    return response;
  }

  /** A JSON call that must succeed; a session that has ended is signed in again once. */
  async call(method, path, json, again = true) {
    const response = await this.send(path, { method, json });
    if (response.status === 401 && again) {
      await this.signIn();
      return this.call(method, path, json, false);
    }
    if (!response.ok) throw new ApiError(method, path, response.status, await problemOf(response));
    return response.status === 204 ? null : response.json();
  }

  /** Signs up as the sign-up page would, then posts what the confirmation page's button would. */
  async signUp() {
    const register = await fetch(`${API}/api/v1/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: this.email,
        password: this.password,
        displayName: this.name,
        locale: 'en',
      }),
    });
    if (register.status !== 202)
      throw new ApiError('POST', '/api/v1/account/register', register.status, {
        title: (await problemOf(register)).title,
      });
    const mail = await mailTo(this.email, '/account/confirm');
    const link = mail.match(/https?:\/\/[^\s"<>]+\/account\/confirm\?[^\s"<>]+/);
    if (!link) throw new Error(`No confirmation link in the mail to ${this.email}`);
    const url = new URL(link[0].replace(/&amp;/g, '&'));
    const confirmed = await fetch(`${API}/api/v1/account/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: url.searchParams.get('userId'),
        code: url.searchParams.get('code'),
      }),
    });
    if (confirmed.status !== 204)
      throw new ApiError('POST', '/api/v1/account/confirm', confirmed.status, {});
  }

  /** Signs in on the API's own page (its form and antiforgery cookie), then takes a CSRF token. */
  async signIn() {
    this.cookies.clear();
    this.csrf = null;
    const page = await this.send('/account/signin');
    const token = (await page.text()).match(/name="__RequestVerificationToken" value="([^"]+)"/);
    if (!token) throw new Error('No antiforgery token on the sign-in page');
    const signedIn = await this.send('/account/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        __RequestVerificationToken: decodeHtml(token[1]),
        Email: this.email,
        Password: this.password,
        ReturnUrl: '',
      }).toString(),
    });
    if (signedIn.status !== 302)
      throw new Error(`Signing in as ${this.role} answered ${signedIn.status}, not a redirect`);
    const csrf = await this.send('/api/v1/account/antiforgery');
    if (!csrf.ok) throw new ApiError('GET', '/api/v1/account/antiforgery', csrf.status, {});
    this.csrf = await csrf.json();
    const me = await this.call('GET', '/api/v1/account/me', undefined, false);
    this.id = me.id;
    this.locale = me.locale;
  }
}

/** A ticket from the real launch route, as "Open in Cash Gear Sheet" asks for one. */
async function launch(person, workbookId) {
  const { url } = await person.call('POST', `/api/v1/workbooks/${workbookId}/launch`);
  const ticket = /#launch=([A-Za-z0-9_-]+)$/.exec(url)?.[1];
  if (!ticket) throw new Error(`The launch URL has no ticket: ${url}`);
  return ticket;
}

/** A workbook made by `editor`, with `viewer` at view. */
async function newWorkbook({ editor, viewer }, workspaceId, name) {
  const book = await editor.call('POST', `/api/v1/workspaces/${workspaceId}/workbooks`, {
    id: null,
    name,
  });
  await editor.call('PUT', `/api/v1/workbooks/${book.id}/permissions`, {
    restricted: false,
    entries: [{ principalType: 'user', principalId: viewer.id, level: 'view' }],
  });
  return book.id;
}

/** The budget's first version, saved as Sheet saves it: a session from a ticket, If-None-Match. */
async function saveFirstVersion(editor, workbookId) {
  const sheet = (path, init) =>
    fetch(`${API}/api/v1/sheet-sessions${path}`, {
      method: 'POST',
      redirect: 'error',
      ...init,
      headers: { Origin: SHEET_ORIGIN, ...init.headers },
    });
  const redeemed = await sheet('/redeem', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: await launch(editor, workbookId) }),
  });
  if (redeemed.status !== 200)
    throw new ApiError('POST', '/api/v1/sheet-sessions/redeem', redeemed.status, {
      ...(await problemOf(redeemed)),
    });
  const { token } = await redeemed.json();
  const bytes = writeXlsx({
    sheets: [
      {
        name: 'Budget',
        rows: [
          ['Item', 'Amount'],
          ['Rent', 1200],
          ['Travel', 300],
          ['Total', 1500],
        ],
      },
    ],
  });
  const saved = await sheet('/workbook/versions', {
    headers: { [SESSION_HEADER]: token, 'Content-Type': XLSX_TYPE, 'If-None-Match': '*' },
    body: bytes,
  });
  if (saved.status !== 201)
    throw new ApiError('POST', '/api/v1/sheet-sessions/workbook/versions', saved.status, {
      ...(await problemOf(saved)),
    });
  await sheet('/end', { headers: { [SESSION_HEADER]: token } });
}

async function setUp() {
  const live = await fetch(`${API}/health/live`).catch(() => null);
  if (!live?.ok)
    throw new Error(
      `No Workspace API on ${API}: start pnpm dev:server or node scripts/server-stack.mjs --e2e`,
    );
  const people = Object.fromEntries(Object.keys(NAMES).map((role) => [role, new Person(role)]));
  await Promise.all(
    Object.values(people).map(async (person) => {
      await person.signUp();
      await person.signIn();
    }),
  );
  const { editor, viewer } = people;
  const workspace = await editor.call('POST', '/api/v1/workspaces', {
    id: randomUUID(),
    name: 'Sheet contract',
    icon: null,
  });
  await editor.call('POST', `/api/v1/workspaces/${workspace.id}/invites`, {
    email: viewer.email,
    role: 'member',
  });
  const invite = /\/#\/invite\/([A-Za-z0-9_-]+)/.exec(await mailTo(viewer.email, '/#/invite/'));
  if (!invite) throw new Error(`No invitation link in the mail to ${viewer.email}`);
  await viewer.call('POST', '/api/v1/invites/accept', { token: invite[1] });
  const budget = await newWorkbook(people, workspace.id, 'Budget 2027');
  await saveFirstVersion(editor, budget);
  const seen = await viewer.call('GET', `/api/v1/workbooks/${budget}`);
  if (seen.access !== 'view' || !seen.versionId)
    throw new Error(`The viewer sees the budget at ${seen.access}, version ${seen.versionId}`);
  return { people, workspaceId: workspace.id, budget };
}

/** What is wrong with a request body, or null. */
function refusal(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return 'The body is a JSON object {user, workbook, access?, language?}';
  const extra = Object.keys(body).find((key) => !FIELDS.includes(key));
  if (extra) return `Unknown field ${extra}`;
  if (!Object.hasOwn(NAMES, body.user)) return 'user is editor, viewer or other';
  if (!WORKBOOKS.includes(body.workbook)) return 'workbook is budget or empty';
  if (body.access !== undefined) {
    if (body.access !== 'edit' && body.access !== 'view') return 'access is edit or view';
    if (LEVELS[body.user] && body.access !== LEVELS[body.user])
      return `A ticket for ${body.user} is ${LEVELS[body.user]}: the server binds a ticket to the person's level, so access cannot narrow it`;
  }
  if (body.language !== undefined && body.language !== 'en' && body.language !== 'ar')
    return 'language is en or ar';
  return null;
}

/** One request at a time per person, so a language set is the one its launch sees. */
const queues = new Map();
function inTurn(key, task) {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  queues.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

function readBody(request, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    request.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function answer(request, state) {
  const path = new URL(request.url ?? '/', 'http://launcher').pathname;
  if (request.method !== 'POST' || path !== '/')
    return [400, { error: 'POST / {user, workbook, access?, language?}' }];
  const text = await readBody(request);
  let body;
  try {
    body = JSON.parse(text ?? '');
  } catch {
    return [400, { error: 'The body is not JSON (or over 16 KB)' }];
  }
  const wrong = refusal(body);
  if (wrong) return [400, { error: wrong }];
  const person = state.people[body.user];
  request.what = `${body.user} ${body.workbook}${body.language ? ` ${body.language}` : ''}`;
  return inTurn(body.user, async () => {
    const language = body.language ?? 'en';
    if (person.locale !== language) {
      await person.call('PATCH', '/api/v1/account/me', { displayName: null, locale: language });
      person.locale = language;
    }
    const workbookId =
      body.workbook === 'budget'
        ? state.budget
        : await newWorkbook(state.people, state.workspaceId, 'New workbook');
    try {
      return [200, { ticket: await launch(person, workbookId) }];
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404))
        return [403, { error: `The API refused ${body.user} a ticket: ${error.message}` }];
      throw error;
    }
  });
}

let state;
try {
  console.log(`Setting up the launcher's people and workbooks on ${API}`);
  state = await setUp();
} catch (error) {
  console.error(`The Sheet launcher could not start: ${error.message}`);
  process.exit(1);
}

const server = createServer(async (request, response) => {
  let status;
  let body;
  try {
    [status, body] = await answer(request, state);
  } catch (error) {
    console.error(error);
    [status, body] = [502, { error: error.message }];
  }
  console.log([request.method, request.url, request.what, status].filter(Boolean).join(' '));
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
});
server.on('error', (error) => {
  console.error(`The Sheet launcher could not listen on 127.0.0.1:${PORT}: ${error.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () =>
  console.log(`Sheet launcher ready on http://127.0.0.1:${PORT}`),
);
