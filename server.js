/* Karim's Restaurant Platform — Local-first Node server
 * Express + Socket.IO + JSON persistence + file uploads
 * Binds 0.0.0.0 so all devices on restaurant Wi-Fi can connect.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CATEGORIES, MENU, DEFAULT_SETTINGS } = require('./seed');
const fin = require('./lib/finance');
const { smtpSend, whatsappShare } = require('./lib/mailer');
const { Pdf, MARGIN, A4_W } = require('./lib/pdf');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

function safeMkdir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* read-only FS (serverless) */ }
}
safeMkdir(DATA_DIR);
safeMkdir(UPLOAD_DIR);
safeMkdir(BACKUP_DIR);

// ---------------- Database (atomic JSON persistence) ----------------
let db = null;
let saveTimer = null;

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const test = crypto.scryptSync(pw, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch (e) { return false; }
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function seedDB() {
  const now = Date.now();
  const dishes = MENU.map((m, i) => ({
    id: 'dish_' + String(i + 1).padStart(3, '0'),
    name: m.name, cat: m.cat, half: m.half, full: m.full, veg: m.veg,
    desc: m.desc, badge: m.badge, img: m.img, customImg: '', inStock: true,
    createdAt: now, updatedAt: now
  }));
  const tables = [];
  for (let i = 1; i <= DEFAULT_SETTINGS.tables; i++) tables.push({ num: i, name: 'Table ' + i, active: true });
  const adminSalt = crypto.randomBytes(16).toString('hex');
  return {
    version: 3,
    dishes,
    categories: CATEGORIES.slice(),
    tables,
    orders: [],
    drivers: [
      { id: 'drv_1', name: 'Rohan Singh', phone: '9876500001', pin: '1111', active: true },
      { id: 'drv_2', name: 'James Meitei', phone: '9876500002', pin: '2222', active: true }
    ],
    users: [
      { id: 'usr_admin', username: 'admin', name: 'Administrator', role: 'admin', pass: hashPassword('admin@135', adminSalt) },
      { id: 'usr_mgr', username: 'manager', name: 'Restaurant Manager', role: 'manager', pass: hashPassword('manager@135') },
      { id: 'usr_pos', username: 'cashier', name: 'POS Cashier', role: 'cashier', pass: hashPassword('pos@135') },
      { id: 'usr_kds', username: 'kitchen', name: 'Kitchen Station', role: 'kitchen', pass: hashPassword('kitchen@135') }
    ],
    sessions: {},
    audit: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    counters: { order: 1000 },
    cashMovements: [],
    dayCloses: [],
    reportDeliveries: [],
    createdAt: now
  };
}

/* v2 → v3 migration: derive payments[] / refunds[] / confirmation from legacy payment object */
function migrateOrder(o) {
  if (!o.payments) {
    if (o.payment && o.payment.status === 'paid') {
      o.payments = [{ id: newId('pay'), method: o.payment.method, amount: o.total, status: 'paid', by: o.payment.verifiedBy || 'legacy', at: o.payment.verifiedAt || o.createdAt, ref: '' }];
    } else if (o.payment && o.payment.status === 'awaiting_verification') {
      o.payments = [{ id: newId('pay'), method: o.payment.method, amount: o.total, status: 'awaiting_verification', by: 'system', at: o.createdAt, ref: '' }];
    } else if (o.payment && o.payment.status === 'refunded') {
      o.payments = [{ id: newId('pay'), method: o.payment.method, amount: o.total, status: 'paid', by: o.payment.verifiedBy || 'legacy', at: o.payment.verifiedAt || o.createdAt, ref: '' }];
      o.refunds = [{ id: newId('ref'), amount: o.total, method: o.payment.method, by: o.payment.verifiedBy || 'legacy', at: Date.now(), reason: 'Migrated refund' }];
    } else {
      o.payments = [{ id: newId('pay'), method: o.payment ? o.payment.method : 'cash', amount: o.total, status: 'pending', by: 'system', at: o.createdAt, ref: '' }];
    }
  }
  if (!o.refunds) o.refunds = [];
  if (!o.confirmation) {
    const staffOrder = o.createdBy && String(o.createdBy).startsWith('pos:');
    o.confirmation = staffOrder
      ? { status: 'confirmed', by: o.createdBy, at: o.createdAt, notes: 'Auto-confirmed (staff POS order)', contactedAt: null, contactedBy: null }
      : { status: o.kitchenStatus === 'cancelled' ? 'rejected' : 'confirmed', by: 'legacy', at: o.createdAt, notes: 'Migrated from v2 (payment gate only)', contactedAt: null, contactedBy: null };
  }
  if (o.discount === undefined) o.discount = 0;
  return o;
}

function migrateDB() {
  if (!db.cashMovements) db.cashMovements = [];
  if (!db.dayCloses) db.dayCloses = [];
  if (!db.reportDeliveries) db.reportDeliveries = [];
  // merge new settings keys without losing admin edits
  db.settings = Object.assign({}, DEFAULT_SETTINGS, db.settings);
  if (!db.settings.orderPolicy) db.settings.orderPolicy = Object.assign({}, DEFAULT_SETTINGS.orderPolicy);
  else db.settings.orderPolicy = Object.assign({}, DEFAULT_SETTINGS.orderPolicy, db.settings.orderPolicy);
  db.orders.forEach(migrateOrder);
  db.version = 3;
  saveNow();
}

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!db.version || db.version < 2) db = seedDB(), saveNow();
      else if (db.version < 3) migrateDB();
      return;
    } catch (e) {
      console.error('DB corrupt, reseeding:', e.message);
    }
  }
  db = seedDB();
  saveNow();
}

function saveNow() {
  if (IS_SERVERLESS) return; // read-only filesystem on serverless
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('save failed:', e.message);
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

function audit(actor, action, detail) {
  db.audit.unshift({ id: newId('aud'), at: Date.now(), actor: actor || 'system', action, detail: detail || '' });
  if (db.audit.length > 2000) db.audit.length = 2000;
  save();
}

loadDB();

// ---------------- Express + Socket.IO ----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, crypto.randomBytes(8).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only image files (jpg, png, webp, gif) are allowed'), ok);
  }
});

// ---------------- Auth helpers ----------------
const ROLE_PERMS = {
  admin: ['*'],
  manager: ['orders.view','orders.create','orders.pay','orders.cancel','orders.kitchen','orders.confirm','orders.delivery.assign','reports.view','menu.view','settings.view','drivers.manage','tables.manage','finance.view','finance.close','finance.config','finance.export'],
  cashier: ['orders.view','orders.create','orders.pay','orders.confirm','menu.view','finance.view'],
  kitchen: ['orders.view','orders.kitchen'],
  driver: ['orders.view','orders.delivery']
};
function can(role, perm) {
  const p = ROLE_PERMS[role] || [];
  return p.includes('*') || p.includes(perm);
}

// Menu write operations are admin/manager only (cashier has menu.view for POS browsing)
function requireMenuManage(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'manager')) {
    return res.status(403).json({ error: 'Only admin/manager can modify the menu' });
  }
  next();
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: user.id, role: user.role, name: user.name, username: user.username, at: Date.now() };
  save();
  return token;
}

function requireAuth(perm) {
  return (req, res, next) => {
    const token = req.headers['x-auth'] || (req.cookies && req.cookies.karim_token);
    const sess = token && db.sessions[token];
    if (!sess) return res.status(401).json({ error: 'Not authenticated' });
    if (perm && !can(sess.role, perm)) return res.status(403).json({ error: 'Permission denied for role: ' + sess.role });
    req.user = sess;
    req.token = token;
    next();
  };
}

// Simple cookie parse
app.use((req, res, next) => {
  req.cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) req.cookies[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  next();
});

// ---------------- Socket.IO ----------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const sess = token && db.sessions[token];
  if (sess) { socket.user = sess; }
  // customers may connect with just an order track token
  if (typeof next === 'function') next();
  else if (typeof socket.next === 'function') socket.next();
});

function emit(channel, event, payload) {
  io.to(channel).emit(event, payload);
}
function broadcast(event, payload) {
  io.emit(event, payload);
}

io.on('connection', (socket) => {
  socket.on('join', (room) => {
    if (typeof room === 'string' && room.length < 80) socket.join(room);
  });
  socket.on('leave', (room) => { if (typeof room === 'string') socket.leave(room); });
});

