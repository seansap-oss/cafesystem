/* Phase 13 acceptance tests — run against a live server on localhost:3000 */
const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { pass++; results.push('PASS  ' + name); }
  else { fail++; results.push('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function section(t) { results.push(''); results.push('=== ' + t + ' ==='); }

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-auth'] = token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  let data = null, text = '';
  if (ct.includes('application/json')) { try { data = await r.json(); } catch (e) {} }
  else { text = await r.text(); }
  return { status: r.status, data, text, headers: r.headers, buffer: ct.includes('pdf') ? Buffer.from(text, 'binary') : null };
}

async function login(username, password) {
  const r = await req('POST', '/api/auth/login', { username, password });
  return r.status === 200 && r.data && r.data.token ? r.data.token : null;
}

async function main() {
  section('TEST 1 — auth & role permissions');
  const tAdmin = await login('admin', 'admin@135');
  const tManager = await login('manager', 'manager@135');
  const tCashier = await login('cashier', 'pos@135');
  const tKitchen = await login('kitchen', 'kitchen@135');
  ok('admin login', !!tAdmin);
  ok('manager login', !!tManager);
  ok('cashier login', !!tCashier);
  ok('kitchen login', !!tKitchen);
  const noAuth = await req('GET', '/api/finance/today');
  ok('finance.today requires auth', noAuth.status === 401 || noAuth.status === 403);
  const kitchenFin = await req('GET', '/api/finance/today', null, tKitchen);
  ok('kitchen role denied finance.view', kitchenFin.status === 403 || kitchenFin.status === 401, 'got ' + kitchenFin.status);

  section('TEST 2 — settings branding & policy exposed');
  const pub = await req('GET', '/api/settings/public');
  ok('settings.public 200', pub.status === 200);
  ok('heroHeadline present', !!(pub.data && pub.data.heroHeadline));
  ok('orderPolicy present', !!(pub.data && pub.data.orderPolicy));
  ok('checkoutInstructions present', !!(pub.data && pub.data.checkoutInstructions));
  const s = await req('GET', '/api/settings', null, tAdmin);
  ok('admin can read full settings', s.status === 200);
  ok('settings.email/whatsapp/schedules fields present', !!(s.data && s.data.email && s.data.whatsapp && s.data.schedules));

  section('TEST 3 — order create: phone mandatory for pickup, returns confirmation flags');
  const menu = await req('GET', '/api/menu');
  const dish = menu.data.dishes[0];
  const noPhone = await req('POST', '/api/orders', {
    type: 'pickup', paymentMethod: 'cash', customer: { name: 'NoPhone' },
    items: [{ menuId: dish.id, qty: 1, portion: 'full' }]
  });
  ok('pickup without phone rejected', noPhone.status === 400 || noPhone.status === 422, 'got ' + noPhone.status);

  section('TEST 4 — order create (upi): pending_confirmation + kitchen gate blocks');
  const RUN = Date.now() % 100000; // unique suffix so reruns don't hit the phone rate limit
  const PHONE = '98' + String(10000000 + RUN).slice(-8); // 10 digits, starts 9
  const created = await req('POST', '/api/orders', {
    type: 'pickup', paymentMethod: 'upi', customer: { name: 'Phase13 Test', phone: PHONE },
    items: [{ menuId: dish.id, qty: 1, portion: 'full' }]
  });
  ok('order created', created.status === 200 || created.status === 201, 'got ' + created.status + ' ' + JSON.stringify(created.data).slice(0, 200));
  const oid = created.data && created.data.order && created.data.order.id;
  ok('order id returned', !!oid, JSON.stringify(created.data).slice(0, 200));
  ok('requiresConfirmation true', created.data && created.data.requiresConfirmation === true);
  ok('checkoutInstructions returned', !!(created.data && created.data.checkoutInstructions));
  ok('confirmationStatus pending_confirmation', created.data && created.data.order && created.data.order.confirmationStatus === 'pending_confirmation', JSON.stringify(created.data && created.data.order && created.data.order.confirmationStatus));
  ok('payment status awaiting_verification (online unpaid)', created.data && created.data.order && created.data.order.paymentStatus === 'awaiting_verification', 'got ' + (created.data && created.data.order && created.data.order.paymentStatus));

  const fullOrder = oid ? await req('GET', '/api/orders/' + oid, null, tManager) : { data: null };
  const trackTok = (fullOrder.data && fullOrder.data.trackToken) || '';
  const track = oid ? await req('GET', '/api/track/' + oid + '?token=' + encodeURIComponent(trackTok)) : { status: 404 };
  ok('track endpoint reachable', track.status === 200 || track.status === 404, 'got ' + track.status);
  ok('track returns confirmationStatus', !!(track.data && track.data.confirmationStatus), JSON.stringify(track.data && track.data.confirmationStatus));

  const kit1 = await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'received' }, tKitchen);
  ok('kitchen gate blocks unconfirmed unpaid order (409)', kit1.status === 409, 'got ' + kit1.status);

  section('TEST 5 — confirm order (manager) → still blocked by unpaid');
  const conf = await req('POST', '/api/orders/' + oid + '/confirm', { notes: 'Phase13 confirm' }, tManager);
  ok('confirm succeeds', conf.status === 200, 'got ' + conf.status);
  ok('confirmationStatus confirmed', conf.data && conf.data.confirmation && conf.data.confirmation.status === 'confirmed', JSON.stringify(conf.data && conf.data.confirmation));
  const kit2 = await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'received' }, tKitchen);
  ok('kitchen still blocked while unpaid (409)', kit2.status === 409, 'got ' + kit2.status);

  section('TEST 6 — confirm-payment (cashier) → kitchen release');
  const pay = await req('POST', '/api/orders/' + oid + '/confirm-payment', { method: 'upi', note: 'Phase13 paid' }, tCashier);
  ok('confirm-payment succeeds', pay.status === 200, 'got ' + pay.status);
  ok('payment status paid', pay.data && pay.data.payment && pay.data.payment.status === 'paid', JSON.stringify(pay.data && pay.data.payment && pay.data.payment.status));
  ok('auto-released to kitchen (received)', pay.data && pay.data.kitchenStatus === 'received', 'got ' + (pay.data && pay.data.kitchenStatus));

  section('TEST 7 — kitchen transition pipeline received→in_progress→completed');
  const k4 = await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'in_progress' }, tKitchen);
  ok('→ in_progress', k4.status === 200 && k4.data.kitchenStatus === 'in_progress', 'got ' + k4.status);
  const k5 = await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'completed' }, tKitchen);
  ok('→ completed', k5.status === 200 && k5.data.kitchenStatus === 'completed', 'got ' + k5.status);
  const k6 = await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'in_progress' }, tKitchen);
  ok('backward transition rejected (409)', k6.status === 409, 'got ' + k6.status);

  section('TEST 8 — reject flow (separate order)');
  const o2 = await req('POST', '/api/orders', {
    type: 'delivery', paymentMethod: 'cash', customer: { name: 'Reject Test', phone: '981' + String(Date.now() % 10000000).padStart(7, '0'), address: 'Test St 1' },
    items: [{ menuId: dish.id, qty: 1, portion: 'half' }]
  });
  const oid2 = o2.data && o2.data.order && o2.data.order.id;
  ok('second order created', !!oid2);
  const rej = await req('POST', '/api/orders/' + oid2 + '/reject', { reason: 'Out of stock' }, tManager);
  ok('reject succeeds', rej.status === 200, 'got ' + rej.status);
  ok('confirmationStatus rejected', rej.data && rej.data.confirmation && rej.data.confirmation.status === 'rejected', JSON.stringify(rej.data && rej.data.confirmation));
  const rejKit = await req('POST', '/api/orders/' + oid2 + '/kitchen', { status: 'received' }, tKitchen);
  ok('rejected order blocked from kitchen (409)', rejKit.status === 409, 'got ' + rejKit.status);

  section('TEST 9 — contacted endpoint');
  const o3 = await req('POST', '/api/orders', {
    type: 'pickup', paymentMethod: 'cash', customer: { name: 'Contact Test', phone: '982' + String(Date.now() % 10000000).padStart(7, '0') },
    items: [{ menuId: dish.id, qty: 1, portion: 'full' }]
  });
  const oid3 = o3.data && o3.data.order && o3.data.order.id;
  const ct = await req('POST', '/api/orders/' + oid3 + '/contacted', {}, tCashier);
  ok('contacted succeeds', ct.status === 200, 'got ' + ct.status);

  section('TEST 10 — phone rate limit (3 orders / phone / 5 min → 429)');
  const RLP = '970' + String(Date.now() % 10000000).padStart(7, '0');
  let got429 = false;
  for (let i = 0; i < 6; i++) {
    const r = await req('POST', '/api/orders', {
      type: 'pickup', paymentMethod: 'cash', customer: { name: 'RateLimit', phone: RLP },
      items: [{ menuId: dish.id, qty: 1, portion: 'full' }]
    });
    if (r.status === 429) { got429 = true; break; }
  }
  ok('rate limit triggers 429', got429);

  section('TEST 11 — finance.today (manager + cashier view)');
  const ft = await req('GET', '/api/finance/today', null, tManager);
  ok('manager finance.today 200', ft.status === 200, 'got ' + ft.status);
  ok('summary has netSales', ft.data && ft.data.summary && typeof ft.data.summary.netSales === 'number');
  ok('summary has orderCount', ft.data && ft.data.summary && typeof ft.data.summary.orderCount === 'number');
  ok('reconciliation present', !!(ft.data && ft.data.reconciliation));
  ok('cash drawer present', !!(ft.data && ft.data.cash));
  ok('operational.awaitingConfirm present', ft.data && ft.data.operational && typeof ft.data.operational.awaitingConfirm === 'number');
  const fc = await req('GET', '/api/finance/today', null, tCashier);
  ok('cashier finance.view allowed', fc.status === 200, 'got ' + fc.status);

  section('TEST 12 — finance periods');
  for (const p of ['yesterday', 'week', 'prevweek', 'month', 'prevmonth']) {
    const r = await req('GET', '/api/finance/report?period=' + p, null, tManager);
    ok('period ' + p + ' returns 200', r.status === 200, 'got ' + r.status);
  }
  const custom = await req('GET', '/api/finance/report?period=custom&from=2026-10-01&to=2026-10-19', null, tManager);
  ok('custom period 200', custom.status === 200, 'got ' + custom.status);

  section('TEST 13 — exports: PDF / MD / CSV');
  const pdf = await fetch(BASE + '/api/finance/report.pdf?period=today', { headers: { 'x-auth': tManager } });
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  ok('pdf 200', pdf.status === 200, 'got ' + pdf.status);
  ok('pdf starts with %PDF', pdfBuf.slice(0, 4).toString('latin1') === '%PDF', JSON.stringify(pdfBuf.slice(0, 8).toString('latin1')));
  ok('pdf size > 2000 bytes', pdfBuf.length > 2000, 'len=' + pdfBuf.length);
  const md = await req('GET', '/api/finance/report.md?period=today', null, tManager);
  ok('md 200', md.status === 200);
  ok('md contains net sales', /net sales/i.test(md.text), md.text.slice(0, 150));
  const csv = await req('GET', '/api/finance/export.csv?period=today', null, tManager);
  ok('csv 200', csv.status === 200);
  ok('csv has header row', csv.text.split('\n')[0].length > 3, csv.text.split('\n')[0]);

  section('TEST 14 — refunds record real amounts');
  const rf = await req('POST', '/api/finance/refund', { orderId: oid, amount: 50, reason: 'Phase13 partial refund' }, tManager);
  ok('refund accepted', rf.status === 200, 'got ' + rf.status + ' ' + JSON.stringify(rf.data).slice(0, 150));
  const ft2 = await req('GET', '/api/finance/today', null, tManager);
  ok('refundsList includes refund', ft2.data && ft2.data.refundsList && ft2.data.refundsList.some(r => r.orderId === oid));

  section('TEST 15 — cash movements');
  const cm = await req('POST', '/api/finance/cash-movement', { type: 'expense', amount: 250, note: 'Vegetables' }, tManager);
  ok('cash movement accepted', cm.status === 200, 'got ' + cm.status);
  const cml = await req('GET', '/api/finance/cash-movements', null, tManager);
  ok('cash movements list 200', cml.status === 200 && Array.isArray(cml.data));

  section('TEST 16 — day close + reopen (manager)');
  const dc = await req('POST', '/api/finance/day-close', { countedCash: 5000, note: 'Phase13 close' }, tManager);
  ok('day close succeeds', dc.status === 200, 'got ' + dc.status + ' ' + JSON.stringify(dc.data).slice(0, 150));
  ok('variance computed', dc.data && typeof dc.data.variance === 'number');
  const dc2 = await req('POST', '/api/finance/day-close', { countedCash: 5000 }, tManager);
  ok('double close rejected (409)', dc2.status === 409, 'got ' + dc2.status);
  const reopen = await req('POST', '/api/finance/day-reopen', { businessDate: dc.data.businessDate }, tManager);
  ok('day reopen succeeds', reopen.status === 200, 'got ' + reopen.status);
  const reopenCashier = await req('POST', '/api/finance/day-reopen', { businessDate: dc.data.businessDate }, tCashier);
  ok('reopen denied for cashier if no close left / or 403', reopenCashier.status === 403 || reopenCashier.status === 404, 'got ' + reopenCashier.status);

  section('TEST 17 — share: honest email status (not_configured)');
  const se = await req('POST', '/api/finance/share', { channel: 'email', period: 'today' }, tManager);
  ok('share email returns status', se.status === 200, 'got ' + se.status);
  ok('email status not_configured (no SMTP)', se.data && se.data.status === 'not_configured', JSON.stringify(se.data).slice(0, 150));
  ok('email ok=false when not configured', se.data && se.data.ok === false);

  section('TEST 18 — share: whatsapp ready link');
  const sw = await req('POST', '/api/finance/share', { channel: 'whatsapp', period: 'today', number: '9876543210' }, tManager);
  ok('share whatsapp 200', sw.status === 200, 'got ' + sw.status);
  ok('whatsapp status ready', sw.data && sw.data.status === 'ready', JSON.stringify(sw.data).slice(0, 150));
  ok('whatsapp wa.me url', sw.data && sw.data.url && sw.data.url.startsWith('https://wa.me/'));

  section('TEST 19 — deliveries log');
  const dl = await req('GET', '/api/finance/deliveries', null, tManager);
  ok('deliveries 200', dl.status === 200 && Array.isArray(dl.data));
  ok('deliveries include email + whatsapp entries', dl.data && dl.data.length >= 2);

  section('TEST 20 — scheduler period keys idempotent (unit via API surface)');
  // Scheduler internals not directly exposed; verify settings.schedules shape + that no crash on /api/finance/today
  const sf = await req('GET', '/api/settings', null, tAdmin);
  ok('schedules.eod exists', sf.data && sf.data.schedules && 'eod' in sf.data.schedules);
  ok('schedules.hourly exists', sf.data && sf.data.schedules && 'hourly' in sf.data.schedules);
  ok('schedules.weekly exists', sf.data && sf.data.schedules && 'weekly' in sf.data.schedules);
  ok('schedules.monthly exists', sf.data && sf.data.schedules && 'monthly' in sf.data.schedules);

  section('TEST 21 — POS order auto-confirm (staff orders skip queue)');
  const pos = await req('POST', '/api/orders/pos', {
    type: 'dinein', table: 1, paymentMethod: 'cash',
    items: [{ menuId: dish.id, qty: 1, portion: 'full' }]
  }, tCashier);
  ok('POS order created', pos.status === 200 || pos.status === 201, 'got ' + pos.status + ' ' + JSON.stringify(pos.data).slice(0, 200));
  const posOrder = pos.data && pos.data.order;
  ok('POS order auto-confirmed', posOrder && posOrder.confirmationStatus === 'confirmed', JSON.stringify(posOrder && posOrder.confirmationStatus));

  section('TEST 22 — settings PUT: heroHeadline + policy persist');
  const put = await req('PUT', '/api/settings', {
    heroHeadline: 'The Royal Food For The Common Man (TEST)',
    orderPolicy: { counterPayRequiresConfirm: true, upiRequiresConfirm: true, paymentRequiredBeforeKitchen: true, autoConfirmPosOrders: true }
  }, tAdmin);
  ok('settings PUT 200', put.status === 200, 'got ' + put.status);
  const s2 = await req('GET', '/api/settings', null, tAdmin);
  ok('heroHeadline persisted', s2.data && s2.data.heroHeadline && s2.data.heroHeadline.includes('(TEST)'), JSON.stringify(s2.data && s2.data.heroHeadline));
  const pub2 = await req('GET', '/api/settings/public');
  ok('heroHeadline exposed publicly', pub2.data && pub2.data.heroHeadline && pub2.data.heroHeadline.includes('(TEST)'));
  // restore
  await req('PUT', '/api/settings', { heroHeadline: 'The Royal Food For The Common Man' }, tAdmin);

  section('TEST 23 — pages + assets serve');
  for (const p of ['/', '/pos', '/manager', '/track', '/finance', '/admin', '/kitchen', '/delivery']) {
    const r = await fetch(BASE + p);
    ok('page ' + p + ' 200', r.status === 200, 'got ' + r.status);
  }
  for (const a of ['/img/logo.svg', '/favicon.svg', '/css/karims.css', '/js/api.js']) {
    const r = await fetch(BASE + a);
    ok('asset ' + a + ' 200', r.status === 200, 'got ' + r.status);
  }
  const idx = await (await fetch(BASE + '/')).text();
  ok('index has no staff nav', !/href="\/pos"/.test(idx) && !/href="\/kitchen"/.test(idx) && !/href="\/finance"/.test(idx));
  ok('index has heroHeadline class branding', /Royal Food/i.test(idx));
  const fin = await (await fetch(BASE + '/finance', { headers: { 'x-auth': tManager } })).text();
  ok('finance.html has export buttons', /report\.pdf|btnPdf|PDF/i.test(fin));
  ok('finance.html has cash drawer controls', /countedCash|btnClose/i.test(fin));
  const mgr = await (await fetch(BASE + '/manager', { headers: { 'x-auth': tManager } })).text();
  ok('manager has confirmation queue', /confList|Pending confirmation/i.test(mgr));
  const posH = await (await fetch(BASE + '/pos', { headers: { 'x-auth': tCashier } })).text();
  ok('pos has confirmation queue', /confList|awaiting restaurant confirmation/i.test(posH));
  const trk = await (await fetch(BASE + '/track')).text();
  ok('track has confirmation banner', /confBanner|confirm-note/i.test(trk));

  section('SUMMARY');
  results.push('');
  results.push('TOTAL: ' + (pass + fail) + '  PASS: ' + pass + '  FAIL: ' + fail);
  console.log(results.join('\n'));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
