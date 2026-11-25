// A stand-in for Paddle Billing (Phase 18, M18.2): the API calls the server makes (transactions,
// subscriptions, portal sessions, prices, `Paddle-Version: 1`, a bearer key compared by its hash
// only), a stand-in for Paddle.js (`/paddle.js`) whose overlay is this mock's own checkout page
// (`/checkout/<transaction>`: Pay, Pay with a card that fails, Close), the customer portal
// (`/portal/<token>`: Cancel at the period's end, Cancel now) and webhooks signed as Paddle signs
// them (`Paddle-Signature: ts=<seconds>;h1=<HMAC-SHA256 of "ts:body", lowercase hex>`). The server's
// tests and the browser tests use it; nothing in a test ever reaches Paddle. Plain Node, no
// dependencies.
//
//   node tests/mocks/paddle/server.mjs [--port 4291] [--host 127.0.0.1]
//       [--webhook <url>] [--secret <webhook secret>] [--key <API key>]
//
// Webhooks go to `--webhook` (or `/__mock/config {webhookUrl}`) when one is set, and every event is
// also kept in an outbox a test can take (`GET /__mock/outbox`: each body with a fresh signature),
// for an API in process that no port reaches. Controls under `/__mock/*`: `state`, `reset`,
// `config`, `requests`, `events`, `outbox`, `pay`, `renew` (`fail: true`: a renewal that fails, the
// subscription past due), `dunning` (the retries end: `canceled` or `paused`), `cancel`
// (`immediately`), `periodEnd` (a scheduled cancel takes effect), `replay` (an event sent again,
// signed anew), `forge` (an event signed with the wrong secret), `send` (any event), `deliver`
// (`{on: false}` keeps webhooks in the outbox only).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4291;
export const DEFAULT_KEY = 'mock_paddle_api_key_for_tests_only_0001';
export const DEFAULT_SECRET = 'mock_paddle_webhook_secret_for_tests_0001';
export const PRICES = {
  pri_01mockstarter: { amount: '900', currency: 'USD', name: 'Starter' },
  pri_01mockteam: { amount: '2900', currency: 'USD', name: 'Team' },
  pri_01mockbusiness: { amount: '9900', currency: 'USD', name: 'Business' },
};

const MAX_BODY = 64 * 1024;
const id = (prefix) => prefix + randomBytes(13).toString('hex').slice(0, 26);
const hash = (text) => createHash('sha256').update(text).digest('hex');
export const sign = (body, secret, seconds = Math.floor(Date.now() / 1000)) =>
  `ts=${seconds};h1=${createHmac('sha256', secret).update(`${seconds}:${body}`).digest('hex')}`;

