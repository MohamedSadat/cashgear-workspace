// A mock of Anthropic's Messages API for Workspace's AI (docs/INTEGRATIONS.md, AI): `POST
// /v1/messages`, streamed as server-sent events in the real API's shape (message_start,
// content_block_start, content_block_delta, content_block_stop, message_delta, message_stop), or as
// one JSON message without `stream`. Plain Node, no dependencies. The server's tests
// (`server/tests/Cgw.Tests`) and the browser tests point the API at it (`Ai__AnthropicBaseUrl`), so
// no request ever leaves for the real provider.
//
//   node tests/mocks/ai/server.mjs [--port 4286] [--host 127.0.0.1]
//
// The port also comes from CGW_MOCK_AI_PORT. The key comes as `Authorization: Bearer` (API version
// 2026-10-21, as the SDKs send it) or `x-api-key`. Each request is recorded with its body, its
// headers' names and the workspace's key as a hash (`keyId`, the first 16 hex digits of its SHA-256), never the key:
// `GET /__mock/requests[?keyId=…]`. `POST /__mock/script` queues answers, `POST /__mock/fault`
// queues failures, `POST /__mock/reset` forgets everything. A key starting `sk-mock-invalid` is
// refused as the real API refuses a bad key (401).
//
// Unscripted, it answers each action (read from the system prompt's first line, "Cash Gear
// Workspace AI task: <action>.") with something made from what it was sent, so a test can tell
// that the answer reached the page: `[rewritten] <text>`, `Summary: …`, JSON for the JSON actions.
//
// Phase 10: Voyage AI's embeddings API as well (`Ai__VoyageBaseUrl` points the server at it):
// `POST /v1/embeddings` in Voyage's shape (`{input, model, input_type, output_dimension: 1024,
// output_dtype: "int8", truncation}` in; `{object: "list", data: [{object: "embedding", embedding,
// index}], model, usage: {total_tokens}}` out), the vectors made from the concept lexicon in
// `embeddings.mjs`, deterministic. Each call is recorded with the key as its `keyId`, the model, the
// input type, how many inputs and the inputs themselves: `GET /__mock/embeddings[?keyId=…]`.
// `POST /__mock/fault` with `endpoint: "embeddings"` queues a failure for it (`status` 401, 429,
// 500, or `latencyMs`); a key starting `pa-mock-invalid` or `sk-mock-invalid` is refused (401).
// `POST /__mock/reset` forgets these too.

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIMENSIONS, MODELS, embedFloat, embedInt8, tokensOf } from './embeddings.mjs';

export const DEFAULT_PORT = 4286;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_KEPT = 500;

/** The workspace key's stand-in in every record: never the key itself. */
export function keyId(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** What the request's user message holds between `<name>` and `</name>`. */
function tagged(text, name) {
  const match = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text);
  return match ? match[1] : '';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  return '';
}

function systemOf(system) {
  return typeof system === 'string' ? system : textOf(system);
}

/** The action named on the system prompt's first line. */
export function actionOf(body) {
  const match = /^Cash Gear Workspace AI task: ([A-Za-z]+)\./.exec(systemOf(body.system));
  return match ? match[1] : null;
}

