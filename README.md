# Railway Renewal API (Tikplays)

Backend para renovaciones de licencia con PayPal sin Firebase Blaze.

## Endpoints

- `POST /createRenewalOrder`
- `GET /getRenewalOrderStatus`
- `POST /paypalWebhook`
- `GET /health`

## Variables de entorno (Railway)

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_MODE` = `sandbox` o `live`
- `PAYPAL_WEBHOOK_ID`
- `PRICE_1M_USD` (ej: `4.99`)
- `PRICE_6M_USD` (ej: `24.99`)
- `PRICE_12M_USD` (ej: `39.99`)
- `RENEWAL_PROXY_KEY` (debe coincidir con `RENEWAL_API_KEY` en la app local)
- `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON completo de service account; tambien acepta base64)

## Deploy en Railway

1. Crear nuevo proyecto en Railway y elegir esta carpeta.
2. Railway detecta Node y corre `npm install` + `npm start`.
3. Configurar variables de entorno listadas arriba.
4. Obtener URL publica, por ejemplo: `https://tu-api.up.railway.app`

## Configuracion en app local

En la app local (`server.js`) define:

- `RENEWAL_API_BASE_URL=https://tu-api.up.railway.app`
- `RENEWAL_API_KEY=<mismo valor de RENEWAL_PROXY_KEY>`

## Webhook PayPal

En PayPal Developer:

- Webhook URL: `https://tu-api.up.railway.app/paypalWebhook`
- Event type: `PAYMENT.CAPTURE.COMPLETED`

Luego copiar el `Webhook ID` y pegarlo en `PAYPAL_WEBHOOK_ID` de Railway.
