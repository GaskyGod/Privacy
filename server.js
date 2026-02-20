const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');

function initFirebase() {
  if (admin.apps.length) return;

  const fromEnv = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (fromEnv) {
    let parsed;
    try {
      parsed = JSON.parse(fromEnv);
    } catch {
      parsed = JSON.parse(Buffer.from(fromEnv, 'base64').toString('utf8'));
    }
    admin.initializeApp({ credential: admin.credential.cert(parsed) });
    return;
  }

  admin.initializeApp();
}
initFirebase();
const db = admin.firestore();

const app = express();
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf?.toString('utf8') || '';
  }
}));

const PLAN_DAYS = { '1m': 30, '6m': 180, '12m': 365 };
const PLAN_ENV = { '1m': 'PRICE_1M_USD', '6m': 'PRICE_6M_USD', '12m': 'PRICE_12M_USD' };
const PAYPAL_MODE = String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
const PAYPAL_API_BASE = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = String(process.env.PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_CLIENT_SECRET = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
const PAYPAL_WEBHOOK_ID = String(process.env.PAYPAL_WEBHOOK_ID || '').trim();
const RENEWAL_PROXY_KEY = String(process.env.RENEWAL_PROXY_KEY || '').trim();
const APP_DOWNLOAD_URL = String(process.env.APP_DOWNLOAD_URL || '').trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const WEB_BUY_ALLOWED_ORIGINS = String(process.env.WEB_BUY_ALLOWED_ORIGINS || '*').trim();

function normalizeTikTokUsername(input) {
  const raw = String(input || '').trim();
  const withoutAt = raw.startsWith('@') ? raw.slice(1) : raw;
  const normalized = withoutAt.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 32) {
    return { ok: false, reason: 'username invalido: longitud 3..32' };
  }
  if (!/^[a-z0-9._]+$/.test(normalized)) {
    return { ok: false, reason: 'username invalido: solo letras, numeros, punto y guion bajo' };
  }
  return { ok: true, value: normalized };
}

function sanitizeEmail(input) {
  const email = String(input || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'email invalido' };
  return { ok: true, value: email };
}

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (WEB_BUY_ALLOWED_ORIGINS === '*') return true;
  const allowed = WEB_BUY_ALLOWED_ORIGINS
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function applyCors(req, res) {
  const origin = String(req.headers?.origin || '').trim();
  if (WEB_BUY_ALLOWED_ORIGINS === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-renewal-key');
}

app.use((req, res, next) => {
  if (
    req.path === '/purchase/create-order' ||
    req.path === '/purchase/order-status' ||
    req.path === '/health'
  ) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
});

function planAmount(planId) {
  const priceEnvKey = PLAN_ENV[planId];
  const amount = Number(String(process.env[priceEnvKey] || '').trim());
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: `Precio invalido para ${priceEnvKey}` };
  }
  return { ok: true, amount, priceEnvKey };
}

function getExpiresAtMs(licenseData) {
  const raw = licenseData?.expiresAt;
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.getTime();
  if (typeof raw?.toDate === 'function') {
    try {
      const d = raw.toDate();
      if (d instanceof Date && Number.isFinite(d.getTime())) return d.getTime();
    } catch {}
  }
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const p = Date.parse(raw);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

function requireProxyKey(req, res) {
  if (!RENEWAL_PROXY_KEY) return true;
  const incoming = String(req.headers['x-renewal-key'] || '').trim();
  if (incoming && incoming === RENEWAL_PROXY_KEY) return true;
  res.status(401).json({ ok: false, reason: 'Unauthorized' });
  return false;
}

async function paypalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_CREDENTIALS_MISSING');
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const js = await r.json().catch(() => ({}));
  if (!r.ok || !js?.access_token) throw new Error(`PAYPAL_AUTH_FAILED:${js?.error || r.status}`);
  return js.access_token;
}

function parseOrderApproveUrl(order) {
  const links = Array.isArray(order?.links) ? order.links : [];
  const approve = links.find((x) => x.rel === 'approve');
  return approve?.href || null;
}

