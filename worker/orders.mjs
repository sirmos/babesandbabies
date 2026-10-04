// Orders, owner dashboard API, owner assistant and PayPal webhook for Babes & Babies.
// Storage: Cloudflare D1 (binding "DB").
// Secrets: ORDERS_ADMIN_TOKEN (read + change status), ORDERS_VIEW_TOKEN (read-only demo),
//          PAYPAL_WEBHOOK_ID (optional, enables webhook confirmation).
// Existing secrets reused: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET. PAYPAL_ENV is "live" only when set to "live".

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const STATUSES = ['Paid', 'Preparing', 'Ready', 'Done', 'Cancelled'];
const ORDER_ID = /^[A-Za-z0-9-]{8,40}$/;
const DEPOSIT_RE = /deposit|booking/i;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function roleFor(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const admin = String(env.ORDERS_ADMIN_TOKEN || '').trim();
  const viewer = String(env.ORDERS_VIEW_TOKEN || '').trim();
  if (admin && safeEqual(token, admin)) return 'admin';
  if (viewer && safeEqual(token, viewer)) return 'viewer';
  return null;
}

// ---------- PayPal helpers ----------

let tokenCache = { value: null, exp: 0 };

function paypalBase(env) {
  return env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function paypalToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const res = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal token request failed: ' + res.status);
  const data = await res.json();
  tokenCache = {
    value: data.access_token,
    exp: Date.now() + Math.max(60, (data.expires_in || 300) - 60) * 1000,
  };
  return tokenCache.value;
}

// Looks the order up on PayPal (never trusts the browser) and stores it once it is COMPLETED.
export async function recordOrder(env, orderId) {
  if (!env.DB) throw new Error('DB binding missing');
  if (!ORDER_ID.test(String(orderId))) throw new Error('bad order id');

  const existing = await env.DB.prepare('SELECT order_id FROM orders WHERE order_id = ?').bind(orderId).first();
  if (existing) return { created: false };

  const token = await paypalToken(env);
  const res = await fetch(`${paypalBase(env)}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('PayPal order lookup failed: ' + res.status);
  const order = await res.json();

  const unit = (order.purchase_units || [])[0] || {};
  const capture = ((unit.payments || {}).captures || [])[0];
  if (order.status !== 'COMPLETED' || !capture || capture.status !== 'COMPLETED') {
    throw new Error('order is not completed: ' + order.status);
  }

  const items = (unit.items || []).map((i) => ({
    name: String(i.name || 'Item').slice(0, 80),
    qty: Number(i.quantity) || 1,
    unit: i.unit_amount ? Number(i.unit_amount.value) : null,
  }));
  const hasDeposit = items.some((i) => DEPOSIT_RE.test(i.name));
  const hasProducts = items.some((i) => !DEPOSIT_RE.test(i.name));
  const kind = hasDeposit && hasProducts ? 'Booking + products' : hasDeposit ? 'Booking' : 'Products';

  const total = Number((capture.amount && capture.amount.value) || (unit.amount && unit.amount.value) || 0);
  const currency = String((capture.amount && capture.amount.currency_code) || 'USD').slice(0, 3);
  const createdAt = String(capture.create_time || new Date().toISOString());
  const rawNote = String(unit.description || '').trim();
  const note = rawNote === 'Babes & Babies checkout' ? '' : rawNote.slice(0, 140); // default text is not a style note
  const payerName = order.payer && order.payer.name && order.payer.name.given_name;
  const firstName = String(payerName || '').slice(0, 40); // first name only, no email or address is stored

  await env.DB.prepare(
    'INSERT OR IGNORE INTO orders (order_id, created_at, status, kind, total, currency, items, note, first_name, capture_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(orderId, createdAt, 'Paid', kind, total, currency, JSON.stringify(items), note, firstName, String(capture.id || ''))
    .run();

  return { created: true };
}

// Called after the existing /paypal/capture-order handler has answered the browser.
export async function afterCapture(reqCopy, res, env, ctx) {
  try {
    if (reqCopy.method !== 'POST' || new URL(reqCopy.url).pathname !== '/paypal/capture-order' || !res.ok) return res;
    const body = await reqCopy.json().catch(() => null);
    const orderId = body && typeof body.orderId === 'string' ? body.orderId : '';
    if (!orderId || !env.DB) return res;
    const job = recordOrder(env, orderId).catch((e) => console.error('order save failed:', e.message));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  } catch (e) {
    console.error('afterCapture error:', e.message);
  }
  return res;
}

// ---------- webhook ----------

async function handleWebhook(request, env) {
  if (!env.PAYPAL_WEBHOOK_ID || !env.DB) return json({ error: 'webhook not configured' }, 503);

  const raw = await request.text();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const h = (name) => request.headers.get(name) || '';
  const token = await paypalToken(env);
  const verifyRes = await fetch(`${paypalBase(env)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    }),
  });
  const verdict = verifyRes.ok ? await verifyRes.json() : null;
  if (!verdict || verdict.verification_status !== 'SUCCESS') return json({ error: 'signature not verified' }, 400);

  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const related = event.resource && event.resource.supplementary_data && event.resource.supplementary_data.related_ids;
    const orderId = related && related.order_id;
    if (orderId && ORDER_ID.test(orderId)) {
      try {
        await recordOrder(env, orderId);
      } catch (e) {
        console.error('webhook order save failed:', e.message);
      }
      await env.DB.prepare('UPDATE orders SET webhook_confirmed = 1, webhook_at = ? WHERE order_id = ?')
        .bind(new Date().toISOString(), orderId)
        .run();
    }
  }
  return json({ received: true });
}

