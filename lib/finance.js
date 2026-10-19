/* Finance engine — derives every figure from orders/payments/refunds.
 * No separate financial dataset. Transactional line prices are used so
 * historical reports never change when menu prices change.
 */

function inRange(ts, from, to) { return ts >= from && ts < to; }

function bizDayBounds(ts, offsetMin, dayOffset) {
  // business-day boundaries in restaurant timezone (default Asia/Kolkata +330)
  const off = (offsetMin == null ? 330 : offsetMin) * 60000;
  const local = new Date(ts + off);
  local.setUTCHours(0, 0, 0, 0);
  const start = local.getTime() - off + (dayOffset || 0) * 86400000;
  return { from: start, to: start + 86400000 };
}

function periodBounds(period, offsetMin, customFrom, customTo) {
  const now = Date.now();
  const off = (offsetMin == null ? 330 : offsetMin) * 60000;
  switch (period) {
    case 'today': return bizDayBounds(now, offsetMin, 0);
    case 'yesterday': return bizDayBounds(now, offsetMin, -1);
    case 'week': {
      const d = new Date(now + off);
      const dow = (d.getUTCDay() + 6) % 7; // Monday=0
      d.setUTCHours(0, 0, 0, 0);
      return { from: d.getTime() - off - dow * 86400000, to: now + 86400000 };
    }
    case 'prevweek': {
      const d = new Date(now + off);
      const dow = (d.getUTCDay() + 6) % 7;
      d.setUTCHours(0, 0, 0, 0);
      const thisStart = d.getTime() - off - dow * 86400000;
      return { from: thisStart - 7 * 86400000, to: thisStart };
    }
    case 'month': {
      const d = new Date(now + off);
      d.setUTCHours(0, 0, 0, 0); d.setUTCDate(1);
      return { from: d.getTime() - off, to: now + 86400000 };
    }
    case 'prevmonth': {
      const d = new Date(now + off);
      d.setUTCHours(0, 0, 0, 0); d.setUTCDate(1);
      const thisStart = d.getTime() - off;
      const prev = new Date(thisStart - 1);
      prev.setUTCDate(1);
      return { from: prev.getTime() - off, to: thisStart };
    }
    case 'custom': {
      const f = customFrom ? new Date(customFrom + 'T00:00:00').getTime() : now - 86400000;
      const t = customTo ? new Date(customTo + 'T23:59:59').getTime() : now;
      return { from: f, to: t + 1 };
    }
    default: return bizDayBounds(now, offsetMin, 0);
  }
}

/* paidTotal(order) — sum of successfully received money, from payment records */
function paidTotal(order) {
  if (order.payments && order.payments.length) {
    return order.payments.filter(p => p.status === 'paid').reduce((s, p) => s + p.amount, 0);
  }
  return order.payment && order.payment.status === 'paid' ? order.total : 0;
}
function refundedTotal(order) {
  if (order.refunds && order.refunds.length) return order.refunds.reduce((s, r) => s + r.amount, 0);
  return order.payment && order.payment.status === 'refunded' ? order.total : 0;
}
function pendingVerificationTotal(order) {
  if (order.payments && order.payments.length) {
    return order.payments.filter(p => p.status === 'awaiting_verification').reduce((s, p) => s + p.amount, 0);
  }
  return order.payment && order.payment.status === 'awaiting_verification' ? order.total : 0;
}