// ---------------- Auth API ----------------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.users.find(u => u.username === username && u.active !== false);
  if (!user || !verifyPassword(password || '', user.pass)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = createSession(user);
  audit(user.username, 'login', 'Logged in');
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

app.post('/api/auth/driver-login', (req, res) => {
  const { driverId, pin } = req.body || {};
  const drv = db.drivers.find(d => d.id === driverId && d.active);
  if (!drv || drv.pin !== pin) return res.status(401).json({ error: 'Invalid driver ID or PIN' });
  const fakeUser = { id: drv.id, username: 'driver_' + drv.name, name: drv.name, role: 'driver' };
  // attach driverId in session
  const token = createSession(fakeUser);
  db.sessions[token].driverId = drv.id;
  save();
  res.json({ token, driver: { id: drv.id, name: drv.name } });
});

app.post('/api/auth/logout', requireAuth(), (req, res) => {
  delete db.sessions[req.token];
  save();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
  res.json({ user: req.user });
});

// ---------------- Settings ----------------
app.get('/api/settings/public', (req, res) => {
  const s = db.settings;
  res.json({
    name: s.name, tagline: s.tagline, slogan: s.slogan, address: s.address, phone: s.phone,
    hours: s.hours, gstRate: s.gstRate, serviceCharge: s.serviceCharge,
    deliveryFee: s.deliveryFee, freeDeliveryAbove: s.freeDeliveryAbove, minDeliveryOrder: s.minDeliveryOrder,
    deliveryZones: s.deliveryZones, upiId: s.upiId, upiName: s.upiName, upiQRImage: s.upiQRImage,
    paymentInstructions: s.paymentInstructions, acceptUPI: s.acceptUPI, acceptCash: s.acceptCash,
    acceptCard: s.acceptCard, acceptOnlineDelivery: s.acceptOnlineDelivery,
    tables: db.tables.filter(t => t.active).map(t => ({ num: t.num, name: t.name })),
    primaryColor: s.primaryColor, accentColor: s.accentColor, themeColor: s.themeColor,
    logoImage: s.logoImage || '', faviconImage: s.faviconImage || '', heroImage: s.heroImage || '',
    heroHeadline: s.heroHeadline || '', heroDesc: s.heroDesc || '',
    heroBadge1: s.heroBadge1 || '', heroBadge2: s.heroBadge2 || '', heroBadge3: s.heroBadge3 || '',
    heritageLine: s.heritageLine || '', checkoutInstructions: s.checkoutInstructions || '',
    orderPolicy: s.orderPolicy || {}
  });
});

app.get('/api/settings', requireAuth('settings.view'), (req, res) => res.json(db.settings));

app.put('/api/settings', requireAuth('settings.view'), (req, res) => {
  const allowed = ['name','tagline','slogan','address','phone','gstin','currency','gstRate','serviceCharge','deliveryFee','freeDeliveryAbove','minDeliveryOrder','deliveryZones','upiId','upiName','upiQRImage','paymentInstructions','acceptUPI','acceptCash','acceptCard','acceptOnlineDelivery','hours','primaryColor','accentColor','themeColor','soundNewOrder',
    'logoImage','faviconImage','heroImage','heroHeadline','heroDesc','heroBadge1','heroBadge2','heroBadge3','heritageLine','checkoutInstructions',
    'timezone','tzOffsetMinutes','openingFloat','financeRefreshSeconds'];
  allowed.forEach(k => { if (req.body[k] !== undefined) db.settings[k] = req.body[k]; });
  if (req.body.orderPolicy && typeof req.body.orderPolicy === 'object') {
    db.settings.orderPolicy = Object.assign({}, DEFAULT_SETTINGS.orderPolicy, db.settings.orderPolicy, req.body.orderPolicy);
  }
  if (req.body.email && typeof req.body.email === 'object') db.settings.email = Object.assign({}, db.settings.email, { host: String(req.body.email.host || ''), port: Number(req.body.email.port) || 587, user: String(req.body.email.user || ''), pass: String(req.body.email.pass || ''), from: String(req.body.email.from || ''), recipients: Array.isArray(req.body.email.recipients) ? req.body.email.recipients.map(String).slice(0, 20) : [] });
  if (req.body.whatsapp && typeof req.body.whatsapp === 'object') db.settings.whatsapp = Object.assign({}, db.settings.whatsapp, { provider: String(req.body.whatsapp.provider || ''), apiToken: String(req.body.whatsapp.apiToken || ''), templateId: String(req.body.whatsapp.templateId || ''), defaultNumber: String(req.body.whatsapp.defaultNumber || '') });
  if (req.body.schedules && typeof req.body.schedules === 'object') {
    db.settings.schedules = Object.assign({}, db.settings.schedules, req.body.schedules);
    for (const k of ['eod','weekly','monthly','hourly']) {
      if (req.body.schedules[k]) db.settings.schedules[k] = Object.assign({}, DEFAULT_SETTINGS.schedules[k], db.settings.schedules[k], req.body.schedules[k]);
    }
  }
  save();
  audit(req.user.username, 'settings.update', 'Updated settings');
  broadcast('settings:updated', {});
  res.json(db.settings);
});

// ---------------- Menu API ----------------
function dishOut(d) {
  return Object.assign({}, d, { image: d.customImg || d.img });
}
app.get('/api/menu', (req, res) => {
  res.json({ categories: db.categories, dishes: db.dishes.map(dishOut) });
});

app.post('/api/menu', requireAuth('menu.view'), requireMenuManage, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.cat) return res.status(400).json({ error: 'Name and category required' });
  const now = Date.now();
  const dish = {
    id: newId('dish'), name: String(b.name).slice(0, 120), cat: b.cat,
    half: Number(b.half) || 0, full: Number(b.full) || 0, veg: !!b.veg,
    desc: String(b.desc || '').slice(0, 400), badge: b.badge || '',
    img: b.img || '/img/menu/curry_bowl.jpg', customImg: '', inStock: b.inStock !== false,
    createdAt: now, updatedAt: now
  };
  db.dishes.unshift(dish);
  save();
  audit(req.user.username, 'menu.create', dish.name);
  broadcast('menu:updated', {});
  res.json(dishOut(dish));
});

app.put('/api/menu/:id', requireAuth('menu.view'), requireMenuManage, (req, res) => {
  const dish = db.dishes.find(d => d.id === req.params.id);
  if (!dish) return res.status(404).json({ error: 'Dish not found' });
  const b = req.body || {};
  ['name','cat','desc','badge','img'].forEach(k => { if (b[k] !== undefined) dish[k] = String(b[k]).slice(0, 400); });
  if (b.half !== undefined) dish.half = Number(b.half) || 0;
  if (b.full !== undefined) dish.full = Number(b.full) || 0;
  if (b.veg !== undefined) dish.veg = !!b.veg;
  if (b.inStock !== undefined) dish.inStock = !!b.inStock;
  if (b.customImg !== undefined) dish.customImg = String(b.customImg || '');
  dish.updatedAt = Date.now();
  save();
  audit(req.user.username, 'menu.update', dish.name);
  broadcast('menu:updated', {});
  res.json(dishOut(dish));
});

app.delete('/api/menu/:id', requireAuth('menu.view'), requireMenuManage, (req, res) => {
  const i = db.dishes.findIndex(d => d.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Dish not found' });
  const [removed] = db.dishes.splice(i, 1);
  save();
  audit(req.user.username, 'menu.delete', removed.name);
  broadcast('menu:updated', {});
  res.json({ ok: true, removed: removed.name });
});

app.post('/api/menu/:id/image', requireAuth('menu.view'), requireMenuManage, upload.single('image'), (req, res) => {
  const dish = db.dishes.find(d => d.id === req.params.id);
  if (!dish) return res.status(404).json({ error: 'Dish not found' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  dish.customImg = '/uploads/' + req.file.filename;
  dish.updatedAt = Date.now();
  save();
  audit(req.user.username, 'menu.image', dish.name + ' → ' + req.file.filename);
  broadcast('menu:updated', {});
  res.json(dishOut(dish));
});

app.post('/api/menu/:id/image-url', requireAuth('menu.view'), requireMenuManage, (req, res) => {
  const dish = db.dishes.find(d => d.id === req.params.id);
  if (!dish) return res.status(404).json({ error: 'Dish not found' });
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//.test(url) && !url.startsWith('/uploads/') && !url.startsWith('/img/')) {
    return res.status(400).json({ error: 'Must be an http(s) URL, /img/ path, or /uploads/ path' });
  }
  dish.customImg = url;
  dish.updatedAt = Date.now();
  save();
  broadcast('menu:updated', {});
  res.json(dishOut(dish));
});

app.post('/api/menu/:id/image-clear', requireAuth('menu.view'), requireMenuManage, (req, res) => {
  const dish = db.dishes.find(d => d.id === req.params.id);
  if (!dish) return res.status(404).json({ error: 'Dish not found' });
  dish.customImg = '';
  save();
  broadcast('menu:updated', {});
  res.json(dishOut(dish));
});

// Generic file upload (UPI QR, logo)
app.post('/api/upload', requireAuth('settings.view'), upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ path: '/uploads/' + req.file.filename });
});

