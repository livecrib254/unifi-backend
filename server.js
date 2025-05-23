require("dotenv").config();
const express = require("express");
const axios = require("axios");
const https = require("https");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5000;

// UniFi Controller Credentials
const UNIFI_URL = process.env.UNIFI_URL;
const SITE = process.env.UNIFI_SITE;
const USERNAME = process.env.UNIFI_USERNAME;
const PASSWORD = process.env.UNIFI_PASSWORD;

// const api = axios.create({
//     baseURL: `${UNIFI_URL}/api/s/${SITE}`,
//     httpsAgent: new https.Agent({ rejectUnauthorized: false }),
//     withCredentials: true,
//   });

// Axios instance for UniFi API
const axiosInstance = axios.create({
  baseURL: `${UNIFI_URL}/api/s/${SITE}`,
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
  }),
  withCredentials: true,
});

const login = async () => {
  try {
    const response = await axiosInstance.post(
      `${UNIFI_URL}/api/login`,
      { username: USERNAME, password: PASSWORD },
      {
        headers: { "Content-Type": "application/json" },
        withCredentials: true,
      }
    );

    if (response.data?.meta?.rc === "ok") {
      console.log("✅ UniFi Login Successful!");
      const cookies = response.headers["set-cookie"];
      return Array.isArray(cookies) ? cookies.join("; ") : cookies;
    } else {
      console.error("❌ Login failed:", response.data);
      return null;
    }
  } catch (error) {
    console.error(
      "❌ UniFi Login Error:",
      error.response?.data || error.message
    );
    return null;
  }
};

async function createVouchers(duration = 10, expire_number, expire_unit) {
  const cookie = await login();
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
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }
    );

    console.log(
      "Voucher creation response:",
      JSON.stringify(response.data, null, 2)
    );

    if (response.data?.meta?.rc === "ok") {
      const vouchers = await getVouchers();
      const latestVoucher = vouchers
        .filter((v) => v.note === "Hotspot Auth")
        .sort((a, b) => b.create_time - a.create_time)[0];

      console.log(
        "New voucher details:",
        JSON.stringify(latestVoucher, null, 2)
      );
      return latestVoucher;
    }

    return null;
  } catch (error) {
    console.error(
      "Failed to create vouchers:",
      error.response?.data || error.message
    );
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
        n: 1, // number of vouchers
        quota: 1, // number of uses
        note: "Hotspot Data Auth",
        bytes: dataBytes, // 100MB in bytes
        expire: 525600, // how long the voucher exists (365 days in minutes)
        expire_number: 365,
        expire_unit: 1440, // 1440 = 1 day
        up: null, // optional upload speed limit
        down: null, // optional download speed limit
        for_hotspot: true,
      },
      {
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }
    );
    console.log(
      "Data voucher creation response:",
      JSON.stringify(response.data, null, 2)
    );

    if (response.data?.meta?.rc === "ok") {
      const vouchers = await getVouchers();
      const latestVoucher = vouchers
        .filter((v) => v.note === "Hotspot Data Auth")
        .sort((a, b) => b.create_time - a.create_time)[0];
      console.log(latestVoucher);
      return latestVoucher;
    }
    return null;
  } catch (error) {
    console.error(
      "❌ Failed to create data voucher:",
      error.response?.data || error.message
    );
    return null;
  }
}

async function getVouchers() {
  const cookie = await login();
  if (!cookie) return [];

  try {
    const response = await axios.get(
      `${UNIFI_URL}/api/s/${SITE}/stat/voucher`,
      {
        headers: { Cookie: cookie },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }
    );

    console.log("🎟️ Vouchers retrieved successfully");
    return response.data.data || [];
  } catch (error) {
    console.error(
      "❌ Failed to retrieve vouchers:",
      error.response?.data || error.message
    );
    return [];
  }
}