/* Build the complete finance dataset for a period */
function computeFinance(db, from, to, prevFrom, prevTo) {
  const orders = db.orders || [];
  const inP = orders.filter(o => inRange(o.createdAt, from, to));
  const inPrev = orders.filter(o => inRange(o.createdAt, prevFrom, prevTo));
  const active = inP.filter(o => o.kitchenStatus !== 'cancelled');
  const cancelled = inP.filter(o => o.kitchenStatus === 'cancelled');

  // ---- sales vs received ----
  let grossSales = 0, discounts = 0, taxes = 0, deliveryCharges = 0;
  let paymentsReceived = 0, outstanding = 0, awaitingUpi = 0, refunds = 0;
  const byMethod = { cash: { count: 0, received: 0, pending: 0, refunded: 0 }, upi: { count: 0, received: 0, pending: 0, refunded: 0 }, card: { count: 0, received: 0, pending: 0, refunded: 0 } };

  for (const o of active) {
    grossSales += o.subtotal || 0;
    discounts += o.discount || 0;
    taxes += o.gst || 0;
    deliveryCharges += o.deliveryFee || 0;
    const paid = paidTotal(o);
    const ref = refundedTotal(o);
    const pend = pendingVerificationTotal(o);
    awaitingUpi += pend;
    refunds += ref;
    paymentsReceived += paid;
    const outstandingAmt = Math.max(0, o.total - paid - ref);
    if (outstandingAmt > 0 && o.payment.status !== 'refunded') outstanding += outstandingAmt;
    // per-method
    const pmts = (o.payments && o.payments.length) ? o.payments : (o.payment ? [{ method: o.payment.method, status: o.payment.status, amount: o.total }] : []);
    for (const p of pmts) {
      const m = byMethod[p.method] ? p.method : 'card';
      if (p.status === 'paid') { byMethod[m].received += p.amount; byMethod[m].count++; }
      else if (p.status === 'awaiting_verification' || p.status === 'pending') byMethod[m].pending += p.amount;
      else if (p.status === 'refunded') byMethod[m].refunded += p.amount;
    }
    if (ref > 0) {
      const rm = (o.refunds && o.refunds[0] && o.refunds[0].method) || o.payment.method;
      if (byMethod[rm]) byMethod[rm].refunded += 0; // already tracked via refunds array
    }
  }
  // cancelled financial impact: what was paid then refunded on cancelled orders
  let cancelledImpact = 0;
  for (const o of cancelled) cancelledImpact += refundedTotal(o) || paidTotal(o);

  // ---- item-wise (transactional prices) ----
  const itemMap = {};
  for (const o of active) {
    const oPaidRatio = o.total > 0 ? Math.min(1, (o.total - refundedTotal(o)) / o.total) : 1;
    for (const it of o.items) {
      const key = it.menuId + '|' + it.portion;
      if (!itemMap[key]) itemMap[key] = { menuId: it.menuId, name: it.name, portion: it.portion, category: it.category || '', qty: 0, gross: 0, net: 0, refundedQty: 0, refundedAmt: 0 };
      const g = it.price * it.qty;
      itemMap[key].qty += it.qty;
      itemMap[key].gross += g;
      itemMap[key].net += g * oPaidRatio;
    }
  }
  let items = Object.values(itemMap);
  const totalNet = items.reduce((s, i) => s + i.net, 0) || 1;
  items.forEach(i => { i.pct = +(i.net / totalNet * 100).toFixed(2); });
  items.sort((a, b) => b.qty - a.qty);
  const byQty = items.slice().sort((a, b) => b.qty - a.qty);
  const byRevenue = items.slice().sort((a, b) => b.net - a.net);

  // previous period items for declining comparison
  const prevItemMap = {};
  for (const o of inPrev.filter(o => o.kitchenStatus !== 'cancelled')) {
    for (const it of o.items) {
      const key = it.menuId + '|' + it.portion;
      prevItemMap[key] = (prevItemMap[key] || 0) + it.qty;
    }
  }
  const declining = items.filter(i => {
    const prev = prevItemMap[i.menuId + '|' + i.portion] || 0;
    return prev > 0 && i.qty < prev * 0.7;
  }).map(i => ({ name: i.name, portion: i.portion, qty: i.qty, prevQty: prevItemMap[i.menuId + '|' + i.portion] }));

  // zero-sales items that ARE in stock (vs 86'd)
  const soldIds = new Set(items.map(i => i.menuId));
  const zeroSales = (db.dishes || []).filter(d => d.inStock && !soldIds.has(d.id)).map(d => ({ name: d.name, category: d.cat }));

  // categories
  const catMap = {};
  for (const i of items) {
    const dish = (db.dishes || []).find(d => d.id === i.menuId);
    const c = dish ? dish.cat : 'Other';
    catMap[c] = catMap[c] || { name: c, qty: 0, net: 0 };
    catMap[c].qty += i.qty; catMap[c].net += i.net;
  }
  const categories = Object.values(catMap).sort((a, b) => b.net - a.net);

  // ---- hourly ----
  const hourly = [];
  for (let h = 0; h < 24; h++) hourly.push({ hour: h, sales: 0, orders: 0 });
  for (const o of active) {
    const d = new Date(o.createdAt + (db.settings.tzOffsetMinutes || 330) * 60000);
    const h = d.getUTCHours();
    hourly[h].sales += o.total; hourly[h].orders++;
  }

  // ---- channels ----
  const channels = { dinein: { orders: 0, sales: 0 }, qr: { orders: 0, sales: 0 }, pickup: { orders: 0, sales: 0 }, delivery: { orders: 0, sales: 0 } };
  for (const o of active) {
    let ch = o.type;
    if (o.type === 'dinein' && o.createdBy && String(o.createdBy).startsWith('customer')) ch = 'qr';
    else if (o.type === 'dinein') ch = 'dinein';
    channels[ch].orders++; channels[ch].sales += o.total;
  }

  // ---- payment reconciliation ----
  const reconciliation = { byMethod, totalReceived: paymentsReceived, awaitingVerification: awaitingUpi, outstanding, refunds, cancelledImpact };

  // cash movements
  const movements = (db.cashMovements || []).filter(m => inRange(m.at, from, to));
  let cashIn = byMethod.cash.received, cashRefunds = byMethod.cash.refunded;
  let withdrawals = movements.filter(m => m.type === 'withdrawal').reduce((s, m) => s + m.amount, 0);
  let expenses = movements.filter(m => m.type === 'expense').reduce((s, m) => s + m.amount, 0);
  let deposits = movements.filter(m => m.type === 'deposit').reduce((s, m) => s + m.amount, 0);
  const opening = (db.settings.openingFloat || 0);
  const expectedCash = opening + cashIn - cashRefunds + deposits - withdrawals - expenses;
  const closing = (db.dayCloses || []).find(c => c.businessDate === new Date(from + (db.settings.tzOffsetMinutes || 330) * 60000).toISOString().slice(0, 10));

  // operational
  const completedOrders = active.filter(o => o.kitchenStatus === 'completed').length;
  const awaitingConfirm = active.filter(o => o.confirmation && o.confirmation.status === 'pending_confirmation').length;
  const awaitingKitchen = active.filter(o => ['received', 'in_progress'].includes(o.kitchenStatus)).length;
  const deliveryDone = active.filter(o => o.type === 'delivery' && o.fulfillmentStatus === 'delivered').length;
  const refundList = [];
  for (const o of active) if (o.refunds) for (const r of o.refunds) refundList.push(Object.assign({ orderId: o.id }, r));

  const prevGross = inPrev.filter(o => o.kitchenStatus !== 'cancelled').reduce((s, o) => s + o.total, 0);
  const netSales = grossSales - discounts - refunds;
  const aov = active.length ? Math.round(netSales / active.length) : 0;

  return {
    from, to,
    summary: {
      orderCount: inP.length,
      activeCount: active.length,
      completedOrders,
      cancelledOrders: cancelled.length,
      cancelledImpact,
      grossSales, discounts, refunds, netSales,
      paymentsReceived, outstanding, awaitingUpi,
      taxes, deliveryCharges, aov,
      prevGross, growthPct: prevGross > 0 ? +((netSales - prevGross) / prevGross * 100).toFixed(1) : null
    },
    items, byQty, byRevenue, declining, zeroSales, categories,
    bestseller: byQty[0] || null, topRevenue: byRevenue[0] || null, topCategory: categories[0] || null,
    top5: byQty.slice(0, 5), top10: byQty.slice(0, 10),
    hourly,
    channels,
    reconciliation,
    cash: { opening, in: cashIn, refunds: cashRefunds, deposits, withdrawals, expenses, expected: expectedCash, counted: closing ? closing.countedCash : null, variance: closing ? closing.variance : null, closedBy: closing ? closing.closedBy : null },
    refundsList: refundList,
    operational: {
      awaitingConfirm, awaitingKitchen, completedOrders, deliveryDone,
      cancelledOrders: cancelled.length, refundCount: refundList.length, refundTotal: refunds
    },
    recentOrders: active.slice(0, 20).map(o => ({ id: o.id, type: o.type, total: o.total, paid: paidTotal(o), method: o.payment.method, status: o.payment.status, kitchen: o.kitchenStatus, at: o.createdAt }))
  };
}

