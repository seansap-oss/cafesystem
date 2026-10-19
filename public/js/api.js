/* Karim's shared client — auth, fetch, socket, toasts, helpers */
(function () {
  const K = {};

  K.token = localStorage.getItem('karim_token') || '';
  K.user = JSON.parse(localStorage.getItem('karim_user') || 'null');

  K.setAuth = function (token, user) {
    K.token = token; K.user = user;
    localStorage.setItem('karim_token', token);
    localStorage.setItem('karim_user', JSON.stringify(user));
    if (K.socket) { K.socket.disconnect(); K.socket = null; }
  };
  K.clearAuth = function () {
    K.token = ''; K.user = null;
    localStorage.removeItem('karim_token');
    localStorage.removeItem('karim_user');
    if (K.socket) { K.socket.disconnect(); K.socket = null; }
  };

  K.api = async function (path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (K.token) headers['x-auth'] = K.token;
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.body = JSON.stringify(opts.body);
    }
    if (opts.body instanceof FormData) delete headers['Content-Type'];
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (res.status === 401 && !path.includes('/auth/')) {
      K.clearAuth();
      if (K.onUnauthorized) K.onUnauthorized();
      throw new Error(data.error || 'Not authenticated');
    }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  };

  K.login = async function (username, password) {
    const data = await K.api('/api/auth/login', { method: 'POST', body: { username, password } });
    K.setAuth(data.token, data.user);
    return data.user;
  };
  K.logout = async function () {
    try { await K.api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    K.clearAuth();
  };

  // Socket.IO with reconnect
  K.connect = function (rooms) {
    if (K.socket) return K.socket;
    K.socket = io({ auth: { token: K.token } });
    K.socket.on('connect', function () {
      (rooms || []).forEach(function (r) { K.socket.emit('join', r); });
    });
    return K.socket;
  };

  // ---------- toasts ----------
  K.toast = function (msg, kind) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  };

  // ---------- utils ----------
  K.money = function (n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); };
  K.time = function (ts) {
    return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  };
  K.ago = function (ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
  };
  K.qs = function (name) { return new URLSearchParams(location.search).get(name); };
  K.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  K.sound = function () {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.08;
      o.start(); o.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
      o.stop(ctx.currentTime + 0.3);
    } catch (e) {}
  };

  // Guard: staff pages
  K.requireRole = function (roles, redirect) {
    if (!K.user || !roles.includes(K.user.role)) {
      location.href = redirect || ('/pos');
      return false;
    }
    return true;
  };

  K.KITCHEN_LABEL = { pending: 'Pending', received: 'Received', in_progress: 'Cooking', completed: 'Completed', cancelled: 'Cancelled' };
  K.PAY_LABEL = { pending: 'Pending', awaiting_verification: 'Awaiting verification', paid: 'Paid', refunded: 'Refunded', cancelled: 'Cancelled' };
  K.FUL_LABEL = { open: 'Open', ready: 'Ready', collected: 'Collected', served: 'Served', assigned: 'Assigned', picked_up: 'Picked up', out_for_delivery: 'Out for delivery', delivered: 'Delivered', closed: 'Closed', cancelled: 'Cancelled' };
  K.TYPE_LABEL = { dinein: 'Dine-in', pickup: 'Pickup', delivery: 'Delivery' };

  window.K = K;
})();
