// A mock of Cash Gear Sheet for Workspace's Phase 5 tests (plain Node ESM, no dependencies):
//
// - `GET /embed` speaks sheet-embed.1 (docs/INTEGRATIONS.md) with its own validation
//   (`protocol.mjs`): reads the workbook from the source it is given, draws the view as a table,
//   answers `requestPreview` from a canvas; sent with `frame-ancestors` for Workspace's
//   development origins (and the desktop's), as Sheet's `/embed` will be.
// - `GET /cloud#launch=<ticket>` is Sheet's launch route as a mock: redeems the ticket at
//   Workspace's API (`CGW_API`, default http://127.0.0.1:5280), reads the workbook, and its
//   "Save" writes a new version with `If-Match` or `If-None-Match: *` (sheet-session.1).
// - Controls: `POST /__mock/fault {code, times?, on?}` (the next answers of the embed, to any
//   message or to `on` only, are `error` with that code), `POST /__mock/reset`,
//   `GET /__mock/state` (`{faults, events, api}`: what the pages did, never a URL or a token),
//   and `GET /__mock/fixture/{budget|wide|empty|garbage}.xlsx[?status=403][&pad=bytes]`.
//
//   node tests/mocks/sheet/server.mjs [--port 4283] [--host 127.0.0.1] [--api http://127.0.0.1:5280]
//   (or CGW_MOCK_SHEET_PORT, CGW_API)

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES } from './fixtures.mjs';
import { ERROR_CODES } from './protocol.mjs';
import { XLSX_TYPE } from './xlsx.mjs';

export const DEFAULT_PORT = 4283;
export const DEFAULT_API = 'http://127.0.0.1:5280';

/** Who may frame `/embed`: Workspace's development pages and the desktop app. */
export const FRAME_ANCESTORS = Object.freeze([
  'http://127.0.0.1:5273',
  'http://127.0.0.1:4273',
  'http://localhost:5273',
  'http://localhost:4273',
  'tauri://localhost',
  'http://tauri.localhost',
]);

const MESSAGE_TYPES = ['init', 'setView', 'refresh', 'requestPreview'];
const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = new Set(['/embed.js', '/cloud.js', '/protocol.mjs', '/xlsx.mjs']);
const MAX_EVENTS = 500;

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const EMBED_HEADERS = {
  ...NO_STORE,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': `frame-ancestors ${FRAME_ANCESTORS.join(' ')}`,
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Referrer-Policy': 'no-referrer',
};
const PAGE_HEADERS = {
  ...NO_STORE,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};
