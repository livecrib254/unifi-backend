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
const UNIFI_URL = process.env.UNIFI_URL
const SITE = process.env.UNIFI_SITE
const USERNAME = process.env.UNIFI_USERNAME
const PASSWORD = process.env.UNIFI_PASSWORD

const api = axios.create({
    baseURL: `${UNIFI_URL}/api/s/${SITE}`,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    withCredentials: true,
  });

// Axios instance for UniFi API
const axiosInstance = axios.create({
    baseURL: `${UNIFI_URL}/api/s/${SITE}`,
    httpsAgent: new https.Agent({
        rejectUnauthorized: false
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
                withCredentials: true 
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
        console.error("❌ UniFi Login Error:", error.response?.data || error.message);
        return null;
    }
};

async function createVouchers(duration = 10) {
    const cookie = await login();
    try {
        const response = await axios.post(
            `${UNIFI_URL}/api/s/${SITE}/cmd/hotspot`,
            {
                cmd: "create-voucher",
                expire: duration,
                expire_number: 1,
                expire_unit: 1,
                n: 1,
                quota: 1,
                note: "Hotspot Auth",
                up: null,
                down: null,
                bytes: null,
                for_hotspot: true
            },
            { 
                headers: { 
                    Cookie: cookie,
                    'Content-Type': 'application/json'
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        );

        console.log("Voucher creation response:", JSON.stringify(response.data, null, 2));

        if (response.data?.meta?.rc === "ok") {
            const vouchers = await getVouchers();
            const latestVoucher = vouchers
                .filter(v => v.note === "Hotspot Auth")
                .sort((a, b) => b.create_time - a.create_time)[0];
            
            console.log("New voucher details:", JSON.stringify(latestVoucher, null, 2));
            return latestVoucher;
        }
        
        return null;
    } catch (error) {
        console.error("Failed to create vouchers:", error.response?.data || error.message);
        throw error;
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
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        );

        console.log("🎟️ Vouchers retrieved successfully");
        return response.data.data || [];
    } catch (error) {
        console.error("❌ Failed to retrieve vouchers:", error.response?.data || error.message);
        return [];
    }
}

async function authorizeClient(clientMac, duration = 10) {
    const cookie = await login();
    if (!cookie) {
        console.error("❌ Failed to retrieve session cookie.");
        return false;
    }

    try {
        // Create a new voucher with specified duration
        const newVoucher = await createVouchers(duration);
        if (!newVoucher) {
            throw new Error("Failed to create voucher");
        }

        const payload = {
            cmd: "authorize-guest",
            mac: clientMac.toLowerCase(),
            voucher: newVoucher.code,
            minutes: newVoucher.duration
        };

        console.log("🔑 Authorization attempt:", JSON.stringify(payload, null, 2));

        const response = await axios.post(
            `${UNIFI_URL}/api/s/${SITE}/cmd/stamgr`,
            payload,
            {
                headers: { 
                    Cookie: cookie,
                    'Content-Type': 'application/json'
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        );

        if (response.data.meta?.rc === "ok") {
            console.log("✅ Authorization successful");
            return true;
        }

        // Try alternative endpoint if first attempt fails
        const altPayload = {
            cmd: "authorize-guest",
            mac: clientMac.toLowerCase(),
            voucher_code: newVoucher.code
        };

        const altResponse = await axios.post(
            `${UNIFI_URL}/api/s/${SITE}/cmd/hotspot`,
            altPayload,
            {
                headers: { 
                    Cookie: cookie,
                    'Content-Type': 'application/json'
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        );

        if (altResponse.data.meta?.rc === "ok") {
            console.log("✅ Authorization successful with alternative endpoint");
            return true;
        }

        console.error("❌ Authorization failed with both attempts");
        return false;
    } catch (error) {
        console.error("❌ Error during authorization:", error.response?.data || error.message);
        return false;
    }
}


async function testInternetConnection() {
    try {
        const response = await axios.get("https://www.google.com", {
            timeout: 5000,
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        return response.status === 200;
    } catch (error) {
        console.error("❌ No internet access:", error.message);
        return false;
    }
}

// Updated POST endpoint to handle client authentication
// Updated POST endpoint to handle duration
app.post("/auth", async (req, res) => {
    try {
        const { clientMac, apMac, timestamp, redirectUrl, ssid, duration = 10 } = req.body;

        if (!clientMac) {
            return res.status(400).json({ 
                success: false, 
                message: "Client MAC address is required" 
            });
        }

        // Validate duration
        const validDurations = [10, 20, 30, 60, 720, 1440];
        if (!validDurations.includes(duration)) {
            return res.status(400).json({
                success: false,
                message: "Invalid duration specified"
            });
        }

        console.log("📡 Authorizing client:", {
            clientMac,
            apMac,
            ssid,
            duration,
            timestamp: new Date(timestamp * 1000).toISOString()
        });

        const authorized = await authorizeClient(clientMac, duration);

        if (!authorized) {
            return res.status(500).json({ 
                success: false, 
                message: "Client authorization failed" 
            });
        }

        const internetAccess = await testInternetConnection();
        
        res.json({ 
            success: true, 
            mac: clientMac, 
            internetAccess,
            redirectUrl: redirectUrl || null,
            duration
        });
    } catch (error) {
        console.error("❌ Error in /auth:", error);
        res.status(500).json({ 
            success: false, 
            message: "Internal server error" 
        });
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
    res.json({ message: "UniFi Hotspot Server Running" });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));