// ---------------- Tables & QR ----------------
app.get('/api/tables', requireAuth('tables.manage'), (req, res) => res.json(db.tables));
app.post('/api/tables', requireAuth('tables.manage'), (req, res) => {
  const num = db.tables.length ? Math.max(...db.tables.map(t => t.num)) + 1 : 1;
  const t = { num, name: req.body.name || 'Table ' + num, active: true };
  db.tables.push(t);
  db.settings.tables = db.tables.filter(x => x.active).length;
  save();
  broadcast('settings:updated', {});
  res.json(t);
});
app.put('/api/tables/:num', requireAuth('tables.manage'), (req, res) => {
  const t = db.tables.find(x => x.num === Number(req.params.num));
  if (!t) return res.status(404).json({ error: 'Table not found' });
  if (req.body.name) t.name = String(req.body.name).slice(0, 40);
  if (req.body.active !== undefined) t.active = !!req.body.active;
  save();
  broadcast('settings:updated', {});
  res.json(t);
});

// ---------------- Orders ----------------
function orderPublic(o) {
  // safe for customer tracking
  return {
    id: o.id, type: o.type, table: o.table,
    items: o.items.map(i => ({ name: i.name, qty: i.qty, portion: i.portion })),
    total: o.total, subtotal: o.subtotal, gst: o.gst, deliveryFee: o.deliveryFee || 0,
    paymentMethod: o.payment.method, paymentStatus: o.payment.status,
    confirmationStatus: (o.confirmation && o.confirmation.status) || 'confirmed',
    requiresConfirmation: requiresConfirmation(o),
    kitchenStatus: o.kitchenStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    driverName: o.delivery && o.delivery.driverName || null,
    createdAt: o.createdAt,
    history: (o.history || []).map(h => ({ status: h.status, at: h.at }))
  };
}

/* phone validation — Indian mobile numbers, normalised */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  if (p.startsWith('0') && p.length === 11) p = p.slice(1);
  if (p.length === 10 && /^[6-9]/.test(p)) return p;
  return null;
}

/* Which orders need manager confirmation before kitchen release */
function requiresConfirmation(o) {
  const pol = db.settings.orderPolicy || {};
  if (!pol.counterPayRequiresConfirm && !pol.upiRequiresConfirm) return false;
  const m = o.payment.method;
  if (m === 'cash' && pol.counterPayRequiresConfirm) return true;
  if (m === 'upi' && pol.upiRequiresConfirm) return true;
  if (m === 'card' && pol.upiRequiresConfirm) return true;
  return false;
}

/* Backend-enforced kitchen release gate (not frontend) */
function releasedToKitchen(o) {
  const pol = db.settings.orderPolicy || {};
  if (requiresConfirmation(o) && (!o.confirmation || o.confirmation.status !== 'confirmed')) return false;
  if (pol.paymentRequiredBeforeKitchen !== false) {
    const paid = fin.paidTotal(o);
    if (paid < o.total) return false;
  }
  return true;
}
function maybeRelease(o, by) {
  if (o.kitchenStatus !== 'pending') return false;
  if (!releasedToKitchen(o)) return false;
  o.kitchenStatus = 'received';
  pushHistory(o, 'kitchen_received', by || 'system');
  io.to('kitchen').emit('order:new-ticket', orderPublic(o));
  return true;
}
function orderFull(o) { return o; }

function pushHistory(o, status, by) {
  o.history = o.history || [];
  o.history.push({ status, at: Date.now(), by: by || 'system' });
  o.updatedAt = Date.now();
}

function handleCreateOrder(req, res) {
  const b = req.body || {};
  const type = ['dinein','pickup','delivery'].includes(b.type) ? b.type : null;
  if (!type) return res.status(400).json({ error: 'Order type must be dinein, pickup or delivery' });
  if (!Array.isArray(b.items) || b.items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
  // prevent duplicate double-tap: client sends idempotencyKey
  if (b.idempotencyKey && db.orders.find(o => o.idempotencyKey === b.idempotencyKey)) {
    const existing = db.orders.find(o => o.idempotencyKey === b.idempotencyKey);
    return res.json({ ok: true, order: orderPublic(existing), duplicate: true });
  }

  const settings = db.settings;
  const items = [];
  for (const it of b.items) {
    const dish = db.dishes.find(d => d.id === it.menuId);
    if (!dish) return res.status(400).json({ error: 'Unknown dish in cart: ' + it.menuId });
    if (!dish.inStock) return res.status(400).json({ error: dish.name + ' is currently unavailable' });
    const portion = it.portion === 'half' && dish.half ? 'half' : 'full';
    const price = portion === 'half' ? dish.half : dish.full;
    const qty = Math.max(1, Math.min(50, parseInt(it.qty) || 1));
    items.push({
      menuId: dish.id, name: dish.name, portion, qty, price,
      spice: ['mild','medium','hot'].includes(it.spice) ? it.spice : 'medium',
      butter: ['regular','extra','low'].includes(it.butter) ? it.butter : 'regular',
      note: String(it.note || '').slice(0, 200), veg: dish.veg
    });
  }

  let table = null;
  if (type === 'dinein') {
    table = parseInt(b.table);
    const t = db.tables.find(x => x.num === table && x.active);
    if (!t) return res.status(400).json({ error: 'Invalid table number' });
  }
  const customer = {
    name: String(b.customer && b.customer.name || '').trim().slice(0, 80),
    phone: normalizePhone(b.customer && b.customer.phone) || '',
    address: String(b.customer && b.customer.address || '').slice(0, 300),
    instructions: String(b.customer && b.customer.instructions || '').slice(0, 300)
  };
  const pol = settings.orderPolicy || {};
  const isStaff = !!(req.user && req.user.role && req.user.role !== undefined && b.createdBy && String(b.createdBy).startsWith('pos:'));
  if (type === 'pickup' || type === 'delivery') {
    if (!customer.name) return res.status(400).json({ error: 'Name required for pickup/delivery' });
    if (!b.customer || !b.customer.phone) return res.status(400).json({ error: 'Phone number is required for pickup and delivery orders' });
    if (!customer.phone) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number (starting 6-9)' });
  }
  if (type === 'dinein' && pol.dineInRequireContact && !customer.phone) {
    return res.status(400).json({ error: 'A phone number is required for dine-in orders (set in admin policy)' });
  }
  if (type === 'delivery') {
    if (!customer.address) return res.status(400).json({ error: 'Delivery address required' });
    if (!settings.acceptOnlineDelivery) return res.status(400).json({ error: 'Delivery is currently disabled' });
  }

  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const gst = Math.round(subtotal * (settings.gstRate || 0) / 100);
  let deliveryFee = 0;
  if (type === 'delivery') {
    if (subtotal < settings.minDeliveryOrder) return res.status(400).json({ error: 'Minimum delivery order is ₹' + settings.minDeliveryOrder });
    deliveryFee = subtotal >= settings.freeDeliveryAbove ? 0 : settings.deliveryFee;
  }
  const total = subtotal + gst + deliveryFee;

  // simple rate-limit: max 3 orders per phone per 5 min (duplicate protection)
  if (customer.phone) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    const recent = db.orders.filter(o => o.customer && o.customer.phone === customer.phone && o.createdAt > cutoff && o.kitchenStatus !== 'cancelled').length;
    if (recent >= 3) return res.status(429).json({ error: 'Too many orders in the last few minutes. Please wait before ordering again.' });
  }

  const method = ['upi','cash','card'].includes(b.paymentMethod) ? b.paymentMethod : 'cash';
  if (method === 'upi' && !settings.acceptUPI) return res.status(400).json({ error: 'UPI payments disabled' });
  if (method === 'cash' && !settings.acceptCash) return res.status(400).json({ error: 'Cash payments disabled' });

  db.counters.order++;
  const id = 'KRM-' + db.counters.order;
  const staffOrder = !!(b.createdBy && String(b.createdBy).startsWith('pos:'));
  const autoConfirm = staffOrder && pol.autoConfirmPosOrders !== false;
  const order = {
    id, idempotencyKey: b.idempotencyKey || null,
    type, table, customer, items,
    subtotal, gst, deliveryFee, total, discount: 0,
    notes: String(b.notes || '').slice(0, 300),
    payment: {
      method, status: 'awaiting_verification', // pending | awaiting_verification | paid | refunded | cancelled
      verifiedBy: null, verifiedAt: null, note: ''
    },
    payments: [{ id: newId('pay'), method, amount: total, status: method === 'cash' ? 'pending' : 'awaiting_verification', by: 'system', at: Date.now(), ref: '' }],
    refunds: [],
    confirmation: {
      status: autoConfirm ? 'confirmed' : 'pending_confirmation',
      by: autoConfirm ? (req.user ? req.user.username : 'system') : null,
      at: autoConfirm ? Date.now() : null,
      notes: autoConfirm ? 'Auto-confirmed (staff POS order)' : '',
      contactedAt: null, contactedBy: null
    },
    kitchenStatus: 'pending', // pending | received | in_progress | completed | cancelled
    fulfillmentStatus: 'open', // open | ready | collected | served | assigned | picked_up | out_for_delivery | delivered | closed | cancelled
    delivery: type === 'delivery' ? { driverId: null, driverName: null, history: [] } : null,
    history: [], itemsChecked: [],
    trackToken: crypto.randomBytes(10).toString('hex'),
    createdAt: Date.now(), updatedAt: Date.now(),
    createdBy: req.body.createdBy || 'customer'
  };
  pushHistory(order, 'created', order.createdBy);
  if (autoConfirm) pushHistory(order, 'confirmed:' + order.confirmation.notes, order.createdBy);
  pushHistory(order, 'payment_awaiting', 'system');
  db.orders.unshift(order);
  save();
  audit(order.createdBy, 'order.create', id + ' ₹' + total + ' ' + type + ' ' + method + (autoConfirm ? ' auto-confirmed' : ' pending confirmation'));
  broadcast('order:new', orderPublic(order));
  if (order.confirmation.status === 'pending_confirmation') broadcast('order:pending_confirmation', orderPublic(order));
  res.json({ ok: true, order: orderPublic(order), requiresConfirmation: requiresConfirmation(order), checkoutInstructions: settings.checkoutInstructions });
}