const SCRIPT_HEADERS = {
  ...NO_STORE,
  'Content-Type': 'text/javascript; charset=utf-8',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const escapeAttribute = (text) =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function send(res, status, headers, body = '') {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, value) {
  send(res, status, { ...NO_STORE, 'Content-Type': 'application/json' }, JSON.stringify(value));
}

async function body(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class SheetMock {
  constructor(api) {
    this.api = api;
    this.origins = [];
    this.reset();
  }

  reset() {
    this.faults = [];
    this.events = [];
  }

  state() {
    return {
      api: this.api,
      faults: this.faults.map((f) => ({ ...f })),
      events: this.events.map((e) => ({ ...e })),
    };
  }

  /** Records what a page did; a URL or a token is never sent here. */
  record(event) {
    this.events.push({ at: new Date().toISOString(), ...event });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  takeFault(on) {
    const index = this.faults.findIndex((f) => f.on === undefined || f.on === on);
    if (index < 0) return null;
    const fault = this.faults[index];
    fault.times--;
    if (fault.times <= 0) this.faults.splice(index, 1);
    return fault.code;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://mock.invalid');
    const path = url.pathname;
    if (path.startsWith('/__mock/')) return this.control(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { ...NO_STORE, Allow: 'GET' });
    }
    if (path === '/embed') {
      return send(res, 200, EMBED_HEADERS, await readFile(resolve(HERE, 'embed.html')));
    }
    if (path === '/cloud') {
      const html = (await readFile(resolve(HERE, 'cloud.html'), 'utf8')).replace(
        '%CGW_API%',
        escapeAttribute(this.api),
      );
      return send(res, 200, PAGE_HEADERS, html);
    }
    if (SCRIPTS.has(path)) {
      return send(res, 200, SCRIPT_HEADERS, await readFile(resolve(HERE, path.slice(1))));
    }
    if (path === '/') {
      const links = ['/embed', '/cloud', '/__mock/state'].map(
        (p) => `<li><a href="${p}">${p}</a></li>`,
      );
      return send(
        res,
        200,
        PAGE_HEADERS,
        `<!doctype html><title>Mock Sheet</title><ul>${links.join('')}</ul>`,
      );
    }
    return send(res, 404, { ...NO_STORE, 'Content-Type': 'text/plain' }, 'Not found');
  }

  async control(req, res, url) {
    // Tests (no Origin) and the mock's own pages only.
    const origin = req.headers.origin;
    if (origin !== undefined && !this.origins.includes(origin)) {
      return json(res, 403, { code: 'origin.denied' });
    }
    const route = `${req.method} ${url.pathname}`;
    const fixture = /^\/__mock\/fixture\/([a-z]+)\.xlsx$/.exec(url.pathname);
    if (req.method === 'GET' && fixture) return this.fixture(res, fixture[1], url.searchParams);
    switch (route) {
      case 'GET /__mock/state':
        return json(res, 200, this.state());
      case 'POST /__mock/reset':
        this.reset();
        return json(res, 200, this.state());
      case 'POST /__mock/fault': {
        let input;
        try {
          input = JSON.parse(await body(req));
        } catch {
          return json(res, 400, { code: 'request.invalid' });
        }
        const times = input.times ?? 1;
        const okOn = input.on === undefined || MESSAGE_TYPES.includes(input.on);
        if (!ERROR_CODES.includes(input.code) || !Number.isInteger(times) || times < 1 || !okOn) {
          return json(res, 400, { code: 'request.invalid' });
        }
        this.faults.push({ code: input.code, times, ...(input.on ? { on: input.on } : {}) });
        return json(res, 200, { faults: this.faults });
      }
      case 'POST /__mock/next-fault':
        return json(res, 200, { code: this.takeFault(url.searchParams.get('on') ?? '') });
      case 'POST /__mock/event': {
        try {
          const event = JSON.parse(await body(req));
          if (event && typeof event === 'object' && !Array.isArray(event)) this.record(event);
        } catch {
          return json(res, 400, { code: 'request.invalid' });
        }
        return send(res, 204, NO_STORE);
      }
      default:
        return json(res, 404, { code: 'not.found' });
    }
  }

  fixture(res, name, params) {
    const status = Number(params.get('status') ?? 200);
    const headers = {
      ...NO_STORE,
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (status !== 200)
      return send(res, status, { ...headers, 'Content-Type': 'text/plain' }, 'Refused');
    let bytes;
    if (name === 'garbage') bytes = new TextEncoder().encode('This is not a workbook.');
    else if (FIXTURES[name]) bytes = FIXTURES[name]();
    else return send(res, 404, headers, 'No such fixture');
    const pad = Number(params.get('pad') ?? 0);
    const out = Buffer.concat([
      Buffer.from(bytes),
      Buffer.alloc(Number.isInteger(pad) && pad > 0 ? pad : 0),
    ]);
    return send(
      res,
      200,
      { ...headers, 'Content-Type': XLSX_TYPE, 'Content-Length': out.length },
      out,
    );
  }
}

/** Starts the mock; `port` 0 picks a free one. */
export async function startSheetMock({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  api = DEFAULT_API,
} = {}) {
  const mock = new SheetMock(api);
  const server = createServer((req, res) =>
    mock.handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, error.status ?? 500, { code: 'server.error' });
      else res.destroy();
    }),
  );
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, done);
  });
  const bound = server.address().port;
  mock.origins = [`http://127.0.0.1:${bound}`, `http://localhost:${bound}`];
  return {
    url: `http://${host}:${bound}`,
    port: bound,
    state: () => mock.state(),
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const port = Number(arg('port') ?? process.env.CGW_MOCK_SHEET_PORT ?? DEFAULT_PORT);
  const api = arg('api') ?? process.env.CGW_API ?? DEFAULT_API;
  const started = await startSheetMock({ port, host: arg('host') ?? '127.0.0.1', api });
  console.log(`Mock Sheet on ${started.url} (Workspace API ${api})`);
}
