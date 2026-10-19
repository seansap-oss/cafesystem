/* Verifies a real Socket.IO client in the customer room receives order:ready when KDS finishes */
const BASE = process.env.BASE || 'http://localhost:3000';
const { io } = require('socket.io-client');

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-auth'] = token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function login(u, p) { const r = await req('POST', '/api/auth/login', { username: u, password: p }); return r.data.token; }

async function main() {
  const tManager = await login('manager', 'manager@135');
  const tKitchen = await login('kitchen', 'kitchen@135');
  const tCashier = await login('cashier', 'pos@135');
  const menu = await req('GET', '/api/menu');
  const dish = menu.data.dishes[0];
  const phone = '95' + String(20000000 + (Date.now() % 9000000)).slice(-8);

  const created = await req('POST', '/api/orders', {
    type: 'pickup', paymentMethod: 'cash',
    customer: { name: 'Socket Test', phone },
    items: [{ menuId: dish.id, qty: 1, portion: 'full' }]
  });
  const oid = created.data.order.id;
  console.log('order', oid, 'confirmation:', created.data.order.confirmationStatus);

  // Customer connects and joins its tracking room (same as track.html / index.html do)
  const socket = io(BASE, { transports: ['websocket'] });
  const got = { ready: null, stage: [] };
  await new Promise((res, rej) => {
    socket.on('connect', () => { socket.emit('join', 'customer:' + oid); res(); });
    socket.on('connect_error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 8000);
  });
  console.log('customer socket connected:', socket.id);
  socket.on('order:ready', r => { got.ready = r; });
  socket.on('order:stage', s => { got.stage.push(s.stage); });

  await req('POST', '/api/orders/' + oid + '/confirm', { notes: 'sock' }, tManager);
  await req('POST', '/api/orders/' + oid + '/confirm-payment', { method: 'cash' }, tCashier);
  await new Promise(r => setTimeout(r, 400));
  await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'in_progress' }, tKitchen);
  await new Promise(r => setTimeout(r, 400));
  await req('POST', '/api/orders/' + oid + '/kitchen', { status: 'completed' }, tKitchen);
  await new Promise(r => setTimeout(r, 900));

  socket.close();
  console.log('stage events received:', JSON.stringify(got.stage));
  console.log('order:ready received:', got.ready ? JSON.stringify(got.ready) : 'NONE');
  const okStage = got.stage.includes('in_progress') && got.stage.includes('completed');
  const okReady = !!got.ready && got.ready.id === oid && /ready for pickup/i.test(got.ready.message || '');
  console.log(okStage ? 'PASS stage events' : 'FAIL stage events');
  console.log(okReady ? 'PASS ready popup payload' : 'FAIL ready popup payload');
  process.exit(okStage && okReady ? 0 : 1);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2); });