app.post('/api/orders', (req, res) => handleCreateOrder(req, res));

app.get('/api/orders', requireAuth('orders.view'), (req, res) => {
  let list = db.orders;
  if (req.user.role === 'driver') {
    list = list.filter(o => o.delivery && o.delivery.driverId === req.user.driverId);
  }
  const limit = Math.min(200, parseInt(req.query.limit) || 100);
  const q = (req.query.q || '').toLowerCase();
  if (q) list = list.filter(o => o.id.toLowerCase().includes(q) || (o.customer.name || '').toLowerCase().includes(q) || String(o.table) === q);
  if (req.query.status) list = list.filter(o => o.kitchenStatus === req.query.status);
  res.json(list.slice(0, limit));
});

app.get('/api/orders/:id', requireAuth('orders.view'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role === 'driver' && (!o.delivery || o.delivery.driverId !== req.user.driverId)) {
    return res.status(403).json({ error: 'Not your delivery' });
  }
  res.json(o);
});

// Public customer tracking
app.get('/api/track/:id', (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id && x.trackToken === req.query.token);
  if (!o) return res.status(404).json({ error: 'Order not found or invalid tracking token' });
  res.json(orderPublic(o));
});

// PAYMENT CONFIRMATION — creates/updates payment records, then maybe releases to kitchen
function syncPaymentSummary(o) {
  const paid = fin.paidTotal(o);
  const ref = fin.refundedTotal(o);
  const pend = fin.pendingVerificationTotal(o);
  if (ref >= o.total && paid === 0) { o.payment.status = 'refunded'; return; }
  if (paid >= o.total) { o.payment.status = 'paid'; o.payment.verifiedAt = Date.now(); return; }
  if (pend > 0) { o.payment.status = 'awaiting_verification'; return; }
  if (o.payment.status !== 'paid') o.payment.status = 'pending';
}
app.post('/api/orders/:id/confirm-payment', requireAuth('orders.pay'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.payment.status === 'paid') return res.status(409).json({ error: 'Payment already confirmed' });
  if (o.kitchenStatus === 'cancelled') return res.status(409).json({ error: 'Order was cancelled' });
  const method = ['upi','cash','card'].includes(req.body.method) ? req.body.method : o.payment.method;
  const amount = Math.max(0, Math.min(o.total, Number(req.body.amount) || o.total));
  o.payment.method = method;
  // mark existing pending/awaiting records for this method as paid, or add a new record
  let rec = (o.payments || []).find(p => p.method === method && p.status !== 'paid' && p.status !== 'refunded');
  if (!rec) {
    rec = { id: newId('pay'), method, amount: 0, status: 'pending', by: 'system', at: Date.now(), ref: String(req.body.ref || '').slice(0, 60) };
    o.payments = o.payments || [];
    o.payments.push(rec);
  }
  rec.amount = amount;
  rec.status = 'paid';
  rec.by = req.user.name || req.user.username;
  rec.at = Date.now();
  rec.ref = String(req.body.ref || rec.ref || '').slice(0, 60);
  o.payment.status = 'paid';
  o.payment.verifiedBy = req.user.name || req.user.username;
  o.payment.verifiedAt = Date.now();
  o.payment.note = String(req.body.note || '').slice(0, 200);
  pushHistory(o, 'payment_paid:' + method + ' ₹' + amount, req.user.username);
  const released = maybeRelease(o, 'system');
  if (released) pushHistory(o, 'kitchen_received', 'system');
  save();
  audit(req.user.username, 'order.pay', o.id + ' ₹' + amount + ' via ' + method + (released ? ' → kitchen' : ' (held)'));
  broadcast('order:updated', orderPublic(o));
  broadcast('order:paid', { id: o.id, total: o.total, method, table: o.table, type: o.type });
  res.json(o);
});

// ORDER CONFIRMATION — manager/cashier confirms a pending order (separate from payment)
app.post('/api/orders/:id/confirm', requireAuth('orders.confirm'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!o.confirmation) o.confirmation = { status: 'confirmed', by: null, at: null, notes: '', contactedAt: null, contactedBy: null };
  if (o.confirmation.status === 'confirmed') return res.status(409).json({ error: 'Order already confirmed' });
  if (o.confirmation.status === 'rejected') return res.status(409).json({ error: 'Order was rejected — customer must reorder' });
  if (o.kitchenStatus === 'cancelled') return res.status(409).json({ error: 'Order was cancelled' });
  o.confirmation.status = 'confirmed';
  o.confirmation.by = req.user.name || req.user.username;
  o.confirmation.at = Date.now();
  o.confirmation.notes = String(req.body.notes || '').slice(0, 300);
  pushHistory(o, 'confirmed' + (o.confirmation.notes ? ':' + o.confirmation.notes : ''), req.user.username);
  const released = maybeRelease(o, 'system');
  save();
  audit(req.user.username, 'order.confirm', o.id + (released ? ' → kitchen' : ' (payment still pending)'));
  broadcast('order:updated', orderPublic(o));
  res.json(o);
});

app.post('/api/orders/:id/reject', requireAuth('orders.confirm'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.confirmation && (o.confirmation.status === 'confirmed' || o.confirmation.status === 'rejected')) {
    return res.status(409).json({ error: 'Order already ' + o.confirmation.status });
  }
  if (o.kitchenStatus === 'cancelled') return res.status(409).json({ error: 'Order was cancelled' });
  const reason = String(req.body.reason || 'Rejected by restaurant').slice(0, 200);
  o.confirmation = o.confirmation || {};
  o.confirmation.status = 'rejected';
  o.confirmation.by = req.user.name || req.user.username;
  o.confirmation.at = Date.now();
  o.confirmation.notes = reason;
  // reject = cancel order; void any non-paid payment records
  o.kitchenStatus = 'cancelled';
  o.fulfillmentStatus = 'cancelled';
  (o.payments || []).forEach(p => { if (p.status !== 'paid') p.status = 'cancelled'; });
  if (o.payment.status !== 'paid' && o.payment.status !== 'refunded') o.payment.status = 'cancelled';
  pushHistory(o, 'rejected:' + reason, req.user.username);
  save();
  audit(req.user.username, 'order.reject', o.id + ' — ' + reason);
  broadcast('order:updated', orderPublic(o));
  res.json(o);
});

