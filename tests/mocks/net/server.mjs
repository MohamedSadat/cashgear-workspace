// A host a plugin may reach (Phase 13, M13.1): the e2e specs and the bench name it in a plugin's
// manifest. It answers anything with CORS open to any origin (a sandboxed frame's is "null") and
// records each request it took: the method, the host the request named (`localhost:4288` and
// `127.0.0.1:4288` are two hosts to a browser's CSP, one server here), the path, the body and
// (Phase 15: a webhook's call) the headers. Plain
// Node, no dependencies.
//
//   node tests/mocks/net/server.mjs [--port 4288]
//
// `GET /__mock/state`, `GET /__mock/requests`, `POST /__mock/reset`. It listens on 127.0.0.1 and ::1
// only (a browser may resolve `localhost` to either), never on another interface.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4288;

const MAX_BODY = 64 * 1024;

export function startNetMock({ port = DEFAULT_PORT } = {}) {
  /** @type {{ method: string, host: string, path: string, body: string, headers: Record<string, string>, at: string }[]} */
  let requests = [];
  const handler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    };
    const json = (status, value) => {
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/__mock/state') return json(200, { ok: true, requests: requests.length });
    if (url.pathname === '/__mock/requests') return json(200, { requests });
    if (url.pathname === '/__mock/reset' && req.method === 'POST') {
      requests = [];
      return json(200, { ok: true });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        host: String(req.headers.host ?? ''),
        path: url.pathname + url.search,
        body: Buffer.concat(chunks).toString('utf8'),
        // Phase 15: a webhook's signature and its parts, which a spec checks as a receiver would.
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(', ') : String(v ?? ''),
          ]),
        ),
        at: new Date().toISOString(),
      });
      if (requests.length > 10_000) requests = requests.slice(-5_000);
      json(200, { ok: true });
    });
  };
  const servers = ['127.0.0.1', '::1'].map((host) => {
    const server = createServer(handler);
    server.on('error', (error) => {
      // A machine without IPv6 on its loopback still serves 127.0.0.1.
      if (host === '::1') return;
      throw error;
    });
    server.listen(port, host);
    return server;
  });
  return {
    port,
    close: () => Promise.all(servers.map((s) => new Promise((done) => s.close(() => done())))),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port');
  const port = Number(
    at > 0 ? process.argv[at + 1] : (process.env.CGW_MOCK_NET_PORT ?? DEFAULT_PORT),
  );
  startNetMock({ port });
  console.log(`Plugin network mock on http://127.0.0.1:${port} (and localhost)`);
}
