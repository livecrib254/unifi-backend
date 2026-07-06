# M-Pesa Payments Configuration Guide

This captive portal collects M-Pesa payments before authorising a device on the
UniFi hotspot. It supports **two interchangeable payment providers**:

| Provider     | Best for                                              | What you need                                  |
|--------------|-------------------------------------------------------|------------------------------------------------|
| **Paystack** | Fastest to set up, no Safaricom paperwork, cards too  | A Paystack account + secret key                |
| **Daraja**   | Paying straight into your own Safaricom Paybill/Till   | A Safaricom Daraja app + Paybill/Till + passkey|

You pick which one is active with a single environment variable —
**`PAYMENT_PROVIDER`** — without touching any code. The frontend and the rest of
the backend behave identically either way.

```
PAYMENT_PROVIDER=paystack   # or: daraja
```

---

## How it works (both providers)

1. The user picks a plan and enters their M-Pesa number in the portal.
2. Frontend → `POST /api/initiate-payment` → backend triggers an **STK push**
   (the M-Pesa PIN prompt on the customer's phone).
3. The customer enters their PIN.
4. Confirmation reaches the backend two ways (whichever arrives first wins):
   - **Webhook/callback** — the provider POSTs the result to your server.
   - **Polling** — the frontend calls `GET /api/verify-payment/:reference`
     every few seconds.
5. On success the backend creates a UniFi voucher and authorises the device.

You do **not** have to choose between webhook and polling — both are wired up and
they cooperate (the callback flags the payment, a racing poll returns success).

---

## Common setup

```bash
cd unifi_backend
pnpm install        # or: npm install
cp .env.example .env   # if you don't already have a .env
```

Fill in the UniFi section of `.env` (already present in this repo):

```
UNIFI_URL="https://<controller-ip>:8443"
UNIFI_USERNAME="voucher"
UNIFI_PASSWORD="********"
UNIFI_SITE="<site-id>"
```

Then configure **one** of the providers below and set `PAYMENT_PROVIDER`
accordingly. Start the server:

```bash
node hotspotServer.js
# → 🚀 Server running on port 5000 — payment provider: paystack
```

The startup log prints which provider is active — check it matches what you expect.

---

## Option A — Paystack

Paystack brokers the M-Pesa transaction for you. No Safaricom app required.

### 1. Get your secret key
1. Sign up / log in at <https://dashboard.paystack.com>.
2. Go to **Settings → API Keys & Webhooks**.
3. Copy the **Secret Key**:
   - `sk_test_...` for testing
   - `sk_live_...` for production (requires a fully activated account)
4. Make sure **M-Pesa / Mobile Money (KES)** is enabled for your account —
   Paystack must have Kenya + KES turned on.

### 2. Configure `.env`
```
PAYMENT_PROVIDER=paystack


# PAYSTACK_EMAIL=owner@example.com   # optional; a placeholder is auto-generated otherwise
```

> Paystack requires an email per charge (for the receipt). If the customer leaves
> the email field blank, the backend generates a placeholder from their phone
> number automatically.

### 3. Configure the webhook (recommended)
1. In **Settings → API Keys & Webhooks**, set the **Webhook URL** to:
   ```
   https://<your-public-domain>/api/webhook/paystack
   ```
2. Paystack signs each webhook with your secret key; the backend verifies the
   `x-paystack-signature` header automatically — no extra config needed.

> If you cannot expose a public webhook URL yet, you can skip this — the
> frontend polling path (`/api/verify-payment/:reference`) still confirms
> payments. The webhook just makes confirmation faster and more reliable.

### 4. Test
- Use `sk_test_...` and Paystack's test M-Pesa flow, or
- Use `sk_live_...` with a small real amount (e.g. KES 5).

---

## Option B — Daraja (Safaricom M-Pesa API)

Daraja pushes money **directly into your own Paybill or Till**. It requires a
Safaricom developer app and the "Lipa Na M-Pesa Online" (STK push) product.

### 1. Create a Daraja app
1. Go to <https://developer.safaricom.co.ke> and sign in.
2. **My Apps → Add a new app**. Tick the **Lipa Na M-Pesa Online** (and
   **M-Pesa Sandbox**) products.
3. Open the app to copy its **Consumer Key** and **Consumer Secret**.

### 2. Get your Shortcode + Passkey

**Sandbox (for testing):**
- Under **APIs → Lipa Na M-Pesa Online → Simulate**, Safaricom gives you a test
  **Shortcode** (e.g. `174379`) and a test **Passkey**. Use those.
- Test with the sandbox test MSISDN Safaricom provides.

**Production (real money):**
- You need a live **Paybill** or **Till (Buy Goods)** number from Safaricom.
- Apply for **Go Live** in the Daraja portal to bind your app to that shortcode.
- Safaricom issues the production **Passkey** for your shortcode
  (via the Go-Live process / M-Pesa Org portal).

### 3. Choose Paybill vs Till
| Your shortcode is a… | Set `DARAJA_TRANSACTION_TYPE` to |
|----------------------|----------------------------------|
| Paybill              | `CustomerPayBillOnline`          |
| Till (Buy Goods)     | `CustomerBuyGoodsOnline`         |

### 4. Expose a public callback URL
Safaricom must be able to reach your server over **HTTPS**. Point the callback at:
```
https://<your-public-domain>/api/webhook/daraja
```
For local testing, tunnel it with e.g. `ngrok http 5000` and use the generated
`https://….ngrok.io/api/webhook/daraja` URL.

> Safaricom rejects `http://`, `localhost`, and non-standard ports for
> production callbacks — it must be a public HTTPS URL.

### 5. Configure `.env`
```
PAYMENT_PROVIDER=daraja

DARAJA_ENV=sandbox                       # switch to "production" when live
DARAJA_CONSUMER_KEY=your-consumer-key
DARAJA_CONSUMER_SECRET=your-consumer-secret
DARAJA_SHORTCODE=174379                  # your Paybill / Till number
DARAJA_PASSKEY=your-lipa-na-mpesa-passkey
DARAJA_TRANSACTION_TYPE=CustomerPayBillOnline   # or CustomerBuyGoodsOnline
DARAJA_CALLBACK_URL=https://yourdomain.com/api/webhook/daraja
DARAJA_ACCOUNT_REF=HOTSPOT              # appears on the customer's statement (max 12 chars)
```

`DARAJA_BASE_URL` is selected automatically from `DARAJA_ENV`:
- `sandbox` → `https://sandbox.safaricom.co.ke`
- `production` → `https://api.safaricom.co.ke`

### 6. Test
1. Start the server; the log should say `payment provider: daraja`.
2. Trigger a payment from the portal with the sandbox test number.
3. Approve the sandbox STK prompt (or use the Simulate tool).
4. Watch the server log for `📥 Daraja callback … ResultCode=0` and
   `✅ Client … authorised via Daraja callback`.

---

## Switching providers

Change one line and restart — nothing else:

```
PAYMENT_PROVIDER=daraja      # was: paystack
```

Both providers use the exact same portal, endpoints, and voucher/authorisation
logic, so no frontend or code changes are needed.

---

## Endpoint reference

| Method & path                        | Purpose                                             |
|--------------------------------------|-----------------------------------------------------|
| `POST /api/initiate-payment`         | Start an STK push. Returns `{ reference, provider }`.|
| `GET  /api/verify-payment/:reference`| Poll payment status; authorises on success.         |
| `POST /api/webhook/paystack`         | Paystack `charge.success` callback (signed).        |
| `POST /api/webhook/daraja`           | Safaricom STK result callback.                      |
| `POST /api/auth`                     | Admin/testing: authorise a MAC directly, no payment.|

**`POST /api/initiate-payment` body**
```json
{
  "phoneNumber": "0722000000",
  "clientMac": "aa:bb:cc:dd:ee:ff",
  "amount": 25,
  "email": "user@example.com",      // optional (Paystack receipt only)
  "duration": 60,                    // time plans
  "expire_number": 60,
  "expire_unit": 1,
  "data": 250                        // data plans (MB) — send instead of duration
}
```

`reference` returned here is the value the frontend passes to
`/api/verify-payment/:reference`:
- Paystack → the Paystack transaction reference
- Daraja → the STK `CheckoutRequestID`

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Startup shows the wrong provider | `PAYMENT_PROVIDER` typo or `.env` not loaded — it must be `paystack` or `daraja` (lowercase). |
| Paystack: `Invalid key` | Wrong/rotated `PAYSTACK_SECRET_KEY`, or using a live key on a test-only account. |
| Paystack: STK never arrives | M-Pesa/KES not enabled on the Paystack account; or invalid phone. |
| Webhook ignored (`signature mismatch`) | Paystack webhook URL points elsewhere, or the key changed after setting the webhook. |
| Daraja: `Invalid Access Token` | Wrong consumer key/secret, or wrong `DARAJA_ENV` for those credentials. |
| Daraja: STK push rejected | Shortcode/passkey mismatch, wrong `DARAJA_TRANSACTION_TYPE`, or amount not a whole number. |
| Daraja: callback never hits server | `DARAJA_CALLBACK_URL` not public HTTPS / firewalled; verify with a tunnel like ngrok. |
| Payment succeeds but no internet | UniFi authorisation failed — check `UNIFI_*` creds and that the voucher user has permission. |
| Poll times out but money left the phone | Callback didn't arrive; confirm the webhook/callback URL and that the server is reachable. |

> **Phone number formats accepted** (both providers): `0722000000`,
> `722000000`, `254722000000`, `+254722000000`.

---

## Security notes

- **Never commit `.env`.** It holds live secrets and is already git-ignored.
- Rotate `PAYSTACK_SECRET_KEY` / Daraja secrets if they are ever exposed.
- Always serve the backend over **HTTPS** in production — provider callbacks and
  M-Pesa data must not travel over plain HTTP.
- The Daraja callback is unauthenticated by design (Safaricom does not sign it);
  keep the endpoint path private and, if possible, restrict inbound traffic to
  Safaricom's published IP ranges at your firewall/reverse proxy.
