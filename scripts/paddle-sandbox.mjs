// Prepares a Paddle sandbox for Phase 18's live test (decisions, 2026-11-25: "I create them by API"),
// with the sandbox's own API key, which never leaves this process (read from the environment,
// never a file or an argument, and refused if it is a live key):
//
//   $env:PADDLE_API_KEY = '<sandbox key with every permission>'
//   node scripts/paddle-sandbox.mjs --webhook https://<public address of the API>/api/v1/billing/paddle
//       [--pay-page https://<public address of the Sites process>/_pay/en] [--starter 900] [--team 2900]
//
// Makes, in the sandbox only: a product "Cash Gear Workspace AI" (tax category saas) with two
// monthly prices in USD (Starter and Team, the amounts in cents), a notification destination at the
// webhook's address subscribed to every `subscription.*` and `transaction.*` event (API version 1,
// real events only), and, with --pay-page, the checkout's default payment link. Prints the price
// ids, the destination's secret (once: Paddle shows it again in the dashboard) and the settings the
// server then takes (OPERATIONS.md, "Billing through Paddle"). Nothing is written to disk.
const key = process.env.PADDLE_API_KEY ?? '';
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
if (!key) throw new Error('Set PADDLE_API_KEY to the sandbox API key first.');
if (key.startsWith('pdl_live_'))
  throw new Error('That is a live key: this script works in the sandbox only.');
const webhook = option('--webhook');
if (!webhook?.startsWith('https://'))
  throw new Error('--webhook is the https address of /api/v1/billing/paddle.');
const payPage = option('--pay-page');
const BASE = 'https://sandbox-api.paddle.com';

async function paddle(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Paddle-Version': '1',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${json?.error?.code ?? ''} ${json?.error?.detail ?? ''}`,
    );
  return json.data;
}

const product = await paddle('POST', '/products', {
  name: 'Cash Gear Workspace AI',
  tax_category: 'saas',
  description: "A workspace's monthly AI allowance on Cash Gear's subscription.",
});
const price = async (name, amount) =>
  paddle('POST', '/prices', {
    product_id: product.id,
    name,
    description: `${name}: a month of Cash Gear Workspace AI`,
    unit_price: { amount: String(amount), currency_code: 'USD' },
    billing_cycle: { interval: 'month', frequency: 1 },
  });
const starter = await price('Starter', Number(option('--starter', 900)));
const team = await price('Team', Number(option('--team', 2900)));

const types = (await paddle('GET', '/event-types'))
  .map((t) => t.name)
  .filter((name) => name.startsWith('subscription.') || name.startsWith('transaction.'));
const destination = await paddle('POST', '/notification-settings', {
  description: 'Cash Gear Workspace (live test)',
  type: 'url',
  destination: webhook,
  subscribed_events: types,
  api_version: 1,
  include_sensitive_fields: false,
  traffic_source: 'platform',
});
if (payPage) await paddle('PATCH', '/settings/checkout-url', { default_url: payPage });

console.log(`Product ${product.id}; prices: Starter ${starter.id}, Team ${team.id}.`);
console.log(`Notification destination ${destination.id}, ${types.length} events.`);
console.log('Its secret (set it as CGW_PADDLE_WEBHOOK_SECRET, or Billing__Paddle__WebhookSecret):');
console.log(destination.endpoint_secret_key);
console.log('\nThe server then takes:');
console.log('  Billing__Paddle__Environment=sandbox');
console.log(`  Billing__Plans__starter__PriceId=${starter.id}`);
console.log(`  Billing__Plans__team__PriceId=${team.id}`);
console.log(
  "  and the plans' MonthlyTokens, EmbeddingsMonthlyTokens and Names, the API key and the",
);
console.log(
  "  client-side token (Developer tools → Authentication), as OPERATIONS.md's runbook says.",
);