async function capturePaypalOrder(orderId, token) {
  const captureResp = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `cap_${orderId}`
    },
    body: '{}'
  });
  const captureJson = await captureResp.json().catch(() => ({}));
  if (captureResp.ok) return { ok: true, data: captureJson };

  const issue = String(captureJson?.details?.[0]?.issue || '').toUpperCase();
  if (issue === 'ORDER_ALREADY_CAPTURED') return { ok: true, alreadyCaptured: true, data: captureJson };
  return { ok: false, data: captureJson, status: captureResp.status };
}

async function completeRenewalByOrderId(orderId) {
  const q = await db.collection('licenseRenewals').where('orderId', '==', orderId).limit(1).get();
  if (q.empty) return { ok: false, code: 404, reason: 'Renewal no encontrada para orderId' };
  const renewalRef = q.docs[0].ref;

  await db.runTransaction(async (tx) => {
    const renewalSnap = await tx.get(renewalRef);
    if (!renewalSnap.exists) throw new Error('RENEWAL_NOT_FOUND');
    const renewal = renewalSnap.data() || {};
    if (String(renewal.status || '').toUpperCase() === 'COMPLETED') return;

    const licenseKey = String(renewal.licenseKey || '').trim();
    const days = Math.max(0, Number(renewal.days || 0));
    if (!licenseKey || !days) throw new Error('RENEWAL_INVALID');

    const licenseRef = db.collection('licenses').doc(licenseKey);
    const licenseSnap = await tx.get(licenseRef);
    if (!licenseSnap.exists) throw new Error('LICENSE_NOT_FOUND');
    const license = licenseSnap.data() || {};

    const nowMs = Date.now();
    const baseMs = Math.max(nowMs, getExpiresAtMs(license) || 0);
    const newExpiresAt = baseMs + (days * 86_400_000);

    tx.update(licenseRef, {
      expiresAt: admin.firestore.Timestamp.fromMillis(newExpiresAt),
      lastSeen: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.update(renewalRef, {
      status: 'COMPLETED',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      daysAdded: days,
      newExpiresAt
    });
  });

  return { ok: true };
}

async function completePurchaseByOrderId(orderId) {
  const q = await db.collection('licensePurchases').where('orderId', '==', orderId).limit(1).get();
  if (q.empty) return { ok: false, code: 404, reason: 'Compra no encontrada para orderId' };
  const purchaseRef = q.docs[0].ref;

  await db.runTransaction(async (tx) => {
    const purchaseSnap = await tx.get(purchaseRef);
    if (!purchaseSnap.exists) throw new Error('PURCHASE_NOT_FOUND');
    const purchase = purchaseSnap.data() || {};
    if (String(purchase.status || '').toUpperCase() === 'COMPLETED') return;

    const licenseKey = String(purchase.licenseKey || '').trim();
    const usernameRaw = String(purchase.usernameRaw || '').trim();
    const email = String(purchase.email || '').trim().toLowerCase();
    const planId = String(purchase.planId || '').trim();
    const days = Math.max(0, Number(purchase.days || 0));
    const amount = String(purchase.amount || '').trim();
    if (!licenseKey || !days) throw new Error('PURCHASE_INVALID');

    const licenseRef = db.collection('licenses').doc(licenseKey);
    const licenseSnap = await tx.get(licenseRef);
    const nowMs = Date.now();
    const baseMs = licenseSnap.exists
      ? Math.max(nowMs, getExpiresAtMs(licenseSnap.data() || {}) || 0)
      : nowMs;
    const newExpiresAt = baseMs + (days * 86_400_000);

    if (!licenseSnap.exists) {
      tx.set(licenseRef, {
        active: true,
        deviceId: null,
        claimedAt: null,
        plan: 'comprado',
        expiresAt: admin.firestore.Timestamp.fromMillis(newExpiresAt),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        notes: {
          source: 'web-purchase',
          username: licenseKey,
          usernameRaw,
          email,
          orderId
        }
      }, { merge: true });
    } else {
      tx.set(licenseRef, {
        active: true,
        plan: 'comprado',
        expiresAt: admin.firestore.Timestamp.fromMillis(newExpiresAt),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        notes: {
          source: 'web-purchase',
          username: licenseKey,
          usernameRaw,
          email,
          orderId
        }
      }, { merge: true });
    }

    tx.update(purchaseRef, {
      status: 'COMPLETED',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      daysAdded: days,
      newExpiresAt,
      downloadUrl: APP_DOWNLOAD_URL || purchase.downloadUrl || null,
      amount,
      planId
    });
  });

  return { ok: true };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, mode: PAYPAL_MODE });
});

