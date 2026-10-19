# MASTER AI DEVELOPER PROMPT — KARIM'S RESTAURANT OS v2.0
## (QR Ordering + POS + 3-Stage KDS + Manager Desk + Delivery Driver App + Admin)
### LAN-FIRST • REAL-TIME SYNC • REAL FOOD IMAGERY • FULL ADMIN CONTROL

---

> **Instructions for the AI**: You are an expert Principal Full-Stack Software Architect. Build a complete, production-grade restaurant operating system for **Karim's Imphal** (Royal Mughlai Cuisine, Estd 1913), themed in royal maroon (#4A080F, #6B0F1A, #8A1420) and Mughal gold (#D4AF37, #F3E5AB, #AA820A) on parchment cream (#FAF7F2). Every component, state transition, and workflow below must be fully functional — zero TODOs, zero placeholder text, zero "demo" or "AI-generated" labels anywhere in the UI or on images. The system must look and operate like a real commercial product a client would deploy tomorrow.

---

## 1. CRITICAL ARCHITECTURE: LOCAL-FIRST, INTERNET AS BACKUP

The restaurant will run on a **local Wi-Fi network as the PRIMARY infrastructure**. Internet is only needed for UPI/GPay payment verification.

**You MUST build a lightweight local server:**

1. **Stack**: Node.js + Express + Socket.IO (or plain WebSocket) + a single JSON/SQLite file for persistence. Serve all front-ends from this one server process.
2. **Bind to `0.0.0.0`** so every device on the restaurant Wi-Fi can connect via the server machine's LAN IP (e.g. `http://192.168.1.10:3000`).
3. **Every device connects to the same server** — this is how real-time sync works across tablets, phones, and terminals:
   - Manager POS terminal (touch screen / laptop)
   - Kitchen Display tablets (mounted in kitchen)
   - Manager's second monitor (KDS mirror / food progress)
   - Delivery riders' phones (on the same Wi-Fi at the restaurant, or on mobile data via a tunnel/port-forward when outside)
   - Customers' own phones scanning QR codes (on the same Wi-Fi — e.g. guest Wi-Fi — or via internet if exposed)
4. **Real-time events via Socket.IO rooms/channels**: `orders:new`, `orders:payment-confirmed`, `orders:kds-stage`, `orders:assigned-driver`, `orders:delivered`, `menu:updated`. All connected clients receive updates instantly (<100ms on LAN).
5. **Persistence**: All menu items, orders, drivers, payment settings, and uploaded images stored server-side in a single `data.json` (or SQLite file). Restart-safe. Provide a one-click "Export Backup" and "Import Backup" in Admin.
6. **Graceful degradation**: If the internet drops, ordering, kitchen, POS, and cash payments continue to work fully offline. Only UPI QR display/verification is affected.
7. Provide a `start.bat` (Windows) that installs dependencies (`npm install`) and launches the server, printing the local URLs to the console:
   - `http://192.168.x.x:3000/` — Customer QR ordering
   - `http://192.168.x.x:3000/pos` — Point of Sale
   - `http://192.168.x.x:3000/kds` — Kitchen Display System
   - `http://192.168.x.x:3000/manager` — Manager Desk (dual-display)
   - `http://192.168.x.x:3000/delivery` — Delivery Driver App
   - `http://192.168.x.x:3000/admin` — Admin Panel
8. **After building, ALWAYS print these links in your final response** so the client can open them immediately, including the direct Admin link.

---

## 2. REALISTIC FOOD IMAGERY — MANDATORY

The current site uses emoji+gradient placeholders. This is unacceptable for client presentation. Replace with **real, appetizing food photography for every single one of the 118+ menu items**.

**Rules for images:**