app.post('/api/orders/:id/contacted', requireAuth('orders.confirm'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  o.confirmation = o.confirmation || { status: 'pending_confirmation' };
  o.confirmation.contactedAt = Date.now();
  o.confirmation.contactedBy = req.user.name || req.user.username;
  pushHistory(o, 'customer_contacted', req.user.username);
  save();
  broadcast('order:updated', orderPublic(o));
  res.json(o);
});

// Kitchen stage transitions — backend enforces confirmation + payment release
app.post('/api/orders/:id/kitchen', requireAuth('orders.kitchen'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!releasedToKitchen(o)) {
    const why = requiresConfirmation(o) && (!o.confirmation || o.confirmation.status !== 'confirmed')
      ? 'Order is awaiting restaurant confirmation'
      : 'Payment not confirmed — order cannot enter kitchen';
    return res.status(409).json({ error: why });
  }
  const next = req.body.status;
  const allowed = { received: ['in_progress'], in_progress: ['completed'] };
  if (!allowed[o.kitchenStatus] || !allowed[o.kitchenStatus].includes(next)) {
    return res.status(409).json({ error: 'Invalid kitchen transition: ' + o.kitchenStatus + ' → ' + next });
  }
  o.kitchenStatus = next;
  if (next === 'completed') {
    if (o.type === 'dinein') o.fulfillmentStatus = 'ready';
    if (o.type === 'pickup') o.fulfillmentStatus = 'ready';
    if (o.type === 'delivery') o.fulfillmentStatus = 'ready';
  }
  pushHistory(o, 'kitchen_' + next, req.user.username);
  save();
  audit(req.user.username, 'order.kitchen', o.id + ' → ' + next);
  broadcast('order:updated', orderPublic(o));
  res.json(o);
});

// Strike individual items in kitchen
app.post('/api/orders/:id/check-item', requireAuth('orders.kitchen'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const idx = parseInt(req.body.index);
  const pos = o.itemsChecked.indexOf(idx);
  if (pos === -1) o.itemsChecked.push(idx); else o.itemsChecked.splice(pos, 1);
  save();
  broadcast('order:updated', orderPublic(o));
  res.json(o);
});

// Mark served (dine-in) / collected (pickup)
app.post('/api/orders/:id/fulfil', requireAuth('orders.pay'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.kitchenStatus !== 'completed') return res.status(409).json({ error: 'Kitchen has not completed this order yet' });
  if (o.type === 'dinein') { o.fulfillmentStatus = 'served'; pushHistory(o, 'served', req.user.username); }
  if (o.type === 'pickup') { o.fulfillmentStatus = 'collected'; pushHistory(o, 'collected', req.user.username); }
  save();
  audit(req.user.username, 'order.fulfil', o.id);
  broadcast('order:updated', orderPublic(o));
  res.json(o);
});

// Cancel order
app.post('/api/orders/:id/cancel', requireAuth('orders.cancel'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (['delivered','served','collected'].includes(o.fulfillmentStatus)) return res.status(409).json({ error: 'Order already completed' });
  const reason = String(req.body.reason || 'Cancelled by staff').slice(0, 200);
  o.kitchenStatus = 'cancelled';
  o.fulfillmentStatus = 'cancelled';
  if (!o.confirmation || o.confirmation.status === 'pending_confirmation') {
    o.confirmation = o.confirmation || {};
    o.confirmation.status = 'rejected';
    o.confirmation.by = req.user.name || req.user.username;
    o.confirmation.at = Date.now();
    o.confirmation.notes = o.confirmation.notes || reason;
  }
  const paid = fin.paidTotal(o);
  if (paid > 0) {
    o.refunds = o.refunds || [];
    o.refunds.push({ id: newId('ref'), amount: paid, method: o.payment.method, by: req.user.name || req.user.username, at: Date.now(), reason });
    (o.payments || []).forEach(p => { if (p.status === 'paid') p.status = 'refunded'; });
    o.payment.status = 'refunded';
  } else {
    (o.payments || []).forEach(p => { if (p.status !== 'paid') p.status = 'cancelled'; });
    o.payment.status = 'cancelled';
  }
  pushHistory(o, 'cancelled:' + reason, req.user.username);
  save();
  audit(req.user.username, 'order.cancel', o.id + ' — ' + reason + (paid > 0 ? ' (refunded ₹' + paid + ')' : ''));
  broadcast('order:updated', orderPublic(o));
  res.json(o);
});

// POS creates a staff order (same validation, marks createdBy)
app.post('/api/orders/pos', requireAuth('orders.create'), (req, res) => {
  req.body.createdBy = 'pos:' + req.user.username;
  handleCreateOrder(req, res);
});

// ---------------- Delivery ----------------
app.get('/api/deliveries/available', requireAuth('orders.view'), (req, res) => {
  const list = db.orders.filter(o => o.type === 'delivery' && o.kitchenStatus === 'completed' && !o.delivery.driverId);
  res.json(list.map(orderPublic));
});

app.post('/api/orders/:id/assign-driver', requireAuth('orders.delivery.assign'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.type !== 'delivery') return res.status(400).json({ error: 'Not a delivery order' });
  if (o.kitchenStatus !== 'completed') return res.status(409).json({ error: 'Kitchen must complete the order before assignment' });
  const drv = db.drivers.find(d => d.id === req.body.driverId && d.active);
  if (!drv) return res.status(400).json({ error: 'Invalid driver' });
  o.delivery = o.delivery || { history: [] };
  o.delivery.driverId = drv.id;
  o.delivery.driverName = drv.name;
  o.fulfillmentStatus = 'assigned';
  o.delivery.history.push({ status: 'assigned', at: Date.now(), by: req.user.username, driver: drv.name });
  pushHistory(o, 'driver_assigned:' + drv.name, req.user.username);
  save();
  audit(req.user.username, 'delivery.assign', o.id + ' → ' + drv.name);
  broadcast('order:updated', orderPublic(o));
  io.to('driver_' + drv.id).emit('delivery:assigned', orderPublic(o));
  res.json(o);
});

app.post('/api/orders/:id/driver-status', requireAuth('orders.delivery'), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o || !o.delivery || o.delivery.driverId !== req.user.driverId) return res.status(403).json({ error: 'Not your delivery' });
  const next = req.body.status; // picked_up | out_for_delivery | delivered | failed
  const allowed = { assigned: ['picked_up','failed'], picked_up: ['out_for_delivery','failed'], out_for_delivery: ['delivered','failed'] };
  if (!allowed[o.fulfillmentStatus] || !allowed[o.fulfillmentStatus].includes(next)) {
    return res.status(409).json({ error: 'Invalid transition from ' + o.fulfillmentStatus });
  }
  o.fulfillmentStatus = next;
  o.delivery.history.push({ status: next, at: Date.now(), by: req.user.name });
  pushHistory(o, 'driver_' + next, req.user.name);
  if (next === 'delivered') o.fulfillmentStatus = 'delivered';
  if (next === 'failed') { o.fulfillmentStatus = 'open'; o.delivery.driverId = null; o.delivery.driverName = null; }
  save();
  audit(req.user.name, 'delivery.status', o.id + ' → ' + next);
  broadcast('order:updated', orderPublic(o));
  res.json(o);
});

