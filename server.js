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

app.get('/health', (_req, res) => {
  res.json({ ok: true, mode: PAYPAL_MODE });
});

app.post('/createRenewalOrder', async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const planId = String(req.body?.planId || '').trim();
  const licenseKey = String(req.body?.licenseKey || '').trim();
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!PLAN_DAYS[planId]) return res.status(400).json({ ok: false, reason: 'planId invalido' });
  if (!licenseKey || !deviceId) return res.status(400).json({ ok: false, reason: 'licenseKey y deviceId requeridos' });

  const priceEnvKey = PLAN_ENV[planId];
  const amount = Number(String(process.env[priceEnvKey] || '').trim());
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(500).json({ ok: false, reason: `Precio invalido para ${priceEnvKey}` });
  }

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
    if (type !== 'PAYMENT.CAPTURE.COMPLETED') {
      return res.json({ ok: true, ignored: true, eventType: type });
    }

    const orderId = String(
      evt?.resource?.supplementary_data?.related_ids?.order_id ||
      evt?.resource?.invoice_id ||
      ''
    ).trim();
    if (!orderId) return res.status(400).json({ ok: false, reason: 'No orderId en evento' });

    const q = await db.collection('licenseRenewals').where('orderId', '==', orderId).limit(1).get();
    if (q.empty) return res.status(404).json({ ok: false, reason: 'Renewal no encontrada para orderId' });
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

    return res.json({ ok: true });
  } catch (e) {
    console.error('[renewal] webhook error', e);
    return res.status(500).json({ ok: false, reason: 'Error procesando webhook PayPal' });
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[renewal-api] listening on ${PORT} (${PAYPAL_MODE})`);
});