1. **Every dish card MUST show a real photograph** of the dish — top-down or 45° angle restaurant-style food photography, warm lighting, matching the actual dish (e.g. Butter Chicken shows butter chicken, not a generic curry).
2. **Source images using free, commercially-usable stock photo APIs/CDNs** with per-dish search queries:
   - Prefer: Unsplash direct image URLs (`https://images.unsplash.com/photo-...` with `?w=800&q=80` params) found via their public search, Pexels, or the Foodish API (`https://foodish-api.com/` — returns random Indian food images by category: biryani, curry, tandoori, dessert, etc.).
   - Curate a hardcoded mapping in the source: dish name → direct image URL. Example: `{ "Butter Chicken": "https://images.unsplash.com/photo-xxxx?w=800&q=80", "Mutton Biryani": "https://images.unsplash.com/photo-yyyy?w=800&q=80", ... }`
   - For items where no perfect match exists, use the closest appetizing Indian/Mughlai food photo of the same type (e.g. any premium kebab photo for a specific kebab). The client will replace them via admin if desired — but the default must look REAL and delicious.
3. **NEVER put any text, watermark, label, badge, or overlay on images that says "demo", "placeholder", "AI", "AI-generated", "sample", "stock", or similar.** Images must look like the restaurant's own photography.
4. **Image treatment in UI**: All dish card images rendered with `object-fit: cover`, consistent height (h-44 to h-52), slight dark gradient overlay only if needed for badge legibility, rounded top corners. Cards keep the maroon/gold theme with veg 🟢 / non-veg 🔴 indicator, badge (⭐ Bestseller / 👑 Chef's Special), half/full pricing.
5. **Lazy loading**: `loading="lazy"` on all images. Show a subtle shimmer skeleton while loading.
6. **Admin image uploader** (see Section 6): Admin can replace ANY dish image with a photo from their device. Uploaded image stored server-side in `/uploads/` folder (multer or similar), path saved in menu JSON. Also allow pasting an image URL.
7. **Hero banner**: Use a rich, dark, moody Mughlai spread photograph (kebabs, biryani pot, tandoor) as the hero background with maroon overlay — not a flat gradient.
8. **Category strip / heritage page**: Include 2–3 authentic restaurant/food photos (tandoor flames, copper handi, royal thali) to make the site feel premium.

---

## 3. ORDER TYPES & CUSTOMER FLOW (QR SYSTEM)

The QR ordering system must support **three service modes** chosen by the customer on landing:

1. **🍽️ Dine-In** — customer selects table (1–12) from QR standee or picker; order goes to kitchen for table service.
2. **🥡 Pickup (Takeaway)** — customer enters name + phone; picks up from counter. No delivery.
3. **🛵 Delivery** — customer enters name, phone, full address, and landmark; order is assigned to a delivery rider. (If outside delivery zone — configurable pin/area in Admin — show a polite "We don't deliver to this area yet" message.)

**Customer flow:**
Scan QR (table QR, or a general counter/poster QR for pickup/delivery) → choose mode → browse full 118-item menu with real photos, search, veg/non-veg filter, category filter, Half/Full portion, spice level (mild/medium/hot), butter preference (regular/extra/low), item notes → cart → checkout:
- **Payment choice**: (a) UPI/GPay — show the restaurant's configured UPI QR + amount + "I have paid" button, or (b) Cash at counter / Pay on delivery.
- **Special instructions** field.
- Submit → order enters **"Awaiting Payment Confirmation"** state. Customer sees a live tracker page (polling/socket): Order Placed → Payment Confirmed → Cooking (with stage) → Out for Delivery / Ready for Pickup → Completed.
- For delivery orders, after completion, customer tracker shows rider name + live status.

**Table QR standees** (Admin): Print-ready standees for Tables 1–12 pointing to `http://<server-ip>:3000/?table=N`. Also generate **standalone QR posters** for counter/window pointing to `http://<server-ip>:3000/` (pickup/delivery). High-contrast, print button.

---

## 4. POINT OF SALE (POS) — PAYMENT GATEWAY + ORDER INTAKE

**Location**: `/pos` — touch-friendly, large buttons, works on a tablet or laptop at the counter.

**Responsibilities — the POS is the FINANCIAL GATEKEEPER. NO order reaches the kitchen without POS payment confirmation:**

1. **Incoming Order Queue**: All new orders (dine-in, pickup, delivery) appear instantly (Socket.IO) with sound chime (Web Audio API, 587.33Hz→880Hz). Each shows: Order ID, type, table/address, items, total, payment method (UPI/Cash).
2. **Payment Confirmation Workflow (CRITICAL)**:
   - **UPI orders**: Customer taps "I have paid". Order shows "UPI payment claimed — VERIFY in GPay/PhonePe". The POS operator checks their UPI app, then presses **"✓ Payment Received / Confirmed"**. Only then the order status becomes **"Payment Confirmed"** and dispatches to KDS.
   - **Cash orders**: Order shows "Cash pending". When the sales manager physically collects cash, they press **"💵 Cash Received — Confirm"**. Confirmation triggers: status → "Payment Confirmed", a toast/notification **"Payment Received — ₹X (Cash/UPI) — Order KRM-XXXX"** appears on POS + Manager screens, and the order instantly appears in the Kitchen Display.
   - **Reject/Cancel** button with reason (wrong order, customer changed mind, UPI failed) — voids the order, removes from all queues, logs it.
3. **Manual order entry**: Staff can also create walk-in orders directly in POS (add items, choose payment, confirm) for customers without phones.
4. **Print receipt**: 80mm thermal-printer-ready receipt (`@media print`) — Karim's crest, GST breakdown, table/address, order time, slogan *"Secret of Good Mood • Taste of Karim's Food"*.
5. **End-of-day summary**: Today's cash total, UPI total, order count, AOV, per-category sales. Printable.

---

## 5. KITCHEN DISPLAY SYSTEM (KDS) — 3-STAGE PIPELINE

**Location**: `/kds` — dark high-contrast theme (`bg-stone-900`), kitchen-tablet optimized, large touch targets.

**Strict 3-stage linear pipeline (left → right columns):**

1. **📥 RECEIVED (New)** — orders that passed POS payment confirmation. Ticket shows: Order ID, type badge (Dine-In T4 / Pickup / Delivery), elapsed timer, items with per-item checkboxes (chef strikes off as prepped), spice levels, notes. Button: **"Start Cooking →"** moves to Progress.
2. **🔥 PROGRESS (Cooking)** — active tickets. Same item checkboxes. Button: **"✓ Mark Completed"** moves to Completed.
3. **✅ COMPLETED (Ready)** — plated/ready. For **Dine-In**: button **"🏃 Send to Table / Runner"** (marks served). For **Pickup**: button **"📦 Ready for Pickup"** (notifies POS + customer tracker). For **Delivery**: button **"🛵 Ready — Assign Rider"** (order moves to Delivery pool).

**Real-time & urgency:**
- All stage changes broadcast instantly via Socket.IO to: KDS screens, Manager Desk Display 2 (kitchen mirror / food progress tracker), POS, customer tracker, Delivery app.
- **Elapsed timer color coding**: <8 min neutral stone, 8–15 min amber, >15 min red pulsing border + "URGENT" badge.
- Web Audio chime on new ticket arrival.
- Order **cannot skip stages** — buttons enforce linear flow.

---

## 6. MANAGER DESK — DUAL DISPLAY

**Location**: `/manager` — Flip toggle between Display 1 and Display 2, plus "🖥️ Pop Out Display 2" (`window.open`) for a second physical monitor.

**Display 1 — Finance & Floor:**
- KPI ribbon: Today's Gross, Cash in Register, UPI Settlements, Active Tables (x/12), AOV, order count.
- **Payment Confirmed notifications feed** (toast + persistent list): "Payment Received — ₹1,240 (Cash) — Table 4 — KRM-1042".
- Table floor map 1–12: Green=Vacant, Amber=Dining, Red=Bill Due/Ready. Click → running ledger, item breakdown, **Settle Bill** (Cash/UPI/Card) → marks table vacant + prints receipt.
- Pending exceptions: rejected orders log, cancelled orders log.

**Display 2 — Kitchen Mirror & Food Progress (REAL-TIME):**
- Mirrors the exact KDS 3-stage state, updated via Socket.IO the instant a chef taps any button.
- **Food Progress Tracker view**: every active order as a horizontal progress bar: Placed → Paid → Received → Cooking → Ready → Served/Delivered, with timestamps and live timers.
- **Runner alerts**: pulsing banner when a dine-in ticket is Completed: "🏃 Runner → Table 7".
- **Delivery board**: active delivery orders with assigned rider, status (Assigned → Picked Up → En Route → Delivered), ETA countdown.

---

## 7. DELIVERY DRIVER APP

**Location**: `/delivery` — mobile-first PWA-style page. Drivers open it on their phones (same Wi-Fi at base, or mobile data if server is reachable).

**Features:**
1. **Login**: Simple driver PIN or select-your-name from driver roster (roster managed in Admin). One tap to go **Online/Offline** for shift.
2. **Available Deliveries pool**: Orders marked "Ready — Assign Rider" appear for any online driver to claim (first-come; once claimed, hidden from others).
3. **My Active Delivery**: Claimed order shows customer name, phone (tap-to-call via `tel:`), full address, map link (Google Maps directions button), order items, amount to collect (for Cash-on-Delivery: "Collect ₹X in cash"), payment already done (UPI) badge.
4. **Status buttons** (each broadcasts in real-time to Manager Display 2 + customer tracker):
   - **🛵 Picked Up** → **📍 Out for Delivery** → **✅ Delivered** (for COD: confirm cash collected).
   - Issue button: "Customer unreachable", "Wrong address", "Return to restaurant" — flags order back to POS/Manager.
5. **Delivery history** for the shift + total COD cash held (accountability).
6. **Admin** manages: driver names, PINs, active/inactive.

---

## 8. ADMIN PANEL — FULL CONTROL

**Location**: `/admin` — password protected (master password `admin@135`, session-based, changeable in Admin settings).

**Tabs:**

### A. 📋 Menu Management
- Table of all dishes with **inline editing** (no modal needed for quick edits): dish name, description, Half price, Full price, category, Veg/Non-Veg toggle, In-Stock toggle, badge (Bestseller/Chef's Special/New/Spicy/None).
- **Image column per dish**: thumbnail preview + **📷 Upload button** (file picker → saved to `/uploads/` on server) + **"Paste URL"** option + "Remove image (use category default)".
- Category filter + search. "+ New Dish" modal (all fields + image upload). Delete dish. "Restore Original 118" button.
- Drag-to-reorder optional; at minimum, sort by category + name.
- Changes propagate INSTANTLY to all customer menus via Socket.IO `menu:updated` — no refresh needed on open tablets.

### B. 💰 Payment / UPI Settings
- **Merchant UPI ID** field (e.g. `karims.imphal@upi`) — used to auto-generate the customer UPI QR (UPI deep-link: `upi://pay?pa=<id>&pn=Karim's&am=<amount>&cu=INR&tn=<orderid>`).
- **Custom UPI QR image upload**: if the restaurant has a printed GPay/PhonePe QR, admin can upload that image; customer checkout then shows the uploaded QR instead of the generated one.
- **Payment modes toggle**: Enable/disable UPI, Cash, Card-at-counter, Pay-on-delivery.
- Delivery fee setting (flat ₹ or free above ₹X) + delivery zone note.

### C. 📱 QR Standee Generator
- Generate print-ready standees: 12 table QRs (`?table=N&mode=dinein`) + counter/poster QR (`?mode=pickup` / `?mode=delivery` chooser). 1-click Print All. Royal maroon/gold design with crest + instructions.

### D. 🛵 Delivery & Drivers
- Add/edit/remove drivers (name, phone, PIN, active). View today's deliveries per driver + COD accountability.

### E. ⚙️ Settings
- Restaurant name, tagline, address, phone, GSTIN (shown on receipts).
- Change master staff password. Table count (default 12).
- Data: Export backup JSON / Import backup / Reset menu to original 118.

---

## 9. AUTHENTICATION & SECURITY

- Staff routes (`/pos`, `/kds`, `/manager`, `/admin`, `/delivery`) protected by staff login (modal or route guard). Master password: `admin@135` (changeable in Admin → Settings). Session via HTTP-only cookie or JWT stored client-side.
- **Secret trigger preserved**: 5-second long-press on the © symbol in the customer footer opens the staff login dialog.
- Direct hash/URL access to staff pages summons login if not authenticated.
- Customer ordering pages are public (no login).
- Delivery drivers: PIN login (lighter than master password).

---

## 10. FULL 118-ITEM KARIM'S MENU (PRELOADED WITH REAL IMAGES)

Preload the complete authentic menu across 9 categories (20 Tandoor, 25 Shahi Dastarkhwan, 10 Biryani, 8 Rolls, 12 Roti & Naan, 6 Rice, 12 Sides, 10 Desserts, 15 Drinks = 118+). Every item MUST have: name, description, half/full INR pricing, veg flag, and a **real food photograph URL** per Section 2. Original Karim's signature items included: Tandoori Chicken Burra, Mutton Galouti Kebab, Butter Chicken, Mutton Nihari, Murgh Mussallam, Special Raan Biryani, Karim Roll, Khamiri Roti, Kesar Phirni, Thick Sweet Lassi, etc.

---

## 11. TECHNICAL STACK SUMMARY

| Layer | Choice |
|---|---|
| Server | Node.js + Express + Socket.IO, bind `0.0.0.0:3000` |
| Persistence | Single `data.json` (or SQLite) + `/uploads/` for images; export/import backup |
| Front-end | Semantic HTML5 + Tailwind CSS (CDN or compiled) + vanilla JS or light framework; all pages served by the same Node server |
| Real-time | Socket.IO rooms for orders, KDS stages, menu updates, delivery status |
| QR | QRCode.js (client) for standees + UPI |
| Audio | Web Audio API chimes (new order, payment confirmed, KDS stage change, delivery alert) |
| Images | Curated real stock-photo URLs per dish (no watermarks) + server-side upload override |
| Deployment | `start.bat`: `npm install && node server.js` — prints all LAN URLs |
| PWA-light | Customer ordering page + Delivery app installable as home-screen apps (manifest + service worker for offline menu cache) |

---

## 12. DELIVERABLES — WHAT THE AI MUST PRODUCE

1. Complete project folder: `server.js`, `package.json`, `/public/` (all HTML/CSS/JS pages), `/uploads/`, `/data/`, `start.bat`, `README.md` with setup + LAN configuration instructions.
2. **All six working surfaces**: Customer QR ordering, POS, KDS, Manager dual-display, Delivery app, Admin.
3. **Real food images on every menu item** — no emoji placeholders on dish cards, no demo/AI labels.
4. **Full payment-confirmation workflow**: POS "Cash Received"/"UPI Verified" button → notification → order auto-dispatches to KDS → 3-stage pipeline → real-time reflection on Manager food-progress display.
5. **LAN-first**: everything works with internet unplugged except UPI app verification.
6. **In your final response, list every URL** (customer, POS, KDS, manager, delivery, admin) using the machine's LAN IP so the client can open each panel immediately and demo the full flow.

---

## 13. DEMO SCRIPT THE AI SHOULD BE ABLE TO WALK THROUGH

1. Client scans table QR (or opens customer link) → sees real-photo menu → orders Butter Chicken (Full, extra butter) + Mutton Biryani → pays via UPI QR → tracker shows "Awaiting Payment Confirmation".
2. POS screen chimes; operator verifies UPI in phone app → presses **"Payment Received"** → green toast "Payment Received — ₹1,739 (UPI)" on POS + Manager; order instantly appears in KDS column 1.
3. Chef taps "Start Cooking" → column 2; Manager Display 2 progress bar updates live; timer turns amber at 8 min.
4. Chef taps "Mark Completed" → column 3; Manager sees pulsing "🏃 Runner → Table 4" alert; customer tracker shows "Ready".
5. Runner serves → "Served"; Manager taps table → Settle (already paid) → receipt printed → table turns green.
6. Repeat for a **Cash delivery order**: POS presses "Cash Received" → KDS → rider claims in Delivery app → Picked Up → Out for Delivered (COD collected) → Manager delivery board shows green Delivered.
7. Admin: change Butter Chicken price, replace its photo from phone camera, add a new dish "Karim's Special Thali ₹999" — menu updates live on the customer phone with no refresh.

---

*Build this exactly as specified. It must be client-ready: premium visuals, real images, flawless sync on local Wi-Fi, and a payment-gated kitchen pipeline that cannot be bypassed.*