app.get('/api/drivers', requireAuth('drivers.manage'), (req, res) => {
  res.json(db.drivers.map(d => ({ id: d.id, name: d.name, phone: d.phone, active: d.active })));
});
app.post('/api/drivers', requireAuth('drivers.manage'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.pin) return res.status(400).json({ error: 'Name and PIN required' });
  const drv = { id: newId('drv'), name: String(b.name).slice(0, 60), phone: String(b.phone || '').slice(0, 15), pin: String(b.pin).slice(0, 8), active: true };
  db.drivers.push(drv);
  save();
  res.json(drv);
});
app.put('/api/drivers/:id', requireAuth('drivers.manage'), (req, res) => {
  const drv = db.drivers.find(d => d.id === req.params.id);
  if (!drv) return res.status(404).json({ error: 'Driver not found' });
  if (req.body.name) drv.name = String(req.body.name).slice(0, 60);
  if (req.body.phone) drv.phone = String(req.body.phone).slice(0, 15);
  if (req.body.pin) drv.pin = String(req.body.pin).slice(0, 8);
  if (req.body.active !== undefined) drv.active = !!req.body.active;
  save();
  res.json(drv);
});
app.get('/api/drivers/list-public', (req, res) => {
  res.json(db.drivers.filter(d => d.active).map(d => ({ id: d.id, name: d.name })));
});

// ---------------- Staff users (admin) ----------------
app.get('/api/users', requireAuth(), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  res.json(db.users.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active !== false })));
});
app.post('/api/users', requireAuth(), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const b = req.body || {};
  if (!b.username || !b.password || !b.role) return res.status(400).json({ error: 'Username, password, role required' });
  if (db.users.find(u => u.username === b.username)) return res.status(409).json({ error: 'Username exists' });
  const u = { id: newId('usr'), username: String(b.username).slice(0, 40), name: String(b.name || b.username).slice(0, 60), role: b.role, pass: hashPassword(b.password), active: true };
  db.users.push(u);
  save();
  audit(req.user.username, 'user.create', u.username + ' (' + u.role + ')');
  res.json({ id: u.id, username: u.username, name: u.name, role: u.role });
});
app.put('/api/users/:id', requireAuth(), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (req.body.password) u.pass = hashPassword(req.body.password);
  if (req.body.name) u.name = String(req.body.name).slice(0, 60);
  if (req.body.role) u.role = req.body.role;
  if (req.body.active !== undefined) u.active = !!req.body.active;
  save();
  res.json({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active });
});

// ---------------- Finance (Phase 11/12) ----------------
function financeFor(req, period, customFrom, customTo) {
  const off = db.settings.tzOffsetMinutes || 330;
  const b = fin.periodBounds(period || 'today', off, customFrom, customTo);
  const span = b.to - b.from;
  const prev = { from: b.from - span, to: b.from };
  const report = fin.computeFinance(db, b.from, b.to, prev.from, prev.to);
  report.periodLabel = period || 'today';
  return report;
}

app.get('/api/finance/today', requireAuth('finance.view'), (req, res) => {
  res.json(financeFor(req, 'today'));
});

app.get('/api/finance/report', requireAuth('finance.view'), (req, res) => {
  const { period, from, to } = req.query;
  res.json(financeFor(req, period || 'today', from, to));
});

app.get('/api/finance/report.md', requireAuth('finance.view'), (req, res) => {
  const f = financeFor(req, req.query.period || 'today', req.query.from, req.query.to);
  const md = fin.toMarkdown(f, db.settings, (req.query.period || 'today') + ' report');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="karims-finance-' + (req.query.period || 'today') + '.md"');
  res.send(md);
});

app.get('/api/finance/report.pdf', requireAuth('finance.view'), (req, res) => {
  const f = financeFor(req, req.query.period || 'today', req.query.from, req.query.to);
  const s = db.settings, cur = s.currency || '₹';
  const M = n => cur + Number(n || 0).toLocaleString('en-IN');
  const dt = ts => new Date(ts + (s.tzOffsetMinutes || 330) * 60000).toISOString().slice(0, 16).replace('T', ' ');
  const pdf = new Pdf();
  // header
  pdf.rect(0, 0, 595.28, 78, 0.29);
  pdf.text(MARGIN, 34, (s.name || "KARIM'S").toUpperCase(), { size: 20, bold: true, color: '1 0.92 0.65' });
  pdf.text(MARGIN, 50, s.tagline || 'Mughlai Restaurant Platform', { size: 9, color: '1 1 1' });
  pdf.text(A4_W - MARGIN, 34, (req.query.period || 'today').toUpperCase() + ' FINANCIAL REPORT', { size: 11, bold: true, color: '1 1 1', align: 'right' });
  pdf.text(A4_W - MARGIN, 50, 'Period: ' + dt(f.from) + ' – ' + dt(f.to), { size: 8, color: '0.9 0.9 0.9', align: 'right' });
  pdf.y = 92;
  const sum = f.summary;
  pdf.text(MARGIN, pdf.y, 'A. EXECUTIVE SUMMARY', { size: 11, bold: true }); pdf.y += 16;
  pdf.table(
    [{ label: 'Metric', w: 250 }, { label: 'Value', w: 100, align: 'right' }, { label: 'Metric', w: 145 }, { label: 'Value', w: 60, align: 'right' }],
    [
      ['Total orders', sum.orderCount, 'Net sales', M(sum.netSales)],
      ['Completed', sum.completedOrders, 'Payments received', M(sum.paymentsReceived)],
      ['Cancelled', sum.cancelledOrders + ' (' + M(sum.cancelledImpact) + ')', 'Outstanding', M(sum.outstanding)],
      ['Gross sales', M(sum.grossSales), 'Awaiting UPI verify', M(sum.awaitingUpi)],
      ['Discounts', M(sum.discounts), 'Taxes collected', M(sum.taxes)],
      ['Refunds', M(sum.refunds), 'Delivery charges', M(sum.deliveryCharges)],
      ['Average order value', M(sum.aov), 'Growth vs prev', sum.growthPct != null ? sum.growthPct + '%' : '—']
    ], { size: 8 });
  pdf.text(MARGIN, pdf.y, 'B. ITEM-WISE SALES (BY QUANTITY)', { size: 11, bold: true }); pdf.y += 14;
  pdf.table(
    [{ label: '#', w: 26 }, { label: 'Item', w: 230 }, { label: 'Portion', w: 70 }, { label: 'Qty', w: 50, align: 'right' }, { label: 'Net sales', w: 90, align: 'right' }, { label: '%', w: 60, align: 'right' }],
    f.byQty.slice(0, 40).map((i, n) => [n + 1, i.name, i.portion, i.qty, M(i.net), i.pct + '%']), { size: 8 });
  if (!f.byQty.length) { pdf.text(MARGIN, pdf.y, 'No sales in this period.', { size: 9 }); pdf.y += 16; }
  pdf.text(MARGIN, pdf.y, 'C. PAYMENT RECONCILIATION', { size: 11, bold: true }); pdf.y += 14;
  const r = f.reconciliation.byMethod;
  pdf.table(
    [{ label: 'Method', w: 110 }, { label: 'Received', w: 100, align: 'right' }, { label: 'Pending', w: 100, align: 'right' }, { label: 'Refunded', w: 100, align: 'right' }],
    [['Cash', M(r.cash.received), M(r.cash.pending), M(r.cash.refunded)],
     ['UPI', M(r.upi.received), M(r.upi.pending), M(r.upi.refunded)],
     ['Card', M(r.card.received), M(r.card.pending), M(r.card.refunded)],
     ['TOTAL', M(f.reconciliation.totalReceived), M(f.reconciliation.awaitingVerification), M(f.reconciliation.refunds)]],
    { size: 8 });
  pdf.text(MARGIN, pdf.y, 'Cash drawer: opening ' + M(f.cash.opening) + ' · received ' + M(f.cash.in) + ' · withdrawals ' + M(f.cash.withdrawals) + ' · expenses ' + M(f.cash.expenses) + ' · expected ' + M(f.cash.expected) + (f.cash.counted != null ? ' · counted ' + M(f.cash.counted) + ' · variance ' + M(f.cash.variance) : ' · not closed'), { size: 8 });
  pdf.y += 18;
  pdf.text(MARGIN, pdf.y, 'D. ORDER CHANNELS', { size: 11, bold: true }); pdf.y += 14;
  pdf.table(
    [{ label: 'Channel', w: 160 }, { label: 'Orders', w: 90, align: 'right' }, { label: 'Sales', w: 110, align: 'right' }],
    Object.entries(f.channels).map(([k, v]) => [k, v.orders, M(v.sales)]), { size: 8 });
  pdf.text(MARGIN, pdf.y, 'E. OPERATIONAL SUMMARY', { size: 11, bold: true }); pdf.y += 14;
  pdf.table(
    [{ label: 'Metric', w: 220 }, { label: 'Value', w: 90, align: 'right' }],
    [['Awaiting confirmation', f.operational.awaitingConfirm],
     ['In kitchen', f.operational.awaitingKitchen],
     ['Completed orders', f.operational.completedOrders],
     ['Deliveries completed', f.operational.deliveryDone],
     ['Cancelled orders', f.operational.cancelledOrders],
     ['Refunds (' + f.operational.refundCount + ')', M(f.operational.refundTotal)]], { size: 8 });
  pdf.y += 6;
  pdf.text(MARGIN, pdf.y, 'Generated ' + dt(Date.now()) + ' — ' + (s.name || "KARIM'S") + ' Restaurant Platform. Amounts in ' + cur + '.', { size: 7, color: '0.4 0.4 0.4' });
  const buf = pdf.render({ title: (s.name || "KARIM'S") + ' Finance Report' });
  audit(req.user.username, 'finance.export.pdf', req.query.period || 'today');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="karims-finance-' + (req.query.period || 'today') + '.pdf"');
  res.send(buf);
});

