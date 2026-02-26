import "dotenv/config";
import express from "express";
import axios from "axios";
import https from "https";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5000;

//UniFi Controller Config

const UNIFI_URL = process.env.UNIFI_URL;
const SITE = process.env.UNIFI_SITE;
const USERNAME = process.env.UNIFI_USERNAME;
const PASSWORD = process.env.UNIFI_PASSWORD;

//Paystack Config

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY; // sk_live_... or sk_test_...
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_SECRET_KEY; 
const PAYSTACK_EMAIL = process.env.PAYSTACK_EMAIL //paystack account's holder Email

// ── In-memory pending payments store 
// Maps paystack reference → { clientMac, duration, data, expire_number, expire_unit }

const pendingPayments = new Map();

// Axios instance for UniFi API

const axiosInstance = axios.create({
  baseURL: `${UNIFI_URL}/api/s/${SITE}`,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  withCredentials: true,
});

// ═══════════════════════════════════════════════════════════════════════════
// UniFi helpers
// ═══════════════════════════════════════════════════════════════════════════

const login = async () => {
  try {
    const response = await axiosInstance.post(
      `${UNIFI_URL}/api/login`,
      { username: USERNAME, password: PASSWORD },
      { headers: { "Content-Type": "application/json" }, withCredentials: true }
    );

    if (response.data?.meta?.rc === "ok") {
      console.log("✅ UniFi Login Successful!");
      const cookies = response.headers["set-cookie"];
      return Array.isArray(cookies) ? cookies.join("; ") : cookies;
    }

    console.error("❌ Login failed:", response.data);
    return null;
  } catch (error) {
    console.error("❌ UniFi Login Error:", error.response?.data || error.message);
    return null;
  }
};

