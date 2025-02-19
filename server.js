require("dotenv").config();
const express = require("express");
const axios = require("axios");
const https = require("https");
const os = require("os");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5000;

// UniFi Controller Credentials
const UNIFI_URL = "https://192.168.8.41:8443"; // e.g., "https://192.168.8.41:8443"
const SITE = "default";
const USERNAME = "labtech";
const PASSWORD = "m0t0m0t0";
const VOUCHER_CODE = process.env.VOUCHER_CODE;

// Axios instance for UniFi API (ignores SSL for self-signed certificates)
const api = axios.create({
  baseURL: `${UNIFI_URL}/api/s/${SITE}`,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  withCredentials: true,
});

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({
      rejectUnauthorized: false, // Ignore self-signed certificates
    }),
  });


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
      } else {
        console.error("❌ Login failed:", response.data);
        return null;
      }
    } catch (error) {
      console.error("❌ UniFi Login Error:", error.response?.data || error.message);
      return null;
    }
  };
  

async function getClients() {
    const cookies = await login();
    if (!cookies) {
      console.error("❌ No cookies received from login.");
      return;
    }
  
    try {
        const clientsResponse = await axios.get(
            `${UNIFI_URL}/api/s/${SITE}/stat/sta`, // Adjusted path
        { headers: { Cookie: cookies }, withCredentials: true, httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
      );
  
      const clients = clientsResponse.data.data;
      console.log("📡 Connected Clients:", clients.map((c) => ({ mac: c.mac, ip: c.ip })));
      console.log(clients)
      return clients;
    } catch (error) {
      console.error("⚠️ Error Fetching UniFi Clients:", error.response?.data || error.message);
    }
  }

function getAllPrivateIPs() {
    const interfaces = os.networkInterfaces();
    const privateIPs = [];
  
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (!iface.internal && iface.family === "IPv4") {
          privateIPs.push(iface.address);
        }
      }
    }
    console.log(privateIPs)
    return privateIPs;
  }

async function getMacAddressesForPrivateIPs() {
    const privateIPs = getAllPrivateIPs();
    const clients = await getClients();
    console.log(clients, privateIPs )
    if (!clients.length) return [];
  
    const filteredClients = clients.filter(client => privateIPs.includes(client.ip));
    const macAddresses = filteredClients.map(client => client.mac);
  
    console.log("🎯 Matched MAC Addresses:", macAddresses);
    return macAddresses;
  }

  async function createVouchers(duration = 10) {
    const cookie = await login();
    try {
        // Try using the stat/voucher endpoint first
        const response = await api.post(
            "/cmd/hotspot",
            {
                cmd: "create-voucher",
                expire: duration,
                expire_number: 1,
                expire_unit: 1,         // 1=minutes
                n: 1,                   // Create one voucher
                quota: 1,              // Single use
                note: "Hotspot Auth",  // Note for identification
                up: null,              // No upload limit
                down: null,            // No download limit
                bytes: null,           // No data limit
                for_hotspot: true      // Critical: Must be true
            },
            { 
                headers: { 
                    Cookie: cookie,
                    'Content-Type': 'application/json'
                } 
            }
        );
        
        console.log("Voucher creation response:", JSON.stringify(response.data, null, 2));

        // If successful, immediately get the newly created voucher
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
  // Retrieve Vouchers Function
  async function getVouchers() {
    const cookie = await login();
    if (!cookie) return [];
  
    try {
      const response = await api.get("/stat/voucher", {
        headers: { Cookie: cookie },
      });
  
      console.log("🚀 Raw Voucher Response:", JSON.stringify(response.data, null, 2));
  
      return response.data.data || []; // Ensure we return an array
    } catch (error) {
      console.error("❌ Failed to retrieve vouchers:", error.response?.data || error.message);
      return [];
    }
  }

  // Authorize a client with an available 10-minute voucher
  async function authorizeClient(mac) {
    const cookie = await login();
    if (!cookie) {
        console.error("❌ Failed to retrieve session cookie.");
        return false;
    }

    try {
        // Get latest voucher
        const vouchers = await getVouchers();
        const latestVoucher = vouchers
            .sort((a, b) => b.create_time - a.create_time)[0];

        console.log("Using voucher:", JSON.stringify(latestVoucher, null, 2));

        // Use local controller format
        const payload = {
            cmd: "authorize-guest",
            mac: mac.toLowerCase(),
            voucher: latestVoucher.code,
            minutes: latestVoucher.duration
        };

        console.log("Authorization payload:", JSON.stringify(payload, null, 2));

        // Try the local controller endpoint
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
    
        console.log("Authorization response:", JSON.stringify(response.data, null, 2));

        if (response.data.meta?.rc === "ok") {
            console.log("✅ Authorization successful.");
            return true;
        } else {
            // Try alternative format if first attempt fails
            const altPayload = {
                cmd: "authorize-guest",
                mac: mac.toLowerCase(),
                voucher_code: latestVoucher.code  // Try alternate parameter name
            };

            console.log("Trying alternative payload:", JSON.stringify(altPayload, null, 2));

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

            console.log("Alternative response:", JSON.stringify(altResponse.data, null, 2));
            
            if (altResponse.data.meta?.rc === "ok") {
                console.log("✅ Authorization successful with alternative endpoint.");
                return true;
            }

            console.error("❌ Authorization failed with both attempts");
            return false;
        }
    } catch (error) {
        console.error("❌ Error during authorization:", 
            error.response?.data || error.message);
        return false;
    }
}
// API Route: Authenticate and check internet access
app.get("/auth", async (req, res) => {
    try {
      const macAddresses = await getMacAddressesForPrivateIPs();
      if (macAddresses.length === 0) {
        return res.status(404).json({ success: false, message: "No matching MAC addresses found." });
      }
  
      const mac = macAddresses[0];
      console.log(mac)
      const authorized = await authorizeClient(mac);
  
       if (!authorized) {
        return res.status(500).json({ success: false, message: "Client authorization failed." });
      }
  
     const internetAccess = await testInternetConnection();
      res.json({ success: true, mac, internetAccess });
    } catch (error) {
      console.error("Error in /auth-client:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }
  });



  


  
  // Logout Function
//   async function logout(cookie) {
//     try {
//       await api.get("/logout", { headers: { Cookie: cookie } });
//       console.log("Logged out successfully.");
//     } catch (error) {
//       console.error("Logout failed:", error.response?.data || error.message);
//     }
//   }
 


  

(async () => {
    // const cookie = await login();
    //await getVouchers();
    //  await getConnectedClients(cookie)
    //  await findClientMac(cookie) 
    //await getClients()
    //await getMacAddressesForPrivateIPs()
  })();

// Start Server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