app.get('/api/finance/export.csv', requireAuth('finance.view'), (req, res) => {
  const f = financeFor(req, req.query.period || 'today', req.query.from, req.query.to);
  const kind = req.query.kind === 'orders' ? 'orders' : 'items';
  const csv = kind === 'orders' ? fin.ordersCsv(f) : fin.itemsCsv(f);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="karims-' + kind + '-' + (req.query.period || 'today') + '.csv"');
  res.send(csv);
});

// manual refund
app.post('/api/finance/refund', requireAuth('finance.close'), (req, res) => {
  const o = db.orders.find(x => x.id === req.body.orderId);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const paid = fin.paidTotal(o);
  const already = fin.refundedTotal(o);
  const amount = Math.max(0, Math.min(paid - already, Number(req.body.amount) || (paid - already)));
  if (amount <= 0) return res.status(400).json({ error: 'Nothing to refund (paid ' + paid + ', refunded ' + already + ')' });
  const reason = String(req.body.reason || 'Refund by staff').slice(0, 200);
  o.refunds = o.refunds || [];
  o.refunds.push({ id: newId('ref'), amount, method: o.payment.method, by: req.user.name || req.user.username, at: Date.now(), reason });
  // consume paid payments
  let left = amount;
  for (const p of (o.payments || [])) {
    if (left <= 0) break;
    if (p.status === 'paid') {
      const take = Math.min(p.amount, left);
      left -= take;
      if (take >= p.amount) p.status = 'refunded'; else p.amount -= take;
    }
  }
  syncPaymentSummary(o);
  pushHistory(o, 'refund:₹' + amount + ' — ' + reason, req.user.username);
  save();
  audit(req.user.username, 'finance.refund', o.id + ' ₹' + amount + ' — ' + reason);
  broadcast('order:updated', orderPublic(o));
  res.json(o);
});

// cash drawer movements
app.post('/api/finance/cash-movement', requireAuth('finance.close'), (req, res) => {
  const type = ['deposit','withdrawal','expense'].includes(req.body.type) ? req.body.type : null;
  if (!type) return res.status(400).json({ error: 'type must be deposit, withdrawal or expense' });
  const amount = Number(req.body.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be positive' });
  const m = { id: newId('cash'), type, amount, note: String(req.body.note || '').slice(0, 200), by: req.user.name || req.user.username, at: Date.now() };
  db.cashMovements = db.cashMovements || [];
  db.cashMovements.push(m);
  save();
  audit(req.user.username, 'finance.cash.' + type, '₹' + amount + ' ' + m.note);
  res.json(m);
});
app.get('/api/finance/cash-movements', requireAuth('finance.view'), (req, res) => {
  const b = fin.periodBounds(req.query.period || 'today', db.settings.tzOffsetMinutes || 330, req.query.from, req.query.to);
  res.json((db.cashMovements || []).filter(m => m.at >= b.from && m.at < b.to).reverse());
});

// end-of-day close
app.post('/api/finance/day-close', requireAuth('finance.close'), (req, res) => {
  const off = db.settings.tzOffsetMinutes || 330;
  const b = fin.bizDayBounds(Date.now(), off, 0);
  const bizDate = new Date(b.from + off * 60000).toISOString().slice(0, 10);
  if ((db.dayCloses || []).find(c => c.businessDate === bizDate)) {
    return res.status(409).json({ error: 'Today is already closed. Use reopen to correct.' });
  }
  const f = fin.computeFinance(db, b.from, b.to, b.from, b.to);
  const counted = req.body.countedCash;
  if (counted === undefined || counted === null || isNaN(Number(counted))) return res.status(400).json({ error: 'countedCash required' });
  const close = {
    id: newId('close'), businessDate: bizDate, at: Date.now(),
    by: req.user.name || req.user.username,
    summary: f.summary, cash: f.cash,
    countedCash: Number(counted),
    variance: +(Number(counted) - f.cash.expected).toFixed(2),
    note: String(req.body.note || '').slice(0, 300)
  };
  db.dayCloses = db.dayCloses || [];
  db.dayCloses.push(close);
  save();
  audit(req.user.username, 'finance.day_close', bizDate + ' variance ' + close.variance);
  res.json(close);
});
app.get('/api/finance/day-closes', requireAuth('finance.view'), (req, res) => {
  res.json((db.dayCloses || []).slice(-60).reverse());
});
app.post('/api/finance/day-reopen', requireAuth('finance.close'), (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Admin/manager only' });
  const i = (db.dayCloses || []).findIndex(c => c.businessDate === req.body.businessDate);
  if (i === -1) return res.status(404).json({ error: 'Day close not found' });
  const [c] = db.dayCloses.splice(i, 1);
  save();
  audit(req.user.username, 'finance.day_reopen', c.businessDate);
  res.json({ ok: true, reopened: c.businessDate });
});

// report sharing — honest statuses (email attempts real SMTP; WhatsApp is manual link)
app.post('/api/finance/share', requireAuth('finance.view'), async (req, res) => {
  const channel = ['email','whatsapp'].includes(req.body.channel) ? req.body.channel : null;
  if (!channel) return res.status(400).json({ error: 'channel must be email or whatsapp' });
  const f = financeFor(req, req.body.period || 'today', req.body.from, req.body.to);
  const s = db.settings;
  const summaryText = (s.name || "KARIM'S") + ' ' + (req.body.period || 'today') + ' report: orders ' + f.summary.orderCount + ', net sales ' + (s.currency||'₹') + f.summary.netSales + ', received ' + (s.currency||'₹') + f.summary.paymentsReceived + ', outstanding ' + (s.currency||'₹') + f.summary.outstanding + '.';
  const delivery = { id: newId('rpt'), at: Date.now(), by: req.user.name || req.user.username, channel, period: req.body.period || 'today', status: 'pending', detail: '' };
  db.reportDeliveries = db.reportDeliveries || [];
  db.reportDeliveries.push(delivery);
  if (channel === 'email') {
    const to = (req.body.to && String(req.body.to).split(',').map(x => x.trim()).filter(Boolean)) || (s.email && s.email.recipients) || [];
    const result = await smtpSend(s.email, {
      to, subject: (s.name || "KARIM'S") + ' — ' + (req.body.period || 'today') + ' financial report',
      text: summaryText + '\n\nOpen the Finance dashboard for the full breakdown.',
      attachments: [{ filename: 'karims-finance-' + (req.body.period || 'today') + '.md', contentType: 'text/markdown', content: fin.toMarkdown(f, s, req.body.period || 'today') }]
    });
    delivery.status = result.status;
    delivery.detail = result.detail;
    delivery.ok = !!result.ok;
    save();
    audit(req.user.username, 'finance.share.email', result.status + ' — ' + result.detail);
    return res.json({ ok: result.ok, status: result.status, detail: result.detail, delivery });
  }
  const result = whatsappShare(s.whatsapp, { number: req.body.number, text: summaryText });
  delivery.status = result.status;
  delivery.detail = result.detail;
  delivery.ok = !!result.ok;
  delivery.url = result.url || null;
  save();
  audit(req.user.username, 'finance.share.whatsapp', result.status);
  res.json({ ok: result.ok, status: result.status, detail: result.detail, url: result.url || null, delivery });
});
app.get('/api/finance/deliveries', requireAuth('finance.view'), (req, res) => {
  res.json((db.reportDeliveries || []).slice(-40).reverse());
});

/* ---- report scheduler (server-side, idempotent) ---- */
let lastSchedulerMinute = -1;
function periodKeyFor(kind, off) {
  const now = Date.now() + off * 60000;
  const d = new Date(now);
  if (kind === 'eod') return 'eod-' + d.toISOString().slice(0, 10);
  if (kind === 'hourly') return 'hourly-' + d.toISOString().slice(0, 13);
  if (kind === 'weekly') {
    const monday = new Date(d); monday.setUTCDate(monday.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return 'weekly-' + monday.toISOString().slice(0, 10);
  }
  if (kind === 'monthly') return 'monthly-' + d.toISOString().slice(0, 7);
  return null;
}
function alreadyDelivered(key, kind) {
  return (db.reportDeliveries || []).some(r => r.schedulerKey === key && r.channel === kind && r.status === 'sent');
}
async function runScheduler() {
  const s = db.settings;
  if (!s.schedules || !s.email || !s.email.host) return;
  const off = s.tzOffsetMinutes || 330;
  const local = new Date(Date.now() + off * 60000);
  const hour = local.getUTCHours(), minute = local.getUTCMinutes(), dow = local.getUTCDay();
  for (const kind of ['eod','hourly','weekly','monthly']) {
    const cfg = s.schedules[kind];
    if (!cfg || !cfg.enabled) continue;
    let hit = false;
    if (kind === 'eod' && hour === (cfg.hour || 23) && minute === (cfg.minute || 30)) hit = true;
    if (kind === 'hourly' && minute === (cfg.minute || 0)) hit = true;
    if (kind === 'weekly' && dow === (cfg.weekday || 0) && hour === (cfg.hour || 22) && minute === 0) hit = true;
    if (kind === 'monthly' && local.getUTCDate() === (cfg.day || 1) && hour === (cfg.hour || 9) && minute === 0) hit = true;
    if (!hit) continue;
    const key = periodKeyFor(kind, off);
    const period = (kind === 'eod' || kind === 'hourly') ? 'today' : (kind === 'weekly' ? 'week' : 'month');
    if (alreadyDelivered(key, 'email')) continue;
    const f = financeFor(null, period);
    const summaryText = (s.name || "KARIM'S") + ' scheduled ' + kind + ' report: orders ' + f.summary.orderCount + ', net sales ' + (s.currency||'₹') + f.summary.netSales + '.';
    const result = await smtpSend(s.email, {
      to: s.email.recipients, subject: (s.name || "KARIM'S") + ' — scheduled ' + kind + ' report',
      text: summaryText, attachments: [{ filename: 'karims-' + kind + '.md', contentType: 'text/markdown', content: fin.toMarkdown(f, s, kind + ' report') }]
    });
    db.reportDeliveries.push({ id: newId('rpt'), at: Date.now(), by: 'scheduler', channel: 'email', period, kind, schedulerKey: key, status: result.status, detail: result.detail, ok: !!result.ok });
    save();
  }
}

// ---------------- Reports ----------------
app.get('/api/reports/today', requireAuth('reports.view'), (req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const today = db.orders.filter(o => o.createdAt >= t0 && o.kitchenStatus !== 'cancelled');
  const paid = today.filter(o => o.payment.status === 'paid');
  const cash = paid.filter(o => o.payment.method === 'cash').reduce((s, o) => s + o.total, 0);
  const upi = paid.filter(o => o.payment.method === 'upi').reduce((s, o) => s + o.total, 0);
  const card = paid.filter(o => o.payment.method === 'card').reduce((s, o) => s + o.total, 0);
  const gross = cash + upi + card;
  const awaiting = today.filter(o => o.payment.status !== 'paid' && o.payment.status !== 'refunded').length;
  const cooking = today.filter(o => ['received','in_progress'].includes(o.kitchenStatus)).length;
  const ready = today.filter(o => o.kitchenStatus === 'completed' && !['served','collected','delivered'].includes(o.fulfillmentStatus)).length;
  const deliveryPool = today.filter(o => o.type === 'delivery' && o.kitchenStatus === 'completed' && !o.delivery.driverId).length;
  const activeDrivers = today.filter(o => o.type === 'delivery' && ['assigned','picked_up','out_for_delivery'].includes(o.fulfillmentStatus)).length;
  const itemSales = {};
  paid.forEach(o => o.items.forEach(i => { itemSales[i.name] = (itemSales[i.name] || 0) + i.qty; }));
  const bestsellers = Object.entries(itemSales).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, qty]) => ({ name, qty }));
  const activeTables = new Set(paid.filter(o => o.type === 'dinein' && !['served'].includes(o.fulfillmentStatus)).map(o => o.table)).size;
  res.json({
    date: start.toISOString().slice(0, 10),
    orderCount: today.length, paidCount: paid.length,
    gross, cash, upi, card,
    aov: paid.length ? Math.round(gross / paid.length) : 0,
    awaitingPayment: awaiting, inKitchen: cooking, readyForRunner: ready,
    deliveryPool, activeDeliveries: activeDrivers, activeTables,
    tablesTotal: db.tables.filter(t => t.active).length,
    bestsellers,
    recent: today.slice(0, 15).map(orderPublic)
  });
});