/** The unscripted answer for an action: text, or JSON for the actions that ask for JSON. */
export function defaultAnswer(body) {
  const user = (body.messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => textOf(m.content))
    .join('\n');
  switch (actionOf(body)) {
    case 'rewrite': {
      const text = tagged(user, 'text');
      const target = /Translate the text into (\w+)/.exec(systemOf(body.system));
      return { text: target ? `[translated to ${target[1]}] ${text}` : `[rewritten] ${text}` };
    }
    case 'summarise': {
      const text = tagged(user, 'text').trim();
      // The first line's first sentence: a summary that repeats a page's lines would make them
      // look like the page's own text to the next action asked about it.
      return { text: `Summary: ${text.split(/\n|(?<=[.!?؟])\s/)[0].slice(0, 200)}` };
    }
    case 'actionItems': {
      const lines = tagged(user, 'text')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /\b(todo|to do)\b/i.test(line));
      const items = (lines.length > 0 ? lines : ['Follow up on this page']).map((line) => ({
        text: line.replace(/^(todo|to do)[:\s]*/i, ''),
      }));
      return { json: { items } };
    }
    case 'generatePage': {
      const prompt = tagged(user, 'request').trim();
      return {
        text: `# ${prompt.slice(0, 60)}\n\nGenerated for: ${prompt}\n\n- First point\n- Second point`,
      };
    }
    case 'generateDatabase':
      return {
        json: {
          name: `Generated: ${tagged(user, 'request').trim().slice(0, 40)}`,
          properties: [
            { name: 'Name', type: 'text', options: [] },
            { name: 'Status', type: 'select', options: ['Open', 'Done'] },
            { name: 'Due', type: 'date', options: [] },
            { name: 'Points', type: 'number', options: [] },
          ],
          rows: [
            { values: ['First task', 'Open', '2026-12-01', 3] },
            { values: ['Second task', 'Done', null, 5] },
          ],
        },
      };
    case 'ask': {
      const pages = [...user.matchAll(/<page number="(\d+)">\nTitle: ([^\n]*)/g)];
      return {
        text:
          pages.length > 0
            ? `The pages say so: ${pages.map(([, n, title]) => `${title} [${n}]`).join(', ')}.`
            : 'No page answers that.',
      };
    }
    case 'erpChanges': {
      let fields;
      let records;
      try {
        fields = JSON.parse(tagged(user, 'fields'));
        records = JSON.parse(tagged(user, 'records'));
      } catch {
        return { json: { changes: [] } };
      }
      const field = fields.find((f) => f.type === 'text');
      const changes = field
        ? records.slice(0, 3).map((record) => {
            const now = String(record.values?.[field.name] ?? '');
            const max = field.maxLength ?? 150;
            return { id: record.id, field: field.name, to: `${now} (AI)`.slice(0, max) };
          })
        : [];
      return { json: { changes } };
    }
    default:
      return { text: 'Hello from the mock provider.' };
  }
}

/** Pieces of about three words each, as a stream sends them. */
function pieces(text, size = 3) {
  const words = text.split(/(?<=\s)/);
  const out = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(''));
  return out.length > 0 ? out : [''];
}

const tokens = (text) => Math.max(1, Math.ceil(text.length / 4));

export class MockAi {
  constructor() {
    this.reset();
  }

  reset() {
    this.requests = [];
    /** Queued answers and faults, each for one key (`keyId`) or any (`null`). */
    this.scripts = [];
    this.faults = [];
    /** Phase 10: the embeddings calls, and the faults queued for them. */
    this.embeddings = [];
    this.embeddingFaults = [];
  }

  take(list, id) {
    const index = list.findIndex((item) => item.keyId === null || item.keyId === id);
    if (index < 0) return null;
    const [item] = list.splice(index, 1);
    return item;
  }

  state() {
    return {
      requests: this.requests.length,
      scripts: this.scripts.length,
      faults: this.faults.length,
      embeddings: this.embeddings.length,
      embeddingFaults: this.embeddingFaults.length,
    };
  }