export function startMockPaddle({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  key = DEFAULT_KEY,
  secret = DEFAULT_SECRET,
  webhookUrl = null,
} = {}) {
  const origin = () => `http://${host}:${server.address().port}`;
  let state;
  const reset = () => {
    state = {
      keyHash: hash(key),
      secret,
      webhookUrl,
      deliver: true,
      customers: new Map(),
      transactions: new Map(),
      subscriptions: new Map(),
      portals: new Map(),
      events: [],
      outbox: [],
      requests: [],
      deliveries: [],
    };
  };
  reset();

  const now = () => new Date().toISOString();
  const addMonth = (iso) => {
    const d = new Date(iso);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString();
  };
  const priceOf = (priceId) =>
    PRICES[priceId]
      ? {
          id: priceId,
          product_id: 'pro_01mock' + priceId.slice(10),
          unit_price: { amount: PRICES[priceId].amount, currency_code: PRICES[priceId].currency },
          billing_cycle: { interval: 'month', frequency: 1 },
          name: PRICES[priceId].name,
          status: 'active',
        }
      : null;
  // Paddle's updated_at moves forward at least a millisecond on every change.
  const touch = (s) => {
    const next = Math.max(Date.now(), Date.parse(s.updated_at) + 1);
    s.updated_at = new Date(next).toISOString();
  };
  const entity = (s) => ({
    id: s.id,
    status: s.status,
    customer_id: s.customer_id,
    address_id: 'add_01mockaddress',
    currency_code: 'USD',
    created_at: s.created_at,
    updated_at: s.updated_at,
    started_at: s.created_at,
    next_billed_at: s.status === 'canceled' || s.scheduled_change ? null : s.period_ends_at,
    canceled_at: s.canceled_at ?? null,
    paused_at: s.paused_at ?? null,
    current_billing_period:
      s.status === 'canceled' || s.status === 'paused'
        ? null
        : { starts_at: s.period_starts_at, ends_at: s.period_ends_at },
    billing_cycle: { interval: 'month', frequency: 1 },
    scheduled_change: s.scheduled_change,
    items: [{ status: 'active', quantity: 1, price: priceOf(s.price_id) }],
    custom_data: s.custom_data,
    collection_mode: 'automatic',
  });

  /** An event recorded, put in the outbox and, when a destination is set, delivered. */
  const emit = async (type, data) => {
    const event = {
      event_id: id('evt_01'),
      event_type: type,
      occurred_at: now(),
      notification_id: id('ntf_01'),
      data,
    };
    state.events.push(event);
    state.outbox.push(event);
    if (state.deliver && state.webhookUrl) await deliver(event, state.secret);
    return event;
  };
  const deliver = async (event, withSecret) => {
    const body = JSON.stringify(event);
    try {
      const response = await fetch(state.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sign(body, withSecret) },
        body,
      });
      state.deliveries.push({ eventId: event.event_id, status: response.status, at: now() });
      return response.status;
    } catch (error) {
      state.deliveries.push({
        eventId: event.event_id,
        status: 0,
        error: String(error),
        at: now(),
      });
      return 0;
    }
  };

  /** A transaction's checkout paid: its customer, its subscription and Paddle's events, in Paddle's order. */
  const pay = async (transactionId, { fail = false } = {}) => {
    const t = state.transactions.get(transactionId);
    if (!t) return { status: 404 };
    if (t.status === 'completed') return { status: 409 };
    if (fail) {
      await emit('transaction.payment_failed', { ...t, status: t.status });
      return { status: 402 };
    }
    let customer = t.customer_id;
    if (!customer) {
      customer = id('ctm_01');
      state.customers.set(customer, { id: customer });
    }
    const created = now();
    const s = {
      id: id('sub_01'),
      status: 'active',
      customer_id: customer,
      price_id: t.items[0].price.id,
      created_at: created,
      updated_at: created,
      period_starts_at: created,
      period_ends_at: addMonth(created),
      scheduled_change: null,
      custom_data: t.custom_data,
    };
    state.subscriptions.set(s.id, s);
    Object.assign(t, {
      status: 'completed',
      customer_id: customer,
      subscription_id: s.id,
      updated_at: now(),
    });
    await emit('transaction.paid', { ...t, status: 'paid' });
    await emit('subscription.created', { ...entity(s), transaction_id: t.id });
    await emit('subscription.activated', entity(s));
    await emit('transaction.completed', { ...t });
    return { status: 200, subscription: s.id, customer };
  };

  const change = async (s, type = 'subscription.updated') => {
    touch(s);
    await emit('subscription.updated', entity(s));
    if (type !== 'subscription.updated') await emit(type, entity(s));
  };

  const page = (title, body) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    '<style>body{font:15px system-ui;margin:0;padding:24px;background:#fff;color:#111}button{font:inherit;margin:4px;padding:8px 14px}</style>' +
    `</head><body>${body}</body></html>`;

  // The stand-in for Paddle.js: Environment.set, and Initialize opening this mock's checkout over
  // the page for the transaction its address names, posting back what the checkout did.
  const paddleJs = () => `(function () {
  var mock = ${JSON.stringify(origin())};
  var callback = null;
  window.Paddle = {
    Environment: { set: function (name) { window.__paddleEnvironment = name; } },
    Initialize: function (options) {
      callback = options && options.eventCallback;
      window.__paddleToken = options && options.token;
      window.__paddleLocale = options && options.checkout && options.checkout.settings && options.checkout.settings.locale;
      var txn = new URLSearchParams(location.search).get('_ptxn');
      if (!txn) return;
      var frame = document.createElement('iframe');
      frame.title = 'Paddle checkout';
      frame.name = 'paddle_frame';
      frame.src = mock + '/checkout/' + encodeURIComponent(txn);
      frame.style.cssText = 'position:fixed;inset:5% 10%;width:80%;height:90%;border:1px solid #888;background:#fff;z-index:9';
      document.body.appendChild(frame);
      window.addEventListener('message', function (event) {
        if (event.origin !== mock || !event.data || event.data.source !== 'paddle-mock') return;
        if (event.data.name === 'checkout.closed' || event.data.name === 'checkout.completed') frame.remove();
        if (callback) callback({ name: event.data.name, data: { transaction_id: txn } });
      });
    }
  };
})();`;

  const checkoutPage = (t) =>
    page(
      'Mock Paddle checkout',
      `<h1>Mock Paddle checkout</h1><p>Transaction <code>${t.id}</code>: ${PRICES[t.items[0].price.id]?.name ?? t.items[0].price.id}, ` +
        `${PRICES[t.items[0].price.id]?.amount ?? '?'} cents a month.</p><p>Card number: (Paddle's frame; never the app's)</p>` +
        '<button id="pay">Pay</button><button id="fail">Pay with a card that fails</button><button id="close">Close</button><p id="said" role="status"></p>' +
        `<script>
var post = function (name) { parent.postMessage({ source: 'paddle-mock', name: name }, '*'); };
var send = function (fail) {
  return fetch('/checkout/${t.id}/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fail: fail }) })
    .then(function (r) { return r.status; });
};
document.getElementById('pay').onclick = function () { send(false).then(function (s) { if (s === 200) post('checkout.completed'); }); };
document.getElementById('fail').onclick = function () { send(true).then(function () { document.getElementById('said').textContent = 'The card was declined.'; post('checkout.payment.failed'); }); };
document.getElementById('close').onclick = function () { post('checkout.closed'); };
</script>`,
    );

  const portalPage = (token, s) =>
    page(
      'Mock Paddle portal',
      `<h1>Mock Paddle portal</h1><p>Subscription <code>${s.id}</code>: <span id="status">${s.status}</span>` +
        `${s.scheduled_change ? ', cancels at the end of the period' : ''}.</p>` +
        '<button id="cancel">Cancel at the end of the period</button><button id="now">Cancel now</button><p id="said" role="status"></p>' +
        `<script>
var act = function (immediately) {
  fetch('/portal/${token}/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ immediately: immediately }) })
    .then(function (r) { document.getElementById('said').textContent = r.status === 200 ? 'Done.' : 'Refused (' + r.status + ').'; });
};
document.getElementById('cancel').onclick = function () { act(false); };
document.getElementById('now').onclick = function () { act(true); };
</script>`,
    );

  const cancel = async (s, immediately) => {
    if (s.status === 'canceled') return 409;
    if (immediately) {
      s.status = 'canceled';
      s.canceled_at = now();
      s.scheduled_change = null;
      await change(s, 'subscription.canceled');
    } else {
      s.scheduled_change = { action: 'cancel', effective_at: s.period_ends_at, resume_at: null };
      await change(s);
    }
    return 200;
  };

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413);
        return res.end();
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = null;
    }
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const html = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(value);
    };
    const error = (status, code) =>
      json(status, {
        error: { type: 'request_error', code, detail: code },
        meta: { request_id: id('req_') },
      });

    // Controls.
    if (path.startsWith('/__mock/')) {
      const name = path.slice('/__mock/'.length);
      if (name === 'state')
        return json(200, {
          ok: true,
          subscriptions: [...state.subscriptions.values()].map(entity),
          transactions: [...state.transactions.values()],
          events: state.events.length,
          outbox: state.outbox.length,
          deliveries: state.deliveries,
          webhookUrl: state.webhookUrl,
        });
      if (req.method !== 'POST' && name !== 'requests' && name !== 'events' && name !== 'outbox')
        return error(405, 'method');
      if (name === 'requests') return json(200, { requests: state.requests });
      if (name === 'events') return json(200, { events: state.events });
      if (name === 'outbox') {
        // Each event waiting, with a signature made now; taken from the box.
        const taken = state.outbox.map((event) => {
          const raw = JSON.stringify(event);
          return {
            eventId: event.event_id,
            type: event.event_type,
            body: raw,
            signature: sign(raw, state.secret),
          };
        });
        state.outbox = [];
        return json(200, { events: taken });
      }
      if (body === null) return error(400, 'bad_request');
      if (name === 'reset') {
        const keep = { webhookUrl: state.webhookUrl, secret: state.secret, keyHash: state.keyHash };
        reset();
        Object.assign(state, keep);
        return json(200, { ok: true });
      }
      if (name === 'config') {
        if ('webhookUrl' in body) state.webhookUrl = body.webhookUrl;
        if (typeof body.secret === 'string') state.secret = body.secret;
        if (typeof body.key === 'string') state.keyHash = hash(body.key);
        return json(200, { ok: true });
      }
      if (name === 'deliver') {
        state.deliver = body.on !== false;
        return json(200, { ok: true });
      }
      if (name === 'pay') {
        const result = await pay(body.transactionId, { fail: !!body.fail });
        return json(result.status, result);
      }
      const s = state.subscriptions.get(body.subscriptionId);
      if (name === 'replay') {
        const event = state.events.find((e) => e.event_id === body.eventId);
        if (!event) return error(404, 'not_found');
        const status = state.webhookUrl ? await deliver(event, state.secret) : 0;
        state.outbox.push(event);
        return json(200, { status });
      }
      if (name === 'forge') {
        const event = {
          ...(state.events.at(-1) ?? {}),
          event_id: id('evt_01'),
          ...(body.event ?? {}),
        };
        const raw = JSON.stringify(event);
        const signature = sign(raw, 'mock_paddle_wrong_secret_' + randomBytes(8).toString('hex'));
        let status = 0;
        if (state.webhookUrl) {
          const response = await fetch(state.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Paddle-Signature': signature },
            body: raw,
          });
          status = response.status;
        }
        return json(200, { status, body: raw, signature });
      }
      if (name === 'send') {
        const event = await emit(body.type, body.data ?? {});
        return json(200, { eventId: event.event_id });
      }
      if (!s) return error(404, 'not_found');
      if (name === 'renew') {
        s.period_starts_at = s.period_ends_at;
        s.period_ends_at = addMonth(s.period_ends_at);
        if (body.fail) {
          s.status = 'past_due';
          await emit('transaction.payment_failed', {
            id: id('txn_01'),
            subscription_id: s.id,
            status: 'past_due',
          });
          await change(s, 'subscription.past_due');
        } else {
          s.status = 'active';
          await change(s, 'subscription.activated');
        }
        return json(200, entity(s));
      }
      if (name === 'dunning') {
        if (body.outcome === 'paused') {
          s.status = 'paused';
          s.paused_at = now();
          await change(s, 'subscription.paused');
        } else {
          s.status = 'canceled';
          s.canceled_at = now();
          await change(s, 'subscription.canceled');
        }
        return json(200, entity(s));
      }
      if (name === 'cancel') return json(await cancel(s, !!body.immediately), entity(s));
      if (name === 'periodEnd') {
        if (s.scheduled_change?.action === 'cancel') {
          s.status = 'canceled';
          s.canceled_at = now();
          s.scheduled_change = null;
          await change(s, 'subscription.canceled');
        }
        return json(200, entity(s));
      }
      return error(404, 'not_found');
    }

    // Paddle.js's stand-in, the checkout and the portal (no key: the person's browser).
    if (path === '/paddle.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(paddleJs());
    }
    let match;
    if ((match = /^\/checkout\/(txn_[a-z0-9]+)(\/pay)?$/.exec(path))) {
      const t = state.transactions.get(match[1]);
      if (!t) return html(404, page('Not found', '<p>No such checkout.</p>'));
      if (!match[2]) return html(200, checkoutPage(t));
      if (req.method !== 'POST') return error(405, 'method');
      const result = await pay(t.id, { fail: !!body?.fail });
      return json(result.status, result);
    }
    if ((match = /^\/portal\/([a-z0-9]+)(\/cancel)?$/.exec(path))) {
      const session = state.portals.get(match[1]);
      const s = session && state.subscriptions.get(session.subscriptionId);
      if (!s) return html(404, page('Not found', '<p>No such portal session.</p>'));
      if (!match[2]) return html(200, portalPage(match[1], s));
      if (req.method !== 'POST') return error(405, 'method');
      return json(await cancel(s, !!body?.immediately), entity(s));
    }

    // The API: the key by its hash, Paddle's version header.
    const auth = String(req.headers.authorization ?? '');
    state.requests.push({
      method: req.method,
      path: path + url.search,
      keyHash: auth.startsWith('Bearer ') ? hash(auth.slice(7)) : null,
      version: req.headers['paddle-version'] ?? null,
      at: now(),
    });
    if (state.requests.length > 5_000) state.requests = state.requests.slice(-2_500);
    if (!auth.startsWith('Bearer ') || hash(auth.slice(7)) !== state.keyHash)
      return error(403, 'forbidden');
    if (body === null) return error(400, 'bad_request');

    if (path === '/transactions' && req.method === 'POST') {
      const item = body.items?.[0];
      const price = priceOf(item?.price_id);
      if (!price) return error(400, 'invalid_field');
      const checkout = body.checkout?.url;
      if (typeof checkout !== 'string' || !/^https?:\/\//.test(checkout))
        return error(400, 'invalid_field');
      if (body.customer_id && !state.customers.has(body.customer_id))
        return error(400, 'invalid_field');
      const t = {
        id: id('txn_01'),
        status: body.customer_id ? 'ready' : 'draft',
        customer_id: body.customer_id ?? null,
        subscription_id: null,
        custom_data: body.custom_data ?? null,
        items: [{ price, quantity: 1 }],
        created_at: now(),
        updated_at: now(),
      };
      t.checkout = { url: `${checkout}${checkout.includes('?') ? '&' : '?'}_ptxn=${t.id}` };
      state.transactions.set(t.id, t);
      await emit('transaction.created', { ...t });
      return json(201, { data: t, meta: { request_id: id('req_') } });
    }
    if ((match = /^\/transactions\/(txn_[a-z0-9]+)$/.exec(path)) && req.method === 'GET') {
      const t = state.transactions.get(match[1]);
      return t ? json(200, { data: t }) : error(404, 'not_found');
    }
    if (path === '/subscriptions' && req.method === 'GET') {
      const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      const list = [...state.subscriptions.values()].filter(
        (s) => ids.length === 0 || ids.includes(s.id),
      );
      return json(200, {
        data: list.map(entity),
        meta: { pagination: { per_page: 200, next: null, has_more: false } },
      });
    }
    if ((match = /^\/subscriptions\/(sub_[a-z0-9]+)$/.exec(path))) {
      const s = state.subscriptions.get(match[1]);
      if (!s) return error(404, 'not_found');
      if (req.method === 'GET') return json(200, { data: entity(s) });
      if (req.method === 'PATCH') {
        if (s.status === 'canceled') return error(400, 'subscription_locked_canceled');
        const price = priceOf(body.items?.[0]?.price_id);
        if (!price || !body.proration_billing_mode) return error(400, 'invalid_field');
        s.price_id = price.id;
        await change(s);
        return json(200, { data: entity(s) });
      }
    }
    if (
      (match = /^\/subscriptions\/(sub_[a-z0-9]+)\/cancel$/.exec(path)) &&
      req.method === 'POST'
    ) {
      const s = state.subscriptions.get(match[1]);
      if (!s) return error(404, 'not_found');
      if (s.status === 'canceled') return error(400, 'subscription_locked_canceled');
      await cancel(s, body.effective_from === 'immediately');
      return json(200, { data: entity(s) });
    }
    if (
      (match = /^\/customers\/(ctm_[a-z0-9]+)\/portal-sessions$/.exec(path)) &&
      req.method === 'POST'
    ) {
      if (!state.customers.has(match[1])) return error(404, 'not_found');
      const sub = [...state.subscriptions.values()].find((s) => s.customer_id === match[1]);
      const token = randomBytes(12).toString('hex');
      state.portals.set(token, {
        customerId: match[1],
        subscriptionId: body.subscription_ids?.[0] ?? sub?.id,
      });
      return json(201, {
        data: {
          id: id('cpls_01'),
          customer_id: match[1],
          urls: { general: { overview: `${origin()}/portal/${token}` }, subscriptions: [] },
          created_at: now(),
        },
      });
    }
    if ((match = /^\/prices\/(pri_[a-z0-9]+)$/.exec(path)) && req.method === 'GET') {
      const price = priceOf(match[1]);
      return price ? json(200, { data: price }) : error(404, 'not_found');
    }
    return error(404, 'not_found');
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  return new Promise((done) =>
    server.listen(port, host, () =>
      done({
        url: origin(),
        state: () => state,
        close: () => new Promise((closed) => server.close(() => closed())),
      }),
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : fallback;
  };
  const mock = await startMockPaddle({
    port: Number(arg('--port', process.env.CGW_MOCK_PADDLE_PORT ?? DEFAULT_PORT)),
    host: arg('--host', '127.0.0.1'),
    webhookUrl: arg('--webhook', null),
    secret: arg('--secret', DEFAULT_SECRET),
    key: arg('--key', DEFAULT_KEY),
  });
  console.log(`Mock Paddle on ${mock.url}`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
