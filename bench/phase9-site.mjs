// Phase 9's site budgets (IMPLEMENTATION_PLAN.md, Phase 9, Performance benchmarks: "a published
// page of 2,000 blocks: first byte p95 <= 200 ms from the cache, <= 1 s rendered fresh"), as a
// piece for bench/phase9.mjs to run and gate with its other figures. Written by the server stream
// and not run there (the parent's proof runs the benches, which own the server stack and the
// ports): against the e2e stack (scripts/server-stack.mjs --e2e), the API on 127.0.0.1:5280 and
// the Sites process on http://localhost:5290.
//
//   import { SITE_BUDGETS, measureSite, seedSite } from './phase9-site.mjs';
//   const api = await apiSession(await newAccount('Site bench'));   // scripts/cloud-account.mjs
//   const seeded = await seedSite(api, { log });
//   const figures = await measureSite(seeded, { log });
//
// The site: a small root page and PHASE9_SITE_PAGES (20) pages under it, each of
// PHASE9_SITE_BLOCKS (2,000) blocks (a heading every tenth block, paragraphs of a sentence or two
// with bold and a link, a bulleted item every seventh), pushed through the document route as one
// update each, as a device's first push is, validated and derived by the worker; the root
// published. Then over HTTP with no account, the time to the first byte of each answer (fetch
// resolves with the headers):
//   - fresh: each page's first request after publishing (its key is new: read and drawn now), p95
//     over the pages (budget 1,000 ms);
//   - cached: PHASE9_SITE_RUNS (10) more requests of each page (the drawn answer from the Sites
//     process's memory, after the few reads its key needs), p95 (budget 200 ms).
// Every answer is checked: 200, the strict policy, no cookie, the page's last block in it.
//
// Run alone (against a stack already running): node bench/phase9-site.mjs
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from '../scripts/lib.mjs';

const Y = createRequire(join(root, 'packages/doc/package.json'))('yjs');

/** Budgets, with the margin a regression must also exceed to fail, as bench/phase4.mjs has them. */
export const SITE_BUDGETS = {
  siteCachedFirstByteP95Ms: { max: 200, unit: 'ms', slack: 50 },
  siteFreshFirstByteP95Ms: { max: 1000, unit: 'ms', slack: 200 },
  // Tracked, not budgeted.
  siteSeedMs: { max: Infinity, unit: 'ms', slack: 10000 },
  siteBytes: { max: Infinity, unit: 'bytes', slack: Infinity },
};

const PAGES = Number(process.env.PHASE9_SITE_PAGES ?? 20);
const BLOCKS = Number(process.env.PHASE9_SITE_BLOCKS ?? 2000);
const RUNS = Number(process.env.PHASE9_SITE_RUNS ?? 10);
export const SITES = process.env.E2E_SITES_URL ?? 'http://localhost:5290';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uuidv7() {
  const bytes = randomBytes(16);
  let time = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const blockId = () => Array.from(randomBytes(12), (b) => BASE62[b % 62]).join('');

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
    : NaN;
};
const summary = (values) => ({
  n: values.length,
  p50: Math.round(percentile(values, 50) * 10) / 10,
  p95: Math.round(percentile(values, 95) * 10) / 10,
  max: Math.round(Math.max(...values) * 10) / 10,
});

/**
 * One page's whole document as a first push, as the binding writes it: `meta` (schema version 6,
 * epoch 0, the page's id) and `content`, blocks of one body each, every block with its id.
 */