// ---------- dashboard data ----------

function rowToOrder(r) {
  let items = [];
  try {
    items = JSON.parse(r.items);
  } catch {
    items = [];
  }
  return {
    orderId: r.order_id,
    createdAt: r.created_at,
    status: r.status,
    kind: r.kind,
    total: Number(r.total),
    currency: r.currency,
    items,
    note: r.note || '',
    firstName: r.first_name || '',
    webhookConfirmed: !!r.webhook_confirmed,
  };
}

function topCounts(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
}

export function summarize(orders, now = Date.now()) {
  const week = 7 * 24 * 3600 * 1000;
  const active = orders.filter((o) => o.status !== 'Cancelled');
  const sum = (list) => round2(list.reduce((s, o) => s + o.total, 0));
  const isBooking = (o) => /Booking/.test(o.kind);

  const byStatus = {};
  orders.forEach((o) => {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  });
  const itemCounts = {};
  active.forEach((o) => o.items.forEach((i) => (itemCounts[i.name] = (itemCounts[i.name] || 0) + i.qty)));
  const noteCounts = {};
  active.forEach((o) => {
    const n = (o.note || '').trim().toLowerCase();
    if (n) noteCounts[n] = (noteCounts[n] || 0) + 1;
  });
  const recent = active.filter((o) => now - Date.parse(o.createdAt) <= week);

  return {
    currency: orders[0] ? orders[0].currency : 'USD',
    orders: orders.length,
    revenue: sum(active),
    averageOrder: active.length ? round2(sum(active) / active.length) : 0,
    bookings: active.filter(isBooking).length,
    awaiting: orders.filter((o) => o.status === 'Paid' || o.status === 'Preparing').length,
    last7Days: { orders: recent.length, revenue: sum(recent), bookings: recent.filter(isBooking).length },
    byStatus,
    topItems: topCounts(itemCounts),
    topStyleNotes: topCounts(noteCounts),
  };
}