app.get('/buy', (_req, res) => {
  const p1 = Number(String(process.env.PRICE_1M_USD || '14.99').trim()) || 14.99;
  const p6 = Number(String(process.env.PRICE_6M_USD || '59.99').trim()) || 59.99;
  const p12 = Number(String(process.env.PRICE_12M_USD || '99.99').trim()) || 99.99;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Tikplays - Compra</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; font-family: Inter, Segoe UI, system-ui, sans-serif; }
    body { margin: 0; background: radial-gradient(1200px 600px at 20% -10%, #3b82f620, transparent), #070b16; color: #e5e7eb; }
    .wrap { max-width: 900px; margin: 40px auto; padding: 20px; }
    .card { background: #111827cc; border: 1px solid #ffffff1a; border-radius: 16px; padding: 20px; box-shadow: 0 18px 50px #0008; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p.sub { margin: 0 0 18px; color: #9ca3af; }
    .grid { display: grid; gap: 12px; grid-template-columns: 1fr; }
    @media (min-width: 760px){ .grid { grid-template-columns: 1fr 1fr; } }
    input { width: 100%; border-radius: 10px; border: 1px solid #374151; background: #0f172a; color: #f9fafb; padding: 11px 12px; }
    .plans { margin-top: 14px; display: grid; gap: 10px; grid-template-columns: 1fr; }
    @media (min-width: 760px){ .plans { grid-template-columns: 1fr 1fr 1fr; } }
    button { border: 0; border-radius: 10px; padding: 12px; color: #fff; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .6; cursor: not-allowed; }
    .p1 { background: #059669; } .p6 { background: #2563eb; } .p12 { background: #7c3aed; }
    .msg { margin-top: 12px; color: #cbd5e1; font-size: 14px; min-height: 20px; }
    .ok { color: #34d399; } .err { color: #f87171; }
    .result { margin-top: 16px; padding: 14px; border: 1px solid #374151; border-radius: 12px; background: #0b1324; display:none; }
    .result a { display:inline-block; margin-top: 10px; text-decoration:none; background:#1d4ed8; color:#fff; padding:10px 12px; border-radius:10px; font-weight:700; }
    code { background:#0f172a; border:1px solid #334155; border-radius:8px; padding:4px 8px; color:#93c5fd; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Compra tu suscripción Tikplays</h1>
      <p class="sub">Tu licencia será tu usuario de TikTok en minúsculas y sin arroba.</p>
      <div class="grid">
        <div>
          <label>Usuario de TikTok</label>
          <input id="username" placeholder="@tu_usuario" />
        </div>
        <div>
          <label>Email</label>
          <input id="email" type="email" placeholder="tu@email.com" />
        </div>
      </div>
      <div class="plans">
        <button class="p1" data-plan="1m">1 mes - $${p1.toFixed(2)}</button>
        <button class="p6" data-plan="6m">6 meses - $${p6.toFixed(2)}</button>
        <button class="p12" data-plan="12m">1 año - $${p12.toFixed(2)}</button>
      </div>
      <div id="msg" class="msg"></div>
      <div id="result" class="result">
        <div>Tu licencia: <code id="licenseKeyView"></code></div>
        <div id="expiresView" style="margin-top:8px;color:#93c5fd"></div>
        <a id="downloadBtn" href="#" target="_blank" rel="noopener">Descargar app</a>
      </div>
    </div>
  </div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = $('msg');
  const result = $('result');
  const usernameEl = $('username');
  const emailEl = $('email');
  const licenseKeyView = $('licenseKeyView');
  const expiresView = $('expiresView');
  const downloadBtn = $('downloadBtn');
  let locked = false;

  function setMsg(text, cls = '') {
    msg.className = 'msg ' + cls;
    msg.textContent = text || '';
  }
  function normalizeName(v) {
    const s = String(v || '').trim().replace(/^@+/, '').toLowerCase();
    return s;
  }
  function setDisabled(on) {
    document.querySelectorAll('button[data-plan]').forEach(b => b.disabled = !!on);
  }
  async function waitDone(orderId) {
    const endAt = Date.now() + (10 * 60 * 1000);
    while (Date.now() < endAt) {
      const r = await fetch('/purchase/order-status?orderId=' + encodeURIComponent(orderId), { cache:'no-store' });
      const js = await r.json().catch(() => ({}));
      const st = String(js.status || '').toUpperCase();
      if (st === 'COMPLETED') return js;
      if (st === 'FAILED' || st === 'CANCELED') return js;
      await new Promise(res => setTimeout(res, 4000));
    }
    return { ok:false, status:'TIMEOUT' };
  }

  document.querySelectorAll('button[data-plan]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (locked) return;
      const planId = btn.getAttribute('data-plan');
      const username = normalizeName(usernameEl.value);
      const email = String(emailEl.value || '').trim();
      if (!username) return setMsg('Ingresa tu usuario de TikTok.', 'err');
      if (!email) return setMsg('Ingresa tu email.', 'err');

      locked = true;
      setDisabled(true);
      setMsg('Creando orden de pago...');
      result.style.display = 'none';
      try {
        const r = await fetch('/purchase/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId, username, email })
        });
        const js = await r.json().catch(() => ({}));
        if (!r.ok || !js.ok || !js.orderId || !js.approveUrl) throw new Error(js.reason || 'No se pudo crear la orden');
        setMsg('Abriendo PayPal. Completa el pago para recibir tu licencia.');
        window.open(js.approveUrl, '_blank', 'noopener');
        const done = await waitDone(js.orderId);
        if (String(done.status || '').toUpperCase() === 'COMPLETED') {
          setMsg('Pago confirmado. Si ya tenías licencia, se sumaron días.', 'ok');
          licenseKeyView.textContent = done.licenseKey || username;
          expiresView.textContent = done.expiresAtMs ? ('Vence: ' + new Date(done.expiresAtMs).toLocaleString()) : '';
          downloadBtn.href = done.downloadUrl || '#';
          result.style.display = 'block';
        } else {
          setMsg('Pago no completado: ' + (done.status || 'desconocido'), 'err');
        }
      } catch (e) {
        setMsg('Error: ' + (e && e.message ? e.message : e), 'err');
      } finally {
        locked = false;
        setDisabled(false);
      }
    });
  });
})();
</script>
</body>
</html>`);
});

app.post('/createRenewalOrder', async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const planId = String(req.body?.planId || '').trim();
  const licenseKey = String(req.body?.licenseKey || '').trim();
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!PLAN_DAYS[planId]) return res.status(400).json({ ok: false, reason: 'planId invalido' });
  if (!licenseKey || !deviceId) return res.status(400).json({ ok: false, reason: 'licenseKey y deviceId requeridos' });

  const amountInfo = planAmount(planId);
  if (!amountInfo.ok) return res.status(500).json({ ok: false, reason: amountInfo.reason });
  const amount = amountInfo.amount;

  try {
    const licenseRef = db.collection('licenses').doc(licenseKey);
    const licenseSnap = await licenseRef.get();
    if (!licenseSnap.exists) return res.status(404).json({ ok: false, reason: 'La licencia no existe' });
    const license = licenseSnap.data() || {};
    if (license.active !== true) return res.status(400).json({ ok: false, reason: 'Licencia inactiva' });
    if (!license.deviceId || String(license.deviceId) !== deviceId) {
      return res.status(403).json({ ok: false, reason: 'Licencia no corresponde a este dispositivo' });
    }

    const token = await paypalAccessToken();
    const renewalId = `ren_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const invoiceId = `tikplays_${renewalId}`;

    const createResp = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': renewalId
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: renewalId,
          custom_id: renewalId,
          invoice_id: invoiceId,
          description: `Tikplays renewal ${planId}`,
          amount: { currency_code: 'USD', value: amount.toFixed(2) }
        }],
        application_context: { user_action: 'PAY_NOW' }
      })
    });

    const order = await createResp.json().catch(() => ({}));
    if (!createResp.ok || !order?.id) {
      return res.status(502).json({ ok: false, reason: 'No se pudo crear la orden en PayPal' });
    }

    const approveUrl = parseOrderApproveUrl(order);
    if (!approveUrl) return res.status(502).json({ ok: false, reason: 'PayPal no devolvio approveUrl' });

    await db.collection('licenseRenewals').doc(renewalId).set({
      renewalId,
      orderId: order.id,
      status: 'CREATED',
      licenseKey,
      deviceId,
      planId,
      days: PLAN_DAYS[planId],
      amount: amount.toFixed(2),
      currency: 'USD',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, renewalId, orderId: order.id, approveUrl });
  } catch (e) {
    console.error('[renewal] create error', e);
    return res.status(500).json({ ok: false, reason: 'Error creando orden de renovacion' });
  }
});