async function getVouchers() {
  const cookie = await login();
  if (!cookie) return [];

  try {
    const response = await axios.get(`${UNIFI_URL}/api/s/${SITE}/stat/voucher`, {
      headers: { Cookie: cookie },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    console.log("🎟️ Vouchers retrieved successfully");
    return response.data.data || [];
  } catch (error) {
    console.error("❌ Failed to retrieve vouchers:", error.response?.data || error.message);
    return [];
  }
}

async function createVouchers(duration = 10, expire_number, expire_unit) {
  const cookie = await login();
  if (!cookie) return null;

  try {
    const response = await axios.post(
      `${UNIFI_URL}/api/s/${SITE}/cmd/hotspot`,
      {
        cmd: "create-voucher",
        expire: duration,
        n: 1,
        quota: 1,
        note: "Hotspot Auth",
        up: null,
        down: null,
        bytes: null,
        for_hotspot: true,
        expire_number,
        expire_unit,
      },
      {
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }
    );

    console.log("Voucher creation response:", JSON.stringify(response.data, null, 2));

    if (response.data?.meta?.rc === "ok") {
      const vouchers = await getVouchers();
      return vouchers
        .filter((v) => v.note === "Hotspot Auth")
        .sort((a, b) => b.create_time - a.create_time)[0];
    }

    return null;
  } catch (error) {
    console.error("Failed to create vouchers:", error.response?.data || error.message);
    throw error;
  }
}

async function createDataVoucher(dataBytes) {
  const cookie = await login();
  if (!cookie) return null;

  try {
    const response = await axios.post(
      `${UNIFI_URL}/api/s/${SITE}/cmd/hotspot`,
      {
        cmd: "create-voucher",
        n: 1,
        quota: 1,
        note: "Hotspot Data Auth",
        bytes: dataBytes,
        expire: 525600,
        expire_number: 365,
        expire_unit: 1440,
        up: null,
        down: null,
        for_hotspot: true,
      },
      {
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }
    );

    console.log("Data voucher creation response:", JSON.stringify(response.data, null, 2));

    if (response.data?.meta?.rc === "ok") {
      const vouchers = await getVouchers();
      return vouchers
        .filter((v) => v.note === "Hotspot Data Auth")
        .sort((a, b) => b.create_time - a.create_time)[0];
    }

    return null;
  } catch (error) {
    console.error("❌ Failed to create data voucher:", error.response?.data || error.message);
    return null;
  }
}

async function authorizeClient(clientMac, options = {}) {
  const cookie = await login();
  if (!cookie) {
    console.error("❌ Failed to retrieve session cookie.");
    return false;
  }

  const { duration, data, expire_number, expire_unit } = options;
  let newVoucher;

  if (duration) {
    newVoucher = await createVouchers(duration, expire_number, expire_unit);
  } else if (data) {
    newVoucher = await createDataVoucher(data);
  } else {
    throw new Error("Must provide either duration or data");
  }

  if (!newVoucher) throw new Error("Failed to create voucher");

  const payload = {
    cmd: "authorize-guest",
    mac: clientMac.toLowerCase(),
    voucher: newVoucher.code,
  };

  if (newVoucher.qos_usage_quota) {
    payload.bytes = +newVoucher.qos_usage_quota * 1;
    payload.minutes = 0;
  } else if (newVoucher.duration) {
    payload.minutes = newVoucher.duration;
  }

  console.log("🔑 Authorization attempt:", JSON.stringify(payload, null, 2));

  try {
    const response = await axios.post(
      `${UNIFI_URL}/api/s/${SITE}/cmd/stamgr`,
      payload,
      {
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }
    );

    if (response.data.meta?.rc === "ok") {
      console.log("✅ Authorization successful");
      return true;
    }

    return false;
  } catch (error) {
    console.error("❌ Error during authorization:", error.response?.data || error.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Paystack M-Pesa helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalise a Kenyan phone number to +254XXXXXXXXX format.
 * Accepts: 07XXXXXXXX, 7XXXXXXXX, 2547XXXXXXXX, +2547XXXXXXXX
 */


function formatKEPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+254${digits.slice(1)}`;
  if (digits.length === 9) return `+254${digits}`;
  throw new Error(`Invalid Kenyan phone number: ${phone}`);
}

/**
 * Initiate a Paystack M-Pesa STK push.
 * Returns { reference } so the caller can poll / await webhook.
 */

async function initiatePaystackMpesa({ phone, amountKES, email, metadata = {} }) {
  
  const formattedPhone = formatKEPhone(phone);
  const reference = `HOTSPOT-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;


  // ✅ Random domain pick
  const domains = ["gmail.com", "yahoo.com", "outlook.com"];
  const randomDomain = domains[Math.floor(Math.random() * domains.length)];

  const payload = {
    email: email || `${formattedPhone.replace("+", "")}@${randomDomain}`, // Paystack requires a clients email to send payment receipt 
    amount: amountKES * 100, // Paystack uses kobo/cents (KES * 100)
    currency: "KES",
    reference,
    mobile_money: {
      phone: formattedPhone,
      provider: "mpesa",
    },
    metadata,
  };

  //console.log("📲 Initiating Paystack M-Pesa STK push:", JSON.stringify(payload, null, 2));

  const response = await axios.post("https://api.paystack.co/charge", payload, {
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const { data } = response.data;

  // Paystack responds with status: "pay_offline" or "pending" for mobile money
 // console.log("📲 Paystack charge response:", JSON.stringify(data, null, 2));

  return { reference, status: data.status, displayText: data.display_text };
}

/**
 * Verify a Paystack transaction by reference.
 */

async function verifyPaystackTransaction(reference) {
  const response = await axios.get(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    }
  );
  return response.data.data;
}

// ═══════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════

/** Health check */

app.get("/api", (_req, res) => {
  res.json({ message: "UniFi Hotspot Server Running" });
});

/**
 * POST /initiate-payment
 * Start an M-Pesa STK push via Paystack.
 * Body: { phoneNumber, clientMac, amount, duration?, data?, expire_number?, expire_unit? }
 */

app.post("/api/initiate-payment", async (req, res) => {
  const { phoneNumber, clientMac, amount, email, duration, data, expire_number, expire_unit } = req.body;

  if (!phoneNumber || !clientMac || !amount) {
    return res.status(400).json({
      success: false,
      message: "phoneNumber, clientMac, and amount are required",
    });
  }

  try {
    const { reference, status, displayText } = await initiatePaystackMpesa({
      phone:     phoneNumber,
      amountKES: amount,
      email,
      metadata:  { clientMac, duration, data, expire_number, expire_unit },
    });

    pendingPayments.set(reference, {
      clientMac,
      duration,
      data,
      expire_number,
      expire_unit,
    });

    console.log(`🔖 Pending payment stored [${reference}] for MAC ${clientMac}`);

    res.json({
      success:     true,
      reference,
      status,
      displayText,
      message:     "STK push sent. Please complete payment on your phone.",
    });
  } catch (error) {
    console.error("❌ Payment initiation error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message,
    });
  }
});

/**
 * GET /verify-payment/:reference
 * Poll this endpoint from the frontend to check payment status.
 * On success it authorises the UniFi client automatically.
 */

app.get("/api/verify-payment/:reference", async (req, res) => {
  const { reference } = req.params;

  try {
    const txn = await verifyPaystackTransaction(reference);

    if (txn.status === "success") {
      const pending = pendingPayments.get(reference);

      if (!pending) {
        // Already processed or unknown reference
        return res.json({ success: true, status: "success", alreadyProcessed: true });
      }

      const { clientMac, duration, data, expire_number, expire_unit } = pending;

      const authorized = await authorizeClient(clientMac, {
        duration,
        data,
        expire_number,
        expire_unit,
      });

      console.log("Authorized",authorized)

      pendingPayments.delete(reference);

      if (authorized) {
        return res.json({ success: true, status: "success", clientMac });
      }

      return res.status(500).json({
        success: false,
        status: "success",
        message: "Payment received but UniFi authorisation failed",
      });
    }

    // still pending / failed
    res.json({ success: false, status: txn.status });
  } catch (error) {
    console.error("❌ Verify payment error:", error.response?.data || error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /webhook/paystack
 * Paystack sends charge.success events here.
 * Verify the signature then authorise the UniFi client.
 */

app.post("/api/webhook/paystack", async (req, res) => {
  // 1. Verify signature
  const signature = req.headers["x-paystack-signature"];

  console.log(signature)

  const hash = crypto
    .createHmac("sha512", PAYSTACK_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== signature) {
    console.warn("⚠️  Webhook signature mismatch — ignoring");
    return res.status(401).send("Unauthorised");
  }

  const { event, data } = req.body;

  if (event === "charge.success" && data.status === "success") {
    const reference = data.reference;
    console.log(`✅ Webhook: charge.success for reference ${reference}`);

    const pending = pendingPayments.get(reference);

    if (pending) {
      const { clientMac, duration, dataBytes, expire_number, expire_unit } = pending;

      try {
        await authorizeClient(clientMac, { duration, data: dataBytes, expire_number, expire_unit });
        pendingPayments.delete(reference);
        console.log(`✅ Client ${clientMac} authorised via webhook`);
      } catch (err) {
        console.error("❌ Webhook authorisation error:", err.message);
      }
    }
  }

  // Always respond 200 quickly so Paystack doesn't retry
  res.sendStatus(200);
});

/**
 * POST /auth
 * Direct authorisation (bypasses payment – kept for testing/admin use).
 */
app.post("/api/auth", async (req, res) => {
  const { clientMac, duration, data, expire_number, expire_unit } = req.body;

  if (!clientMac) {
    return res.status(400).json({ success: false, message: "Client MAC is required" });
  }

  try {
    const authorized = await authorizeClient(clientMac, {
      duration,
      data,
      expire_number,
      expire_unit,
    });

    if (!authorized) {
      return res.status(500).json({ success: false, message: "Authorization failed" });
    }

    res.json({ success: true, message: "Client authorized", clientMac });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));