app.get('/api/audit', requireAuth(), (req, res) => {
  if (!can(req.user.role, '*') && req.user.role !== 'manager') return res.status(403).json({ error: 'Forbidden' });
  res.json(db.audit.slice(0, 100));
});

// ---------------- Backup / restore ----------------
app.post('/api/backup', requireAuth(), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (IS_SERVERLESS) return res.status(503).json({ error: 'Backups unavailable on serverless (read-only filesystem)' });
  const file = path.join(BACKUP_DIR, 'backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  try { fs.copyFileSync(DB_FILE, file); } catch (e) { return res.status(500).json({ error: e.message }); }
  audit(req.user.username, 'backup', path.basename(file));
  res.json({ ok: true, file: path.basename(file) });
});
app.get('/api/backups', requireAuth(), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    res.json(fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 20));
  } catch (e) {
    res.json([]);
  }
});

// ---------------- Health / network info ----------------
app.get('/api/health', (req, res) => {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.keys(nets).forEach(name => nets[name].forEach(n => { if (n.family === 'IPv4' && !n.internal) ips.push(n.address); }));
  res.json({ ok: true, uptime: process.uptime(), ips, port: PORT, orders: db.orders.length, dishes: db.dishes.length, internet: true });
});

// ---------------- SPA route fallbacks ----------------
const PAGES = { '/pos': 'pos.html', '/kitchen': 'kitchen.html', '/kds': 'kitchen.html', '/manager': 'manager.html', '/delivery': 'delivery.html', '/admin': 'admin.html', '/track': 'track.html', '/finance': 'finance.html' };
app.get(Object.keys(PAGES), (req, res) => {
  res.sendFile(path.join(ROOT, 'public', PAGES[req.path]));
});
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message || 'Server error' });
});

// ---------------- Start ----------------
if (IS_SERVERLESS) {
  // Vercel / serverless: export the handler, never bind a port
  module.exports = app;
  console.log('serverless mode: exporting express handler');
} else {
  setInterval(() => { runScheduler().catch(e => console.error('scheduler:', e.message)); }, 60000);
  server.listen(PORT, HOST, () => {
    const nets = os.networkInterfaces();
    const ips = [];
    Object.keys(nets).forEach(name => nets[name].forEach(n => { if (n.family === 'IPv4' && !n.internal) ips.push(n.address); }));
    console.log('');
    console.log('  👑 KARIM\'S RESTAURANT PLATFORM — running');
    console.log('  ─────────────────────────────────────────');
    console.log('  Local:    http://localhost:' + PORT + '/');
    ips.forEach(ip => console.log('  Network:  http://' + ip + ':' + PORT + '/'));
    console.log('');
    console.log('  Customer  /            QR ordering');
    console.log('  Admin     /admin       password: admin@135');
    console.log('  POS       /pos         cashier@135 / manager@135');
    console.log('  Kitchen   /kitchen     kitchen@135');
    console.log('  Manager   /manager     manager@135');
    console.log('  Delivery  /delivery    driver PIN 1111 / 2222');
    console.log('  Finance   /finance     admin / manager');
    console.log('');
    console.log('  Data:     data/db.json (auto-saved)');
    console.log('  Uploads:  public/uploads/');
    console.log('');
  });
}