  /** `POST /v1/embeddings`, as Voyage answers it. */
  async embed(req, res, send) {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { detail: 'The request body is not valid JSON.' });
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    const key = bearer ? bearer[1].trim() : null;
    const id = key ? keyId(key) : null;
    const inputs = typeof body?.input === 'string' ? [body.input] : body?.input;
    const record = {
      id: randomUUID(),
      at: new Date().toISOString(),
      keyId: id,
      model: body?.model ?? null,
      inputType: body?.input_type ?? null,
      outputDimension: body?.output_dimension ?? null,
      outputDtype: body?.output_dtype ?? null,
      truncation: body?.truncation ?? null,
      count: Array.isArray(inputs) ? inputs.length : 0,
      inputs: Array.isArray(inputs) ? inputs.map(String) : [],
      /** The headers' names, never their values. */
      headers: Object.keys(req.headers).sort(),
    };
    this.embeddings.push(record);
    if (this.embeddings.length > MAX_KEPT) this.embeddings.shift();
    if (!key) return send(401, { detail: 'Provide an API key.' });
    if (/^(pa|sk)-mock-invalid/.test(key))
      return send(401, { detail: 'Provided API key is invalid.' });
    const fault = this.take(this.embeddingFaults, id);
    if (fault?.latencyMs) await sleep(fault.latencyMs);
    if (fault?.status)
      return send(
        fault.status,
        { detail: 'Mock fault' },
        fault.status === 429 ? { 'retry-after': '1' } : {},
      );
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 1000)
      return send(400, { detail: 'input is a string or a list of 1 to 1,000 strings.' });
    if (!MODELS.includes(body.model))
      return send(400, { detail: `Model ${body.model} is not supported.` });
    if (![null, undefined, 'query', 'document'].includes(body.input_type))
      return send(400, { detail: 'input_type is query, document or null.' });
    if (
      body.output_dimension !== undefined &&
      body.output_dimension !== null &&
      body.output_dimension !== DIMENSIONS
    )
      return send(400, { detail: 'The mock gives 1,024 dimensions only.' });
    const dtype = body.output_dtype ?? 'float';
    if (!['float', 'int8'].includes(dtype))
      return send(400, { detail: 'The mock gives float or int8.' });
    const data = inputs.map((text, index) => ({
      object: 'embedding',
      embedding: dtype === 'int8' ? embedInt8(text) : Array.from(embedFloat(text)),
      index,
    }));
    const tokens = inputs.reduce((sum, text) => sum + tokensOf(text), 0);
    return send(200, { object: 'list', data, model: body.model, usage: { total_tokens: tokens } });
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (url.pathname.startsWith('/__mock/')) return this.admin(req, res, url, send);
    if (req.method === 'POST' && url.pathname === '/v1/embeddings')
      return this.embed(req, res, send);
    if (req.method !== 'POST' || url.pathname !== '/v1/messages')
      return send(404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'Not found' },
      });

    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Not JSON' },
      });
    }
    // API version 2026-10-21 sends the key as a bearer token (the SDKs do); older clients as x-api-key.
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    const key = bearer ? bearer[1].trim() : req.headers['x-api-key'];
    const id = key ? keyId(key) : null;
    const record = {
      id: randomUUID(),
      at: new Date().toISOString(),
      keyId: id,
      version: req.headers['anthropic-version'] ?? null,
      beta: String(req.headers['anthropic-beta'] ?? '')
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean),
      action: actionOf(body),
      /** The headers' names, never their values. */
      headers: Object.keys(req.headers).sort(),
      body,
      firstTextMs: null,
    };
    this.requests.push(record);
    if (this.requests.length > MAX_KEPT) this.requests.shift();
    const started = Date.now();

    if (!key)
      return send(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'An API key is required' },
      });
    if (String(key).startsWith('sk-mock-invalid'))
      return send(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });

    const fault = this.take(this.faults, id);
    if (fault?.latencyMs) await sleep(fault.latencyMs);
    if (fault?.status) {
      const type =
        fault.status === 429
          ? 'rate_limit_error'
          : fault.status === 529
            ? 'overloaded_error'
            : fault.status >= 500
              ? 'api_error'
              : 'invalid_request_error';
      return send(
        fault.status,
        { type: 'error', error: { type, message: 'Mock fault' } },
        fault.status === 429 ? { 'retry-after': '1' } : {},
      );
    }
    if (fault?.drop === 'before') {
      req.socket.destroy();
      return;
    }

    const script = this.take(this.scripts, id);
    if (script?.latencyMs) await sleep(script.latencyMs);
    const answer = script ?? defaultAnswer(body);
    const text =
      answer.json !== undefined ? JSON.stringify(answer.json) : String(answer.text ?? '');
    const refusal = !!answer.refusal;
    const stopReason = refusal ? 'refusal' : (answer.stopReason ?? 'end_turn');
    const input = tokens(systemOf(body.system) + JSON.stringify(body.messages ?? []));
    const output = refusal ? 0 : tokens(text);
    const model = answer.model ?? body.model;
    const message = {
      id: `msg_mock_${record.id.replaceAll('-', '').slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: input, output_tokens: 1 },
    };

    if (!body.stream) {
      record.firstTextMs = Date.now() - started;
      return send(200, {
        ...message,
        content: refusal ? [] : [{ type: 'text', text }],
        stop_reason: stopReason,
        usage: { input_tokens: input, output_tokens: output },
      });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'request-id': `req_mock_${record.id.slice(0, 8)}`,
    });
    const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    event('message_start', { type: 'message_start', message });
    event('ping', { type: 'ping' });
    if (!refusal) {
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      const parts = pieces(text, answer.json !== undefined ? 8 : 3);
      for (let i = 0; i < parts.length; i++) {
        if (i > 0 && answer.chunkDelayMs) await sleep(answer.chunkDelayMs);
        if (fault?.drop === 'after' && i === Math.floor(parts.length / 2)) {
          req.socket.destroy();
          return;
        }
        if (record.firstTextMs === null) record.firstTextMs = Date.now() - started;
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: parts[i] },
        });
      }
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
    }
    event('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
        ...(refusal
          ? { stop_details: { type: 'refusal', category: null, explanation: null } }
          : {}),
      },
      usage: { output_tokens: output },
    });
    event('message_stop', { type: 'message_stop' });
    res.end();
  }

  async admin(req, res, url, send) {
    const name = url.pathname.slice('/__mock/'.length);
    const json = async () => {
      const raw = await readBody(req);
      return raw ? JSON.parse(raw) : {};
    };
    if (req.method === 'GET' && name === 'requests') {
      const id = url.searchParams.get('keyId');
      const action = url.searchParams.get('action');
      return send(200, {
        requests: this.requests.filter(
          (r) => (!id || r.keyId === id) && (!action || r.action === action),
        ),
      });
    }
    if (req.method === 'GET' && name === 'state') return send(200, this.state());
    if (req.method === 'GET' && name === 'embeddings') {
      const id = url.searchParams.get('keyId');
      return send(200, { calls: this.embeddings.filter((c) => !id || c.keyId === id) });
    }
    if (req.method !== 'POST') return send(405, { error: 'method' });
    if (name === 'reset') {
      this.reset();
      return send(204);
    }
    if (name === 'script' || name === 'fault') {
      const body = await json();
      const times = Math.max(1, Number(body.times ?? 1));
      const item = {
        keyId: body.keyId ?? (body.key ? keyId(body.key) : null),
        text: body.text,
        json: body.json,
        stopReason: body.stopReason,
        refusal: body.refusal,
        model: body.model,
        latencyMs: Number(body.latencyMs ?? 0),
        chunkDelayMs: Number(body.chunkDelayMs ?? 0),
        status: body.status ? Number(body.status) : undefined,
        drop: body.drop,
      };
      const list =
        name === 'script'
          ? this.scripts
          : body.endpoint === 'embeddings'
            ? this.embeddingFaults
            : this.faults;
      for (let i = 0; i < times; i++) list.push(item);
      return send(204);
    }
    return send(404, { error: 'unknown' });
  }
}

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/** Starts the mock; resolves with its address and a `close`. */
export async function startMockAi({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const mock = new MockAi();
  const server = createServer((req, res) => {
    mock.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end();
    });
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, done);
  });
  const address = server.address();
  const url = `http://${host}:${typeof address === 'object' && address ? address.port : port}`;
  return {
    url,
    mock,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const port = Number(arg('--port', process.env.CGW_MOCK_AI_PORT ?? DEFAULT_PORT));
  const host = arg('--host', '127.0.0.1');
  const { url } = await startMockAi({ port, host });
  console.log(`Mock AI provider on ${url}`);
}
