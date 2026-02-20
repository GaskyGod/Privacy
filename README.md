# Railway Renewal API (Tikplays)

Backend para:

- Renovacion de licencias existentes (flujo app desktop)
- Compra inicial por web publica (`/buy`) con licencia = usuario de TikTok

## Endpoints

Renovacion (app local):

- `POST /createRenewalOrder`
- `GET /getRenewalOrderStatus`

Compra publica:

- `GET /buy`
- `POST /purchase/create-order`
- `GET /purchase/order-status`

Comunes:

- `POST /paypalWebhook`
- `GET /health`

## Variables de entorno (Railway)

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_MODE` = `sandbox` o `live`
- `PAYPAL_WEBHOOK_ID`
- `PRICE_1M_USD` (ej: `14.99`)
- `PRICE_6M_USD` (ej: `59.99`)
- `PRICE_12M_USD` (ej: `99.99`)
- `RENEWAL_PROXY_KEY` (debe coincidir con `RENEWAL_API_KEY` en la app local)
- `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON completo de service account; tambien acepta base64)
- `APP_DOWNLOAD_URL` (link publico del instalador para mostrar tras compra web)
- `WEB_BUY_ALLOWED_ORIGINS` (opcional; dominios permitidos para frontend externo, separado por comas. Ej: `https://tikplays.live,https://www.tikplays.live`. Usa `*` para permitir todos)

## Configuracion en app local

En la app local (`server.js`):

- `RENEWAL_API_BASE_URL=https://tu-api.up.railway.app`
- `RENEWAL_API_KEY=<mismo valor de RENEWAL_PROXY_KEY>`

## Webhook PayPal

Webhook URL:

- `https://tu-api.up.railway.app/paypalWebhook`

Eventos recomendados:

- `CHECKOUT.ORDER.APPROVED`
- `CHECKOUT.ORDER.COMPLETED`
- `PAYMENT.CAPTURE.COMPLETED`

## Frontend en hosting externo (sin mover backend)

Si quieres alojar solo el frontend en tu hosting:

1. Sube el archivo `buy-frontend.html` a tu hosting (por ejemplo `https://tu-dominio.com/comprar.html`).
2. En ese archivo, ajusta `API_BASE` con tu dominio Railway.
3. En Railway, configura `WEB_BUY_ALLOWED_ORIGINS` con tu dominio de hosting.
4. Mantén el webhook de PayPal apuntando a Railway.

## Notas del flujo de compra web

- La licencia se normaliza como username TikTok:
  - quita `@`
  - `lowercase`
  - `trim`
- Si ya existe, se suman dias sobre `max(now, expiresAt)`.
- Si no existe, se crea con `deviceId: null` (se reclama luego desde la app).