function documentUpdate(pageId, clientId, blocks, label) {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('schemaVersion', 6);
    meta.set('epoch', 0);
    meta.set('pageId', pageId);
    const content = doc.getXmlFragment('content');
    const made = [];
    for (let i = 0; i < blocks; i++) {
      const block = new Y.XmlElement('block');
      block.setAttribute('id', blockId());
      const body = new Y.XmlElement('textBody');
      const text = new Y.XmlText();
      if (i % 10 === 0) {
        body.setAttribute('kind', 'heading');
        body.setAttribute('level', ((i / 10) % 3) + 1);
        text.insert(0, `${label}: section ${i / 10 + 1}`);
      } else {
        body.setAttribute('kind', i % 7 === 0 ? 'bulletItem' : 'paragraph');
        text.insert(0, `Block ${i} of ${label}, a sentence of the kind a handbook holds, with `);
        text.insert(text.length, 'a bold part', { bold: {} });
        text.insert(text.length, ' and ');
        text.insert(text.length, 'a link', { link: { href: 'https://example.com/handbook' } });
        text.insert(text.length, '.');
      }
      body.insert(0, [text]);
      block.insert(0, [body]);
      made.push(block);
    }
    content.insert(0, made);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** Order key digits (base 62): the pages are a1, a2, … az. */
const ORDER_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The site: a workspace, a root page and PAGES pages of BLOCKS blocks under it, pushed, validated
 * and derived; the root published. `api` is scripts/cloud-account.mjs's `apiSession`.
 */
export async function seedSite(api, { pages = PAGES, blocks = BLOCKS, log = console.log } = {}) {
  if (pages > ORDER_DIGITS.length - 1) throw new Error(`At most ${ORDER_DIGITS.length - 1} pages`);
  const started = Date.now();
  const now = new Date().toISOString();
  const workspace = uuidv7();
  await api.post('/api/v1/workspaces', { id: workspace, name: 'Site bench' });
  const section = uuidv7();
  const op = (type, entityId, payload) => ({
    opId: uuidv7(),
    type,
    workspaceId: workspace,
    entityId,
    baseVersion: null,
    payload,
    createdAt: now,
  });
  const page = (id, parent, orderKey, title) =>
    op('page.create', id, {
      id,
      workspaceId: workspace,
      sectionId: section,
      parentPageId: parent,
      orderKey,
      kind: 'page',
      title,
      icon: null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      trashRootId: null,
    });
  const rootPage = uuidv7();
  const children = Array.from({ length: pages }, () => uuidv7());
  const ops = [
    op('section.create', section, {
      id: section,
      workspaceId: workspace,
      name: 'Handbook',
      orderKey: 'a0',
      visibility: 'workspace',
      version: 1,
      createdAt: now,
    }),
    page(rootPage, null, 'a0', 'Site bench'),
    // Integer order keys a1, a2, … az (base 62, no trailing zero): enough for 61 pages.
    ...children.map((id, i) => page(id, rootPage, `a${ORDER_DIGITS[i + 1]}`, `Chapter ${i + 1}`)),
  ];
  for (let i = 0; i < ops.length; i += 100) {
    const answer = await api.post(`/api/v1/workspaces/${workspace}/ops`, {
      ops: ops.slice(i, i + 100),
    });
    if (answer.results.some((r) => r.status !== 'applied'))
      throw new Error(
        `An operation was refused: ${JSON.stringify(answer.results.find((r) => r.status !== 'applied'))}`,
      );
  }
  const clientId = 1_000_000 + Math.floor(Math.random() * 1_000_000);
  await api.post(`/api/v1/workspaces/${workspace}/yjs-clients`, { register: [clientId] });
  const last = (i) => `Block ${blocks - 1} of Chapter ${i + 1},`;
  for (const [i, id] of children.entries()) {
    const update = documentUpdate(id, clientId, blocks, `Chapter ${i + 1}`);
    await api.post(`/api/v1/pages/${id}/doc/updates`, {
      epoch: 0,
      clientSchemaVersion: 6,
      updates: [{ updateId: uuidv7(), data: Buffer.from(update).toString('base64') }],
    });
  }
  log(`  ${pages} pages of ${blocks} blocks pushed; waiting for the worker to derive them...`);
  for (const [i, id] of children.entries()) {
    for (let attempt = 0; ; attempt++) {
      const answer = await api.raw(`/api/v1/pages/${id}/doc/json`);
      if (answer.status === 200 && answer.body.includes(last(i))) break;
      if (attempt > 600) throw new Error(`The worker did not derive ${id}`);
      await sleep(200);
    }
  }
  const slug = `bench-${Date.now().toString(36)}`;
  const site = await api.put(`/api/v1/pages/${rootPage}/site`, {
    slug,
    indexing: false,
    language: 'en',
  });
  log(`  published at ${site.url}`);
  return {
    workspace,
    root: rootPage,
    pages: children,
    slug,
    url: site.url,
    last,
    seedMs: Date.now() - started,
  };
}

/** One request's time to its first byte, and its checks. */
async function firstByte(url, expect) {
  const started = performance.now();
  const response = await fetch(url, { redirect: 'manual' });
  const ms = performance.now() - started;
  const body = await response.text();
  if (response.status !== 200) throw new Error(`${url}: ${response.status}`);
  if (!(response.headers.get('content-security-policy') ?? '').startsWith("default-src 'none'"))
    throw new Error(`${url}: no strict policy`);
  if (response.headers.get('set-cookie')) throw new Error(`${url}: a cookie was set`);
  if (!body.includes(expect)) throw new Error(`${url}: the page's last block is not in it`);
  return { ms, bytes: Buffer.byteLength(body) };
}

/** The figures: fresh and cached first byte, over every page. */
export async function measureSite(seeded, { sites = SITES, runs = RUNS, log = console.log } = {}) {
  const base = `${sites}/${seeded.slug}`;
  // The site's record and scope are read once, for the first request; then each page fresh.
  await firstByte(base, 'Chapter 1');
  const fresh = [];
  let bytes = 0;
  for (const [i, id] of seeded.pages.entries()) {
    const one = await firstByte(`${base}/${id}`, seeded.last(i));
    fresh.push(one.ms);
    bytes = Math.max(bytes, one.bytes);
  }
  const cached = [];
  for (let run = 0; run < runs; run++)
    for (const [i, id] of seeded.pages.entries())
      cached.push((await firstByte(`${base}/${id}`, seeded.last(i))).ms);
  const figures = {
    siteFreshFirstByteP95Ms: summary(fresh).p95,
    siteCachedFirstByteP95Ms: summary(cached).p95,
    siteSeedMs: seeded.seedMs,
    siteBytes: bytes,
    detail: {
      fresh: summary(fresh),
      cached: summary(cached),
      pages: seeded.pages.length,
      url: base,
    },
  };
  log(
    `  site: fresh p95 ${figures.siteFreshFirstByteP95Ms} ms (budget ${SITE_BUDGETS.siteFreshFirstByteP95Ms.max}), cached p95 ${figures.siteCachedFirstByteP95Ms} ms (budget ${SITE_BUDGETS.siteCachedFirstByteP95Ms.max}), ${Math.round(bytes / 1024)} KB a page`,
  );
  return figures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { apiSession, newAccount } = await import('../scripts/cloud-account.mjs');
  const api = await apiSession(await newAccount('Site bench'));
  try {
    const seeded = await seedSite(api);
    const figures = await measureSite(seeded);
    const over = Object.entries(SITE_BUDGETS).filter(([key, budget]) => figures[key] > budget.max);
    console.log(JSON.stringify(figures, null, 2));
    if (over.length) {
      console.error(`Over budget: ${over.map(([key]) => key).join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await api.dispose();
  }
}