app.post('/purchase/create-order', async (req, res) => {
  const planId = String(req.body?.planId || '').trim();
  const usernameRaw = String(req.body?.username || '').trim();
  const emailRaw = String(req.body?.email || '').trim();
  if (!PLAN_DAYS[planId]) return res.status(400).json({ ok: false, reason: 'planId invalido' });

  const normalized = normalizeTikTokUsername(usernameRaw);
  if (!normalized.ok) return res.status(400).json({ ok: false, reason: normalized.reason });
  const emailCheck = sanitizeEmail(emailRaw);
  if (!emailCheck.ok) return res.status(400).json({ ok: false, reason: emailCheck.reason });
  if (!APP_DOWNLOAD_URL) return res.status(500).json({ ok: false, reason: 'APP_DOWNLOAD_URL no configurado' });

  const amountInfo = planAmount(planId);
  if (!amountInfo.ok) return res.status(500).json({ ok: false, reason: amountInfo.reason });
  const amount = amountInfo.amount;
  const licenseKey = normalized.value;
  const email = emailCheck.value;

  try {
    const token = await paypalAccessToken();
    const purchaseId = `buy_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const invoiceId = `tikplays_buy_${purchaseId}`;
    const days = PLAN_DAYS[planId];

    const createResp = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': purchaseId
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: purchaseId,
          custom_id: purchaseId,
          invoice_id: invoiceId,
          description: `Tikplays compra inicial ${planId} (${licenseKey})`,
          amount: { currency_code: 'USD', value: amount.toFixed(2) }
        }],
        application_context: { user_action: 'PAY_NOW' }
      })
    });

    const order = await createResp.json().catch(() => ({}));
    if (!createResp.ok || !order?.id) {
      return res.status(502).json({ ok: false, reason: 'No se pudo crear la orden en PayPal' });
    }
    const approveUrl = parseOrderApproveUrl(order);
    if (!approveUrl) return res.status(502).json({ ok: false, reason: 'PayPal no devolvio approveUrl' });

    await db.collection('licensePurchases').doc(purchaseId).set({
      purchaseId,
      orderId: order.id,
      status: 'CREATED',
      licenseKey,
      usernameRaw,
      email,
      planId,
      days,
      amount: amount.toFixed(2),
      currency: 'USD',
      downloadUrl: APP_DOWNLOAD_URL,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, purchaseId, orderId: order.id, approveUrl });
  } catch (e) {
    console.error('[purchase] create error', e);
    return res.status(500).json({ ok: false, reason: 'Error creando orden de compra' });
  }
});

app.get('/purchase/order-status', async (req, res) => {
  const orderId = String(req.query?.orderId || '').trim();
  if (!orderId) return res.status(400).json({ ok: false, reason: 'orderId requerido' });
  try {
    const q = await db.collection('licensePurchases').where('orderId', '==', orderId).limit(1).get();
    if (q.empty) return res.status(404).json({ ok: false, reason: 'Compra no encontrada' });
    const data = q.docs[0].data() || {};
    return res.json({
      ok: true,
      status: String(data.status || 'CREATED').toUpperCase(),
      licenseKey: String(data.licenseKey || '').trim() || null,
      downloadUrl: String(data.downloadUrl || APP_DOWNLOAD_URL || '').trim() || null,
      daysAdded: Number(data.daysAdded || 0),
      expiresAtMs: Number(data.newExpiresAt || 0) || null
    });
  } catch (e) {
    console.error('[purchase] status error', e);
    return res.status(500).json({ ok: false, reason: 'Error consultando estado de compra' });
  }
});

app.get('/getRenewalOrderStatus', async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const orderId = String(req.query?.orderId || '').trim();
  const licenseKey = String(req.query?.licenseKey || '').trim();
  const deviceId = String(req.query?.deviceId || '').trim();
  if (!orderId || !licenseKey || !deviceId) {
    return res.status(400).json({ ok: false, reason: 'orderId, licenseKey y deviceId requeridos' });
  }

  try {
    const q = await db.collection('licenseRenewals').where('orderId', '==', orderId).limit(1).get();
    if (q.empty) return res.status(404).json({ ok: false, reason: 'Order no encontrada' });
    const data = q.docs[0].data() || {};
    if (String(data.licenseKey || '') !== licenseKey || String(data.deviceId || '') !== deviceId) {
      return res.status(403).json({ ok: false, reason: 'Order no corresponde a esta licencia/dispositivo' });
    }
    return res.json({
      ok: true,
      status: String(data.status || 'CREATED').toUpperCase(),
      daysAdded: Number(data.daysAdded || 0),
      newExpiresAt: Number(data.newExpiresAt || 0) || null
    });
  } catch (e) {
    console.error('[renewal] status error', e);
    return res.status(500).json({ ok: false, reason: 'Error consultando estado de orden' });
  }
});

app.post('/paypalWebhook', async (req, res) => {
  if (!PAYPAL_WEBHOOK_ID) return res.status(500).json({ ok: false, reason: 'PAYPAL_WEBHOOK_ID no configurado' });

  try {
    const token = await paypalAccessToken();
    const verifyResp = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        transmission_id: req.headers['paypal-transmission-id'],
        transmission_time: req.headers['paypal-transmission-time'],
        cert_url: req.headers['paypal-cert-url'],
        auth_algo: req.headers['paypal-auth-algo'],
        transmission_sig: req.headers['paypal-transmission-sig'],
        webhook_id: PAYPAL_WEBHOOK_ID,
        webhook_event: req.body
      })
    });
    const verifyJson = await verifyResp.json().catch(() => ({}));
    if (!verifyResp.ok || String(verifyJson?.verification_status || '').toUpperCase() !== 'SUCCESS') {
      return res.status(401).json({ ok: false, reason: 'Firma de webhook invalida' });
    }

    const evt = req.body || {};
    const type = String(evt.event_type || '').toUpperCase();
    const accepted = new Set(['PAYMENT.CAPTURE.COMPLETED', 'CHECKOUT.ORDER.COMPLETED', 'CHECKOUT.ORDER.APPROVED']);
    if (!accepted.has(type)) {
      return res.json({ ok: true, ignored: true, eventType: type });
    }

    let orderId = String(
      evt?.resource?.supplementary_data?.related_ids?.order_id ||
      evt?.resource?.id ||
      evt?.resource?.invoice_id ||
      ''
    ).trim();
    if (!orderId) return res.status(400).json({ ok: false, reason: 'No orderId en evento' });
    console.log('[renewal] webhook event', { type, orderId });

    if (type === 'CHECKOUT.ORDER.APPROVED') {
      const token = await paypalAccessToken();
      const captureResult = await capturePaypalOrder(orderId, token);
      if (!captureResult.ok) {
        console.error('[renewal] capture error', captureResult.status, captureResult.data);
        return res.status(502).json({ ok: false, reason: 'No se pudo capturar la orden aprobada' });
      }
      const capturedOrderId = String(
        captureResult?.data?.id ||
        captureResult?.data?.purchase_units?.[0]?.payments?.captures?.[0]?.supplementary_data?.related_ids?.order_id ||
        orderId
      ).trim();
      orderId = capturedOrderId || orderId;
    }

    const renewalResult = await completeRenewalByOrderId(orderId);
    if (renewalResult.ok) return res.json({ ok: true, flow: 'renewal' });
    if (renewalResult.code && renewalResult.code !== 404) {
      return res.status(renewalResult.code || 500).json({ ok: false, reason: renewalResult.reason || 'No se pudo completar renovacion' });
    }

    const purchaseResult = await completePurchaseByOrderId(orderId);
    if (purchaseResult.ok) return res.json({ ok: true, flow: 'purchase' });
    if (purchaseResult.code && purchaseResult.code !== 404) {
      return res.status(purchaseResult.code || 500).json({ ok: false, reason: purchaseResult.reason || 'No se pudo completar compra' });
    }

    return res.status(404).json({ ok: false, reason: 'No existe una renovacion/compra asociada a este orderId' });
  } catch (e) {
    console.error('[renewal] webhook error', e);
    return res.status(500).json({ ok: false, reason: 'Error procesando webhook PayPal' });
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[renewal-api] listening on ${PORT} (${PAYPAL_MODE})`);
});
