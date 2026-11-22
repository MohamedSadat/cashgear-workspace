// Phase 14's site budget (IMPLEMENTATION_PLAN.md, Phase 14, Performance benchmarks: "a published
// page of 2,000 blocks at its domain, first byte p95 <= 200 ms from the cache, the limiter and the
// host's lookup included"), as a piece for bench/phase14.mjs to run and gate. Against the e2e stack
// (scripts/server-stack.mjs --e2e: the API on 127.0.0.1:5280, the Sites process on localhost:5290,
// its worker getting certificates from the mock ACME server on 4289) and the mock provider's DNS
// stand-in on 4287.
//
// The site: Phase 9's (bench/phase9-site.mjs's seedSite: a root and PHASE14_SITE_PAGES (10) pages of
// 2,000 blocks under it), published, then given a `*.localhost` host name its workspace proves
// through the DNS stand-in; the worker makes its certificate. Then over HTTP with no account, at the
// name (asked of 127.0.0.1:5290 with the name in `Host`, as a browser at the name would), the time to
// the first byte:
//   - fresh: each page's first request at the name (its key is new: read and drawn now), tracked;
//   - cached: PHASE14_SITE_RUNS (10) more requests of each page, p95 (budget 200 ms).
// Every answer is checked: 200, the strict policy, no cookie, the page's last block in it. Writes
// bench/results/phase14-site.json.
//
// Run alone (against a stack already running): node bench/phase14-site.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from '../scripts/lib.mjs';
import { seedSite, SITES } from './phase9-site.mjs';

export const DOMAIN_BUDGETS = {
  domainCachedFirstByteP95Ms: { max: 200, unit: 'ms' },
};

const PAGES = Number(process.env.PHASE14_SITE_PAGES ?? 10);
const RUNS = Number(process.env.PHASE14_SITE_RUNS ?? 10);
const DNS = process.env.E2E_DNS_URL ?? 'http://127.0.0.1:4287';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  const round = (n) => Math.round(n * 10) / 10;
  return {
    runs: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1)),
  };
};

/** One request to the Sites process at a host name: its time to the first byte, and its checks. */
function firstByteAt(host, path, expect) {
  const sites = new URL(SITES);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const asked = request(
      {
        host: '127.0.0.1',
        port: Number(sites.port || 80),
        path,
        headers: { Host: `${host}:${sites.port}` },
      },
      (answer) => {
        const ms = performance.now() - started;
        const chunks = [];
        answer.on('data', (chunk) => chunks.push(chunk));
        answer.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (answer.statusCode !== 200)
            return reject(new Error(`${host}${path}: ${answer.statusCode}`));
          if (
            !String(answer.headers['content-security-policy'] ?? '').startsWith(
              "default-src 'none'",
            )
          )
            return reject(new Error(`${host}${path}: no strict policy`));
          if (answer.headers['set-cookie'])
            return reject(new Error(`${host}${path}: a cookie was set`));
          if (!body.includes(expect))
            return reject(new Error(`${host}${path}: the page's last block is not in it`));
          resolve({ ms, bytes: Buffer.byteLength(body) });
        });
      },
    );
    asked.on('error', reject);
    asked.end();
  });
}

/**
 * The seeded site given a host name: added, its `TXT` record set in the DNS stand-in, verified,
 * attached; then waited for until its certificate is live (the worker and the mock ACME server).
 */
export async function seedDomain(api, seeded, { log = console.log } = {}) {
  const host = `bench-${Date.now().toString(36)}.localhost`;
  const added = await api.post(`/api/v1/workspaces/${seeded.workspace}/publishing/domains`, {
    host,
  });
  const set = await fetch(`${DNS}/__mock/dns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: added.record.name, txt: added.record.value }),
  });
  if (set.status !== 204) throw new Error(`The DNS stand-in answered ${set.status}`);
  await api.post(
    `/api/v1/workspaces/${seeded.workspace}/publishing/domains/${added.id}/verify`,
    {},
  );
  await api.put(`/api/v1/pages/${seeded.root}/site/domain`, { host });
  const started = Date.now();
  for (;;) {
    const site = (await api.get(`/api/v1/pages/${seeded.root}/site`)).site;
    if (site?.domain?.certificate === 'live') break;
    if (Date.now() - started > 180000)
      throw new Error(`No certificate for ${host} after 3 minutes (${site?.domain?.certificate})`);
    await sleep(1000);
  }
  log(`  ${host}: its certificate live in ${Math.round((Date.now() - started) / 1000)} s`);
  return host;
}

export async function measureDomain(seeded, host, { runs = RUNS, log = console.log } = {}) {
  await firstByteAt(host, '/', 'Chapter 1');
  const fresh = [];
  let bytes = 0;
  for (const [i, id] of seeded.pages.entries()) {
    const one = await firstByteAt(host, `/${id}`, seeded.last(i));
    fresh.push(one.ms);
    bytes = Math.max(bytes, one.bytes);
  }
  const cached = [];
  for (let run = 0; run < runs; run++)
    for (const [i, id] of seeded.pages.entries())
      cached.push((await firstByteAt(host, `/${id}`, seeded.last(i))).ms);
  const figures = {
    domainFreshFirstByteP95Ms: summary(fresh).p95,
    domainCachedFirstByteP95Ms: summary(cached).p95,
    domainBytes: bytes,
    detail: { fresh: summary(fresh), cached: summary(cached), pages: seeded.pages.length, host },
  };
  log(
    `  at its name: fresh p95 ${figures.domainFreshFirstByteP95Ms} ms, cached p95 ${figures.domainCachedFirstByteP95Ms} ms (budget ${DOMAIN_BUDGETS.domainCachedFirstByteP95Ms.max}), ${Math.round(bytes / 1024)} KB a page`,
  );
  return figures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { apiSession, newAccount } = await import('../scripts/cloud-account.mjs');
  const api = await apiSession(await newAccount('Domain bench'));
  try {
    const seeded = await seedSite(api, { pages: PAGES });
    const host = await seedDomain(api, seeded);
    const figures = await measureDomain(seeded, host);
    mkdirSync(join(root, 'bench/results'), { recursive: true });
    writeFileSync(
      join(root, 'bench/results/phase14-site.json'),
      JSON.stringify({ figures }, null, 2) + '\n',
    );
    console.log(JSON.stringify(figures, null, 2));
    const over = Object.entries(DOMAIN_BUDGETS).filter(
      ([key, budget]) => figures[key] > budget.max,
    );
    if (over.length) {
      console.error(`Over budget: ${over.map(([key]) => key).join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await api.dispose();
  }
}