function rulesAnswer(question, s) {
  const q = question.toLowerCase();
  const money = (n) => `${s.currency} ${Number(n).toFixed(2)}`;
  if (s.orders === 0) return 'There are no paid orders yet. Place a test order in the shop and ask again.';
  if (/deposit|booking|appointment/.test(q)) {
    return `You have ${s.bookings} booking order(s) in total, and ${s.last7Days.bookings} in the last 7 days.`;
  }
  if (/revenue|sales|earn|made|money|income|total/.test(q)) {
    return `Total sales are ${money(s.revenue)} from ${s.orders} order(s). The last 7 days brought ${money(s.last7Days.revenue)}.`;
  }
  if (/top|best|popular|most|sell/.test(q)) {
    const items = s.topItems.map((i) => `${i.name} (${i.count})`).join(', ') || 'no items yet';
    return `Top items: ${items}.`;
  }
  if (/style|braid|twist|cornrow/.test(q)) {
    const notes = s.topStyleNotes.map((i) => `${i.name} (${i.count})`).join(', ') || 'no style notes yet';
    return `Most requested styles: ${notes}.`;
  }
  if (/pending|awaiting|waiting|prepar|ready|status|todo|to do|open/.test(q)) {
    const parts = Object.entries(s.byStatus).map(([k, v]) => `${v} ${k}`).join(', ');
    return `${s.awaiting} order(s) still need attention. By status: ${parts}.`;
  }
  return `There are ${s.orders} order(s) worth ${money(s.revenue)}, with ${s.bookings} booking(s) and ${s.awaiting} waiting to be handled.`;
}

async function answerQuestion(question, orders, summary, askAI) {
  if (typeof askAI === 'function') {
    try {
      const recent = orders.slice(0, 20).map((o) => ({
        when: o.createdAt,
        status: o.status,
        kind: o.kind,
        total: o.total,
        items: o.items.map((i) => `${i.qty} x ${i.name}`).join(', '),
        note: o.note,
      }));
      const system =
        "You are the shop owner's assistant for Babes & Babies, a beauty salon and baby shop. " +
        'Answer ONLY from the JSON data provided. The data is PayPal Sandbox test orders in USD. ' +
        'If the data does not contain the answer, say so. Reply in at most 3 short sentences, plain text, no markdown.';
      const text = await askAI(system, `DATA:\n${JSON.stringify({ summary, recentOrders: recent })}\n\nQUESTION: ${question}`);
      if (text && String(text).trim()) return { answer: String(text).trim().slice(0, 700), via: 'ai' };
    } catch (e) {
      console.error('owner assistant AI failed:', e.message);
    }
  }
  return { answer: rulesAnswer(question, summary), via: 'rules' };
}

// ---------- router ----------

export async function adminFetch(request, env, ctx, askAI) {
  const path = new URL(request.url).pathname;
  const mine = path === '/admin/orders' || path === '/admin/orders/status' || path === '/admin/ask' || path === '/paypal/webhook';
  if (!mine) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    if (path === '/paypal/webhook') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return await handleWebhook(request, env);
    }

    if (!String(env.ORDERS_ADMIN_TOKEN || '').trim() && !String(env.ORDERS_VIEW_TOKEN || '').trim()) {
      return json({ error: 'dashboard not configured' }, 503);
    }
    const role = roleFor(request, env);
    if (!role) return json({ error: 'unauthorized' }, 401);
    if (!env.DB) return json({ error: 'database not configured' }, 503);

    const loadOrders = async () => {
      const { results } = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all();
      return (results || []).map(rowToOrder);
    };

    if (path === '/admin/orders' && request.method === 'GET') {
      const orders = await loadOrders();
      return json({ role, orders, summary: summarize(orders), statuses: STATUSES });
    }

    if (path === '/admin/orders/status' && request.method === 'POST') {
      if (role !== 'admin') return json({ error: 'read-only token' }, 403);
      const body = await request.json().catch(() => null);
      const orderId = body && typeof body.orderId === 'string' ? body.orderId : '';
      const status = body && typeof body.status === 'string' ? body.status : '';
      if (!ORDER_ID.test(orderId) || !STATUSES.includes(status)) return json({ error: 'invalid input' }, 400);
      const result = await env.DB.prepare('UPDATE orders SET status = ? WHERE order_id = ?').bind(status, orderId).run();
      const changes = result && result.meta ? result.meta.changes : 1;
      if (!changes) return json({ error: 'order not found' }, 404);
      return json({ ok: true, orderId, status });
    }

    if (path === '/admin/ask' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const question = body && typeof body.question === 'string' ? body.question.trim().slice(0, 200) : '';
      if (!question) return json({ error: 'ask a short question' }, 400);
      const orders = await loadOrders();
      const result = await answerQuestion(question, orders, summarize(orders), askAI);
      return json(result);
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.error('admin route error:', e.message);
    return json({ error: 'server error' }, 500);
  }
}
