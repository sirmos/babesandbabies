// Offline checks for orders.mjs: no network, no real database.
// Run with: node worker/test-orders.mjs
import { adminFetch, afterCapture, recordOrder, summarize } from './orders.mjs';

let failures = 0;
function check(name, cond) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name); }
}

// ----- tiny in-memory stand-in for D1 -----
function makeDB() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() {
          if (sql.startsWith('SELECT order_id FROM orders WHERE order_id')) {
            return rows.find((r) => r.order_id === args[0]) || null;
          }
          return null;
        },
        async all() {
          if (sql.startsWith('SELECT * FROM orders ORDER BY created_at DESC')) {
            return { results: [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) };
          }
          return { results: [] };
        },
        async run() {
          if (sql.startsWith('INSERT OR IGNORE INTO orders')) {
            if (!rows.find((r) => r.order_id === args[0])) {
              rows.push({
                order_id: args[0], created_at: args[1], status: args[2], kind: args[3], total: args[4],
                currency: args[5], items: args[6], note: args[7], first_name: args[8], capture_id: args[9],
                webhook_confirmed: 0, webhook_at: null,
              });
            }
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE orders SET status')) {
            const r = rows.find((x) => x.order_id === args[1]);
            if (r) r.status = args[0];
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (sql.startsWith('UPDATE orders SET webhook_confirmed')) {
            const r = rows.find((x) => x.order_id === args[1]);
            if (r) { r.webhook_confirmed = 1; r.webhook_at = args[0]; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
}

// ----- mock PayPal -----
let verifyResult = 'SUCCESS';
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith('/v1/oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 'TEST_TOKEN', expires_in: 3600 }), { status: 200 });
  }
  if (u.includes('/v2/checkout/orders/')) {
    const id = u.split('/').pop();
    if (id === 'NOTDONE12345') {
      return new Response(JSON.stringify({ id, status: 'APPROVED', purchase_units: [] }), { status: 200 });
    }
    if (id === 'PLAINORDER123') {
      return new Response(JSON.stringify({
        id,
        status: 'COMPLETED',
        payer: { name: { given_name: 'Ada' } },
        purchase_units: [{
          description: 'Babes & Babies checkout',
          amount: { value: '8.00', currency_code: 'USD' },
          items: [{ name: 'Braiding hair \u2014 1b', quantity: '1', unit_amount: { value: '8.00' } }],
          payments: { captures: [{ id: 'CAP2', status: 'COMPLETED', amount: { value: '8.00', currency_code: 'USD' }, create_time: new Date().toISOString() }] },
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id,
      status: 'COMPLETED',
      payer: { name: { given_name: 'Test', surname: 'Buyer' }, email_address: 'secret@example.com' },
      purchase_units: [{
        description: 'Fulani braids',
        amount: { value: '29.00', currency_code: 'USD' },
        items: [
          { name: 'Hair booking deposit', quantity: '1', unit_amount: { value: '20.00' } },
          { name: 'Baby oil', quantity: '2', unit_amount: { value: '4.50' } },
        ],
        payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { value: '29.00', currency_code: 'USD' }, create_time: new Date().toISOString() }] },
      }],
    }), { status: 200 });
  }
  if (u.endsWith('/v1/notifications/verify-webhook-signature')) {
    return new Response(JSON.stringify({ verification_status: verifyResult }), { status: 200 });
  }
  return new Response('not mocked', { status: 404 });
};

const env = {
  DB: makeDB(),
  PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret',
  ORDERS_ADMIN_TOKEN: 'admin-secret', ORDERS_VIEW_TOKEN: 'judge-view',
  PAYPAL_WEBHOOK_ID: 'WH-1',
};
const BASE = 'https://example.workers.dev';
const req = (path, init = {}, token) => new Request(BASE + path, {
  ...init,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(init.headers || {}) },
});

console.log('capture hook and verification');
{
  const captureReq = new Request(BASE + '/paypal/capture-order', { method: 'POST', body: JSON.stringify({ orderId: 'ORDER1234567' }), headers: { 'Content-Type': 'application/json' } });
  let waited;
  const ctx = { waitUntil(p) { waited = p; } };
  const res = await afterCapture(captureReq, new Response('{}', { status: 200 }), env, ctx);
  await waited;
  check('passes the response through untouched', res.status === 200);
  check('order saved from PayPal data', env.DB.rows.length === 1 && env.DB.rows[0].total === 29);
  check('kind is Booking + products', env.DB.rows[0].kind === 'Booking + products');
  check('only the first name is stored', env.DB.rows[0].first_name === 'Test' && !JSON.stringify(env.DB.rows[0]).includes('secret@example.com'));
  const again = await recordOrder(env, 'ORDER1234567');
  check('saving the same order twice does nothing', again.created === false && env.DB.rows.length === 1);
  let threw = false;
  try { await recordOrder(env, 'NOTDONE12345'); } catch { threw = true; }
  check('an order PayPal has not completed is rejected', threw && env.DB.rows.length === 1);
  await recordOrder(env, 'PLAINORDER123');
  const plain = env.DB.rows.find((r) => r.order_id === 'PLAINORDER123');
  check('default PayPal text is not saved as a style note', plain && plain.note === '' && plain.kind === 'Products');
  env.DB.rows.splice(env.DB.rows.findIndex((r) => r.order_id === 'PLAINORDER123'), 1);
  const skipped = await afterCapture(new Request(BASE + '/shop/catalog'), new Response('{}'), env, ctx);
  check('other routes are ignored', skipped.status === 200 && env.DB.rows.length === 1);
}

console.log('dashboard access');
{
  let r = await adminFetch(req('/admin/orders'), env, {}, null);
  check('no token is refused', r.status === 401);
  r = await adminFetch(req('/admin/orders', {}, 'wrong'), env, {}, null);
  check('wrong token is refused', r.status === 401);
  r = await adminFetch(req('/admin/orders', {}, 'judge-view'), env, {}, null);
  let body = await r.json();
  check('read-only token can read', r.status === 200 && body.role === 'viewer' && body.orders.length === 1);
  check('summary revenue is right', body.summary.revenue === 29 && body.summary.bookings === 1);
  r = await adminFetch(req('/admin/orders/status', { method: 'POST', body: JSON.stringify({ orderId: 'ORDER1234567', status: 'Ready' }) }, 'judge-view'), env, {}, null);
  check('read-only token cannot change status', r.status === 403 && env.DB.rows[0].status === 'Paid');
  r = await adminFetch(req('/admin/orders/status', { method: 'POST', body: JSON.stringify({ orderId: 'ORDER1234567', status: 'Ready' }) }, 'admin-secret'), env, {}, null);
  check('admin token can change status', r.status === 200 && env.DB.rows[0].status === 'Ready');
  r = await adminFetch(req('/admin/orders/status', { method: 'POST', body: JSON.stringify({ orderId: 'ORDER1234567', status: 'Hacked' }) }, 'admin-secret'), env, {}, null);
  check('unknown status is rejected', r.status === 400);
  r = await adminFetch(req('/shop/catalog'), env, {}, null);
  check('other routes fall through', r === null);
  r = await adminFetch(new Request(BASE + '/admin/orders', { method: 'OPTIONS' }), env, {}, null);
  check('CORS preflight answered', r.status === 204);
}

console.log('owner assistant');
{
  let r = await adminFetch(req('/admin/ask', { method: 'POST', body: JSON.stringify({ question: 'How many bookings this week?' }) }, 'judge-view'), env, {}, null);
  let body = await r.json();
  check('rule-based answer when AI is missing', r.status === 200 && body.via === 'rules' && /1 booking/.test(body.answer));
  const askAI = async (system, text) => 'AI says: ' + (text.includes('DATA:') ? 'has data' : 'no data');
  r = await adminFetch(req('/admin/ask', { method: 'POST', body: JSON.stringify({ question: 'revenue?' }) }, 'judge-view'), env, {}, askAI);
  body = await r.json();
  check('AI answer is used when available', body.via === 'ai' && /has data/.test(body.answer));
  const brokenAI = async () => { throw new Error('quota'); };
  r = await adminFetch(req('/admin/ask', { method: 'POST', body: JSON.stringify({ question: 'what is my revenue' }) }, 'judge-view'), env, {}, brokenAI);
  body = await r.json();
  check('falls back to rules if the AI fails', body.via === 'rules' && /29\.00/.test(body.answer));
  r = await adminFetch(req('/admin/ask', { method: 'POST', body: JSON.stringify({ question: '' }) }, 'judge-view'), env, {}, null);
  check('empty question is rejected', r.status === 400);
}

console.log('webhook');
{
  env.DB.rows.length = 0;
  const event = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { supplementary_data: { related_ids: { order_id: 'ORDER7654321' } } } };
  const hook = () => new Request(BASE + '/paypal/webhook', {
    method: 'POST', body: JSON.stringify(event),
    headers: { 'paypal-auth-algo': 'x', 'paypal-cert-url': 'x', 'paypal-transmission-id': 'x', 'paypal-transmission-sig': 'x', 'paypal-transmission-time': 'x' },
  });
  verifyResult = 'FAILURE';
  let r = await adminFetch(hook(), env, {}, null);
  check('bad signature is refused', r.status === 400 && env.DB.rows.length === 0);
  verifyResult = 'SUCCESS';
  r = await adminFetch(hook(), env, {}, null);
  check('good signature saves and confirms the order', r.status === 200 && env.DB.rows.length === 1 && env.DB.rows[0].webhook_confirmed === 1);
  const noHook = await adminFetch(hook(), { ...env, PAYPAL_WEBHOOK_ID: undefined }, {}, null);
  check('webhook disabled until configured', noHook.status === 503);
}

console.log('summary');
{
  const s = summarize([]);
  check('empty summary is safe', s.orders === 0 && s.revenue === 0 && s.topItems.length === 0);
}

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll order checks passed; no network or database was used.');
