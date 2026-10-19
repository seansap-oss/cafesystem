/* End-to-end order flow test: customer order -> confirm -> kitchen stages -> ready event */
const BASE = process.env.BASE || 'http://localhost:3000';
let pass = 0, fail = 0;
const lines = [];
function ok(name, cond, detail) {
  if (cond) { pass++; lines.push('PASS  ' + name); }
  else { fail++; lines.push('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-auth'] = token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  let data = null, text = '';
  if (ct.includes('application/json')) { try { data = await r.json(); } catch (e) {} }
  else text = await r.text();
  return { status: r.status, data, text };
}
async function login(u, p) {
  const r = await req('POST', '/api/auth/login', { username: u, password: p });
  return r.data && r.data.token;
}

async function main() {
  lines.push('=== FULL ORDER FLOW: customer -> POS -> KDS -> customer popup ===\n');
  const tManager = await login('manager', 'manager@135');
  const tKitchen = await login('kitchen', 'kitchen@135');
  const tCashier = await login('cashier', 'pos@135');
  const menu = await req('GET', '/api/menu');
  const dish = menu.data.dishes[0];

  // 1. Customer places a UPI pickup order
  const phone = '96' + String(20000000 + (Date.now() % 9000000)).slice(-8);
  const created = await req('POST', '/api/orders', {
    type: 'pickup', paymentMethod: 'upi',
    customer: { name: 'Flow Test', phone },
    items: [{ menuId: dish.id, qty: 2, portion: 'full' }]
  });
  ok('1. customer order created', created.status === 200, 'got ' + created.status);
  const oid = created.data.order.id;
  ok('1. starts pending_confirmation', created.data.order.confirmationStatus === 'pending_confirmation');
  ok('1. not in kitchen yet', created.data.order.kitchenStatus === 'pending');

  // 2. Manager confirms -> still blocked by payment
  const conf = await req('POST', '/api/orders/' + oid + '/confirm', { notes: 'flow' }, tManager);
  ok('2. manager confirmed', conf.status === 200 && conf.data.confirmation.status === 'confirmed');
  const blocked = await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'in_progress' }, tKitchen);
  ok('2. kitchen blocked while unpaid', blocked.status === 409, 'got ' + blocked.status);

  // 3. Cashier verifies payment -> released to kitchen as 'received'
  const paid = await req('POST', '/api/orders/' + oid + '/confirm-payment', { method: 'upi' }, tCashier);
  ok('3. payment verified', paid.status === 200 && paid.data.payment.status === 'paid');
  ok('3. auto-released to kitchen (received)', paid.data.kitchenStatus === 'received', 'got ' + paid.data.kitchenStatus);

  // 4. Customer tracking page reflects 'received'
  const full = await req('GET', '/api/orders/' + oid, null, tManager);
  const tok = full.data.trackToken;
  const t1 = await req('GET', '/api/track/' + oid + '?token=' + encodeURIComponent(tok));
  ok('4. tracker shows received', t1.status === 200 && t1.data.kitchenStatus === 'received');

  // 5. KDS: start cooking
  const cook = await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'in_progress' }, tKitchen);
  ok('5. kitchen -> in_progress', cook.status === 200 && cook.data.kitchenStatus === 'in_progress');
  const t2 = await req('GET', '/api/track/' + oid + '?token=' + encodeURIComponent(tok));
  ok('5. tracker shows cooking', t2.data.kitchenStatus === 'in_progress');

  // 6. KDS: mark ready (this must fire order:ready)
  const ready = await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'completed' }, tKitchen);
  ok('6. kitchen -> completed', ready.status === 200 && ready.data.kitchenStatus === 'completed');
  ok('6. fulfillmentStatus ready', ready.data.fulfillmentStatus === 'ready');
  const t3 = await req('GET', '/api/track/' + oid + '?token=' + encodeURIComponent(tok));
  ok('6. tracker shows ready', t3.data.kitchenStatus === 'completed');
  ok('6. history records stages', t3.data.history.some(h => h.status === 'kitchen_in_progress') && t3.data.history.some(h => h.status === 'kitchen_completed'));

  // 7. POS can then fulfil (collected)
  const ful = await req('POST', '/api/orders/' + oid + '/fulfil', {}, tCashier);
  ok('7. POS fulfil -> collected', ful.status === 200 && ful.data.fulfillmentStatus === 'collected', 'got ' + (ful.data && ful.data.fulfillmentStatus));

  lines.push('\n=== STATIC ASSERTS (popup + stage UI present) ===');
  const idx = await (await fetch(BASE + '/')).text();
  ok('index has readyPopup handler', idx.includes('order:ready') && idx.includes('K.readyPopup'));
  const trk = await (await fetch(BASE + '/track')).text();
  ok('track has readyPopup handler', trk.includes('order:ready') && trk.includes('K.readyPopup'));
  ok('track uses readyText helper', trk.includes('function readyText'));
  const kds = await (await fetch(BASE + '/kitchen')).text();
  ok('kds defines $$ helper', kds.includes('const $$ ='));
  ok('kds button says notify customer', kds.includes('notify customer'));
  const pos = await (await fetch(BASE + '/pos')).text();
  ok('pos has 3-stage tracker', pos.includes('kitchenStages') && pos.includes("Received") && pos.includes("Preparing") && pos.includes("Ready"));

  lines.push('\nTOTAL: ' + (pass + fail) + '  PASS: ' + pass + '  FAIL: ' + fail);
  console.log(lines.join('\n'));
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(2); });