/* Markdown rendering of a finance report */
function toMarkdown(f, settings, title) {
  const m = settings.currency || '₹';
  const M = n => m + Number(n || 0).toLocaleString('en-IN');
  const dt = ts => new Date(ts + (settings.tzOffsetMinutes || 330) * 60000).toISOString().slice(0, 16).replace('T', ' ');
  const L = [];
  L.push('# ' + (settings.name || "KARIM'S") + ' — ' + (title || 'Financial Report'));
  L.push('');
  L.push('**Period:** ' + dt(f.from) + ' to ' + dt(f.to) + ' (' + (settings.timezone || 'Asia/Kolkata') + ')');
  L.push('**Generated:** ' + dt(Date.now()));
  L.push('');
  L.push('## A. Executive Summary');
  L.push('| Metric | Value |');
  L.push('|---|---|');
  const s = f.summary;
  L.push('| Total orders | ' + s.orderCount + ' |');
  L.push('| Completed orders | ' + s.completedOrders + ' |');
  L.push('| Cancelled orders | ' + s.cancelledOrders + ' (impact ' + M(s.cancelledImpact) + ') |');
  L.push('| Gross sales | ' + M(s.grossSales) + ' |');
  L.push('| Discounts | ' + M(s.discounts) + ' |');
  L.push('| Refunds | ' + M(s.refunds) + ' |');
  L.push('| Net sales | ' + M(s.netSales) + ' |');
  L.push('| Payments received | ' + M(s.paymentsReceived) + ' |');
  L.push('| Outstanding | ' + M(s.outstanding) + ' |');
  L.push('| Awaiting UPI verification | ' + M(s.awaitingUpi) + ' |');
  L.push('| Taxes collected | ' + M(s.taxes) + ' |');
  L.push('| Delivery charges | ' + M(s.deliveryCharges) + ' |');
  L.push('| Average order value | ' + M(s.aov) + ' |');
  if (s.growthPct != null) L.push('| Growth vs previous period | ' + s.growthPct + '% |');
  L.push('');
  L.push('## B. Item-wise Sales (by quantity)');
  L.push('| # | Item | Portion | Qty | Net sales | % |');
  L.push('|---|---|---|---|---|---|');
  f.byQty.forEach((i, n) => L.push('| ' + (n + 1) + ' | ' + i.name + ' | ' + i.portion + ' | ' + i.qty + ' | ' + M(i.net) + ' | ' + i.pct + '% |'));
  L.push('');
  L.push('## C. Bestsellers');
  L.push('- **#1 by quantity:** ' + (f.bestseller ? f.bestseller.name + ' (' + f.bestseller.portion + ') × ' + f.bestseller.qty : 'No sales'));
  L.push('- **#1 by revenue:** ' + (f.topRevenue ? f.topRevenue.name + ' — ' + M(f.topRevenue.net) : 'No sales'));
  L.push('- **Bestselling category:** ' + (f.topCategory ? f.topCategory.name : '—'));
  L.push('');
  L.push('## D. Payment Reconciliation');
  L.push('| Method | Received | Pending | Refunded |');
  L.push('|---|---|---|---|');
  for (const k of ['cash', 'upi', 'card']) {
    const r = f.reconciliation.byMethod[k];
    L.push('| ' + k.toUpperCase() + ' | ' + M(r.received) + ' | ' + M(r.pending) + ' | ' + M(r.refunded) + ' |');
  }
  L.push('| **Total** | **' + M(f.reconciliation.totalReceived) + '** | **' + M(f.reconciliation.awaitingVerification) + '** | **' + M(f.reconciliation.refunds) + '** |');
  L.push('');
  L.push('### Cash drawer');
  L.push('- Opening float: ' + M(f.cash.opening));
  L.push('- Cash received: ' + M(f.cash.in));
  L.push('- Withdrawals: ' + M(f.cash.withdrawals) + ' · Expenses: ' + M(f.cash.expenses) + ' · Deposits: ' + M(f.cash.deposits));
  L.push('- **Expected cash: ' + M(f.cash.expected) + '**');
  L.push('- Counted cash: ' + (f.cash.counted != null ? M(f.cash.counted) : 'not counted'));
  if (f.cash.variance != null) L.push('- Variance: ' + M(f.cash.variance));
  L.push('');
  L.push('## E. Order Channels');
  L.push('| Channel | Orders | Sales |');
  L.push('|---|---|---|');
  for (const [k, v] of Object.entries(f.channels)) L.push('| ' + k + ' | ' + v.orders + ' | ' + M(v.sales) + ' |');
  L.push('');
  L.push('## F. Operational Summary');
  L.push('- Awaiting confirmation: ' + f.operational.awaitingConfirm);
  L.push('- In kitchen: ' + f.operational.awaitingKitchen);
  L.push('- Completed: ' + f.operational.completedOrders + ' · Delivery done: ' + f.operational.deliveryDone);
  L.push('- Cancelled: ' + f.operational.cancelledOrders + ' · Refunds: ' + f.operational.refundCount + ' (' + M(f.operational.refundTotal) + ')');
  L.push('');
  L.push('_Report generated by ' + (settings.name || "KARIM'S") + ' Restaurant Platform._');
  return L.join('\n');
}

/* CSV exports */
function itemsCsv(f) {
  const rows = [['Item', 'MenuId', 'Portion', 'Quantity', 'NetSalesINR', 'PctOfSales']];
  f.byQty.forEach(i => rows.push([i.name, i.menuId, i.portion, i.qty, i.net.toFixed(2), i.pct]));
  return rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
}
function ordersCsv(f, maskCustomer) {
  const rows = [['OrderId', 'Type', 'TotalINR', 'PaidINR', 'Method', 'PaymentStatus', 'KitchenStatus', 'CreatedAt']];
  f.recentOrders.forEach(o => rows.push([o.id, o.type, o.total, o.paid, o.method, o.status, o.kitchen, new Date(o.at).toISOString()]));
  return rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
}

module.exports = { computeFinance, periodBounds, bizDayBounds, toMarkdown, itemsCsv, ordersCsv, paidTotal, refundedTotal, pendingVerificationTotal };