async function listSites() {
  const cookie = await login();
  if (!cookie) {
    console.error("❌ Failed to retrieve session cookie for listing sites.");
    return null;
  }

  try {
    const response = await axios.get(`${UNIFI_URL}/api/self/sites`, {
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    console.log("✅ Available sites:", JSON.stringify(response.data, null, 2));

    // Extract and display site info in a more readable format
    if (response.data && response.data.data) {
      console.log("\n📋 Sites Summary:");
      response.data.data.forEach((site, index) => {
        console.log(
          `${index + 1}. Name: "${site.name}" | ID: "${
            site._id
          }" | Description: "${site.desc}"`
        );
      });
    }

    return response.data;
  } catch (error) {
    console.error(
      "❌ Failed to list sites:",
      error.response?.data || error.message
    );
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
    // Assuming 1 MB = 1024 * 1024 bytes
    const dataBytes = data;
    newVoucher = await createDataVoucher(dataBytes);
  } else {
    throw new Error("Must provide either duration or data");
  }

  if (!newVoucher) {
    throw new Error("Failed to create voucher");
  }

  const payload = {
    cmd: "authorize-guest",
    mac: clientMac.toLowerCase(),
    voucher: newVoucher.code,
    minutes:0,
  };

  // Add time limit if it's a time-based voucher
  if (newVoucher.duration) {
    payload.minutes = newVoucher.duration;
  }

  // Add data limit if it's a data-based voucher
  if (newVoucher.qos_usage_quota) {
    payload. bytes = +newVoucher.qos_usage_quota;
    // You might also need to specify it's unlimited time for data vouchers
    payload.minutes = newVoucher.duration; // or remove minutes entirely
  }

  console.log("🔑 Authorization attempt:", JSON.stringify(payload, null, 2));

  try {
    const response = await axios.post(
      `${UNIFI_URL}/api/s/${SITE}/cmd/stamgr`,
      payload,
      {
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }
    );

    if (response.data.meta?.rc === "ok") {
      console.log("✅ Authorization successful");
      return true;
    }

   
    // const altResponse = await axios.post(
    //   `${UNIFI_URL}/api/s/${SITE}/cmd/hotspot`,
    //   payload,
    //   {
    //     headers: {
    //       Cookie: cookie,
    //       "Content-Type": "application/json",
    //     },
    //     httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    // //   }
    // // );

    // return altResponse.data.meta?.rc === "ok";
  } catch (error) {
    console.error(
      "❌ Error during authorization:",
      error.response?.data || error.message
    );
    return false;
  }
}

async function testInternetConnection() {
  try {
    const response = await axios.get("https://www.google.com", {
      timeout: 5000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    return response.status === 200;
  } catch (error) {
    console.error("❌ No internet access:", error.message);
    return false;
  }
}

// Updated POST endpoint to handle client authentication

app.post("/auth", async (req, res) => {
  const { clientMac, duration, data, expire_number, expire_unit } = req.body;

  if (!clientMac) {
    return res
      .status(400)
      .json({ success: false, message: "Client MAC is required" });
  }

  try {
    const authorized = await authorizeClient(clientMac, {
      duration,
      data,
      expire_number,
      expire_unit,
    });

    if (!authorized) {
      return res
        .status(500)
        .json({ success: false, message: "Authorization failed" });
    }

    res.json({ success: true, message: "Client authorized", clientMac });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

// Simulate M-Pesa STK Push Payment Success

app.post("/simulate-payment", async (req, res) => {
  const { phoneNumber, clientMac, duration, data } = req.body;

  if (!phoneNumber || !clientMac) {
    return res
      .status(400)
      .json({ success: false, message: "Missing phone number or MAC" });
  }

  try {
    // const authorized = await authorizeClient(clientMac, { duration, data });

    // console.log("📲 Simulating payment for:", {
    //     phoneNumber,
    //     duration
    // });

    // // Normally, you'd validate payment status with Safaricom API
    // // For simulation, we assume the payment was successful

    // if (!authorized) {
    //     return res.status(500).json({ success: false, message: "Authorization failed" });
    // }

    res.json({
      success: true,
      message: "Payment simulated and client authorized",
      clientMac,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

// async function getVouchers() {
//     const cookie = await login();
//     if (!cookie) return [];

//     try {
//       const response = await api.get("/stat/voucher", {
//         headers: { Cookie: cookie },
//       });

//       console.log("🚀 Raw Voucher Response:", JSON.stringify(response.data, null, 2));

//       return response.data.data || []; // Ensure we return an array
//     } catch (error) {
//       console.error("❌ Failed to retrieve vouchers:", error.response?.data || error.message);
//       return [];
//     }
//   }

app.get("/", (req, res) => {
  createDataVoucher(30);
  res.json({ message: "UniFi Hotspot Server Running" });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
