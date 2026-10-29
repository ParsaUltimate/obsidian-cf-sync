# ⚡ Obsidian Cloudflare E2EE Real-Time Sync

<div align="center">

**A Production-Grade, Zero-Knowledge End-to-End Encrypted (E2EE), Real-Time Synchronization Engine for Obsidian**  
*Operating 100% within the Cloudflare Free Tier across Desktop (macOS, Windows, Linux) and Mobile (iOS & Android).*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Obsidian](https://img.shields.io/badge/Platform-Obsidian%20(Desktop%20%7C%20iOS%20%7C%20Android)-purple.svg)](https://obsidian.md)
[![Backend: Cloudflare](https://img.shields.io/badge/Backend-Workers%20%2B%20SQLite%20DO%20%2B%20R2-F38020.svg?logo=cloudflare&logoColor=white)](https://cloudflare.com)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Security: E2EE](https://img.shields.io/badge/Security-Zero--Knowledge%20E2EE-success.svg)](#-zero-knowledge-e2ee-cryptography)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/ParsaUltimate/obsidian-cf-sync/pulls)

[Key Features](#-key-features) • [Comparison](#-comparison-with-alternatives) • [Architecture](#-architecture--wire-protocol) • [Cloudflare Setup](#-deployment-guide-cloudflare-backend) • [Plugin Installation](#-plugin-installation-desktop--mobile) • [FAQ](#-frequently-asked-questions)

</div>

---

## 💡 Why This Project?

Official Obsidian Sync is fantastic, but at **$4–$8/month per user**, costs compound over time. Existing self-hosted alternatives often fall short:
- **CouchDB / LiveSync**: Demands managing VPS servers, dealing with disk ballooning, complex CouchDB replication bugs, and continuous compute charges.
- **Remotely Save (S3 / WebDAV)**: Relies on slow, batch-polling schedules rather than real-time signaling, leading to silent file overwrites and battery drain on mobile.

**Obsidian Cloudflare E2EE Sync** provides a **zero-maintenance, zero-server-cost, real-time alternative** by combining:
1. **Cloudflare SQLite Durable Objects (`new_sqlite_classes`)**: Instant, atomic file revision tracking with single-digit millisecond latency on the Free Tier.
2. **WebSocket Hibernation API**: Keeps connected devices synced in real time while consuming **0 ms of billable CPU duration** when idle.
3. **Cloudflare R2 Object Storage**: Fast encrypted binary payload storage with **$0 egress fees** and **zero R2 `LIST` operations** (queries are answered directly by SQLite).
4. **100% Native Web Crypto API**: Client-side Zero-Knowledge encryption that runs safely in browser and mobile Capacitor WebViews without any Node.js dependencies.

---

## 📊 Comparison with Alternatives

| Feature | Official Obsidian Sync | Self-Hosted LiveSync (CouchDB) | Remotely Save (S3 / WebDAV) | **Obsidian Cloudflare Sync (This Project)** |
|:---|:---:|:---:|:---:|:---:|
| **Cost** | $4 – $8 / month | VPS Hosting (~$5/mo) | S3 Storage / Free Tier | **100% Free Tier ($0/mo)** |
| **Real-Time Push (WebSockets)** | ✅ Yes | ✅ Yes | ❌ Polling only | **✅ Yes (WebSocket Hibernation)** |
| **Zero Idle Server Cost** | N/A (SaaS) | ❌ 24/7 VPS uptime cost | ✅ Serverless | **✅ $0 (0 ms billable idle CPU)** |
| **End-to-End Encryption** | ✅ Yes | ✅ Yes | ⚠️ Optional / Password | **✅ Zero-Knowledge AES-256-GCM** |
| **Mobile Support (iOS / Android)** | ✅ Native | ⚠️ High Memory / Crashes | ✅ Yes | **✅ 100% Native Web APIs (0 Node.js)** |
| **R2 / S3 Egress & LIST Fees** | Included | N/A | ⚠️ Incurs S3 Class A fees | **✅ $0 Egress & $0 LIST Fees** |
| **Setup Complexity** | None (Paid) | High (Docker, SSL, CouchDB) | Medium (S3 buckets, IAM) | **Low (Single `wrangler deploy`)** |

---

## ✨ Key Features

- 🔒 **Zero-Knowledge End-to-End Encryption:** Your master passphrase derives a 256-bit encryption key locally via **PBKDF2 with 100,000 SHA-256 iterations**. File content, relative folder paths, and revision metadata are encrypted with **AES-256-GCM**. Cloudflare never sees plaintext names or note contents.
- 📱 **100% Mobile Compatible:** Zero Node.js built-ins (`fs`, `crypto`, `path`, `stream`, `Buffer`). Uses strictly native browser standards: `window.crypto.subtle`, `Uint8Array`, `ArrayBuffer`, and `IndexedDB`. Certified on iOS and Android Capacitor WebViews.
- ⚡ **Real-Time Instant Sync:** Employs Cloudflare Durable Object WebSockets with automatic exponential backoff, heartbeat health checks (`PING`/`PONG`), and instant delta notifications.
- 🛡️ **Echo-Safe Mutex & Deterministic Conflict Handling:** In-memory echo suppression ledger prevents local write loops. Diverged concurrent edits are non-destructively preserved as `${fileName}.sync-conflict-YYYYMMDD-HHMMSS.${ext}` while applying authoritative remote revisions.
- 🚫 **Smart Path Ignore Engine:** Automatically filters `node_modules`, `.git`, `.DS_Store`, conflict copies, and volatile Obsidian cache files (`workspace.json`, `workspace-mobile.json`, `graph.json`, `backlink.json`) to prevent sync storms.
- ⚡ **High-Performance Vault Scanner:** Directory-by-directory traversal using `adapter.list()` short-circuits blacklisted folders at inspection without enumerating child files, ensuring near-instant startup even on vaults with 10,000+ files.
- 📲 **1-Click Mobile Pairing:** Command Palette feature **"Copy Vault Sync Credentials"** generates a base64 pairing string to paste into mobile settings.

---

## 🏛 Architecture & Wire Protocol

```text
+-------------------------------------------------------------------------------------------------------+
|                                           Obsidian Client                                             |
|                     (Desktop / iOS / Android via Capacitor WebView - Pure Web APIs)                   |
|                                                                                                       |
|  +-----------------------------+   +-----------------------------+   +-----------------------------+  |
|  |     CryptoEngine.ts         |   |         LocalDB.ts          |   |       SyncEngine.ts         |  |
|  |  PBKDF2-SHA256 (100k iter)  |   | Native IndexedDB:           |   | - 1000ms debounce           |  |
|  |  AES-256-GCM / HMAC-SHA256  |   | - files_state (rev, hash)   |   | - Suppressed echo mutex     |  |
|  |  Zero Node 'crypto'/'Buffer'|   | - outbound_queue (offline)  |   | - Smart path ignore engine  |  |
|  |  JSCore 8KB safe chunking   |   | - sync_meta (last_rev)      |   | - LWW conflict resolver     |  |
|  +--------------+--------------+   +--------------+--------------+   +--------------+--------------+  |
+-----------------|---------------------------------|---------------------------------|-----------------+
                  |                                 |                                 |
                  | Encrypted Binary Blob           |                                 | WebSocket Signaling
                  | PUT /api/vault/:vaultId/blob    |                                 | PUSH_META / PULL_DELTA
                  v                                 |                                 v
   +------------------------------+                 |                  +------------------------------+
   |     Cloudflare R2 Bucket     |                 |                  |  Cloudflare Worker + DO      |
   |      (env.VAULT_BUCKET)      |                 |                  |       (VaultSyncDO)          |
   |                              |                 |                  |                              |
   | - Key: ${vaultId}/${fileId}  |                 |                  | - SQLite Storage Backend     |
   | - [12B IV + AES-GCM Cipher]  |                 |                  | - WebSocket Hibernation API  |
   | - Pre-checked via X-Base-Rev |                 |                  |   (0 ms idle billable CPU)   |
   | - $0 Egress & $0 LIST fees   |                 |                  | - Monotonic rev counter      |
   +------------------------------+                 +----------------->+ - 250-record delta chunking  |
                                                                       +------------------------------+
```

### Cryptographic Specification
1. **Key Derivation:** Master secret derived via PBKDF2 (`SHA-256`, 100,000 iterations) using salt `SHA-256("obsidian-cf-sync:" + vaultId)`.
2. **File ID (`fileId`):** `HMAC-SHA256(masterSecret, normalizePath(relativePath))` encoded as 64-character hex. Serves as primary key in SQLite and R2 object key.
3. **Encrypted Path:** Base64-encoded `AES-256-GCM` ciphertext of the UTF-8 relative path.
4. **Encrypted Blob (R2):** `[12 Bytes: Random IV] + [N Bytes: Ciphertext + 16B GCM Auth Tag]`.
5. **Opaque Content Hash:** `HMAC-SHA256(masterSecret, SHA256(rawContent))` prevents leaking plaintext hashes to Cloudflare.

---

## 🚀 Deployment Guide (Cloudflare Backend)

### Prerequisites
- [Node.js](https://nodejs.org/) v18+
- A free [Cloudflare Account](https://dash.cloudflare.com/)
- Cloudflare Wrangler CLI authenticated on your machine

### 1. Clone & Install Backend
```bash
git clone https://github.com/ParsaUltimate/obsidian-cf-sync.git
cd obsidian-cf-sync/backend
npm install
```

### 2. Create the Free R2 Storage Bucket
```bash
npx wrangler r2 bucket create obsidian-sync-blobs
```

### 3. Set the Secret Authentication Token
```bash
npx wrangler secret put AUTH_SECRET
```
*Enter a strong random token (e.g. generated via `openssl rand -hex 32`).*

### 4. Deploy Worker & Durable Object
```bash
npx wrangler deploy
```

Upon completion, Wrangler outputs your Worker URL:
```text
Published obsidian-realtime-sync (X.XX sec)
  https://obsidian-realtime-sync.<your-subdomain>.workers.dev
```

### 5. Verify Health Endpoint
```bash
curl https://obsidian-realtime-sync.<your-subdomain>.workers.dev/health
# Response: {"status":"healthy","service":"obsidian-cf-sync","timestamp":...}
```

---

## 💻 Plugin Installation (Desktop & Mobile)

### Building the Plugin
```bash
cd obsidian-cf-sync/plugin
npm install
npm run build
```
This generates the standalone `main.js` bundle (76 KB) with zero external runtime dependencies.

### Installation into Obsidian Desktop
1. In Obsidian, go to **Settings → Community Plugins** and disable **Restricted Mode**.
2. Navigate to your vault folder on disk: `<YourVault>/.obsidian/plugins/`.
3. Create a folder named `obsidian-cf-sync`:
   ```bash
   mkdir -p "<path-to-vault>/.obsidian/plugins/obsidian-cf-sync"
   ```
4. Copy `manifest.json`, `main.js`, and `styles.css` into that directory.
5. In Obsidian, reload plugins and toggle on **Cloudflare E2EE Sync**.

### Configuration
1. Open **Settings → Cloudflare E2EE Sync**.
2. Fill in:
   - **Cloudflare Worker URL:** `https://obsidian-realtime-sync.<your-subdomain>.workers.dev`
   - **Vault Identifier:** A unique name (e.g. `work-vault`)
   - **Authentication Secret:** The token set in `wrangler secret put AUTH_SECRET`
   - **E2EE Passphrase:** Your confidential encryption passphrase
   - **Device Name:** E.g. `MacBook Pro` or `Desktop PC`
3. Click **Test Connection** to verify health and authentication.
4. Click **Sync Now** to perform your initial sync!

### 📲 Quick Mobile Pairing (iOS & Android)
1. On your configured desktop, run **"Copy Vault Sync Credentials"** from the Command Palette (`Ctrl/Cmd + P`).
2. Copy the plugin files (`manifest.json`, `main.js`, `styles.css`) into your mobile vault's `.obsidian/plugins/obsidian-cf-sync/` folder.
3. Open Obsidian on iOS or Android, enable **Cloudflare E2EE Sync**, navigate to its Settings, paste the code into **Import Sync Setup Code**, and tap **Import**.

---

## 🧪 Testing & Verification

The project includes end-to-end automated testing suites covering backend concurrency and client cryptography:

```bash
# Run typechecking
npm --prefix backend run typecheck
npm --prefix plugin run typecheck

# Run backend SQLite DO & R2 concurrency tests
node backend-test.mjs

# Run Web Crypto E2EE, byteOffset safety, and path ignore unit tests
node test-e2e.mjs
```

All tests execute cleanly:
- ✅ Zero Node.js built-ins in production bundle
- ✅ 100k PBKDF2 iterations and AES-256-GCM roundtrip
- ✅ Non-zero `byteOffset` TypedArray safety (WebKit / Capacitor guard)
- ✅ 100KB Base64 chunking without call stack overflow
- ✅ Atomic DO revision counter and optimistic concurrency conflict rejection
- ✅ Idempotent tombstone recreation (`baseRev: 0` on deleted records)
- ✅ Directory-level short-circuiting on `node_modules` and `.git`

---

## ❓ Frequently Asked Questions

<details>
<summary><b>Is this truly 100% free forever?</b></summary>
Yes. Cloudflare's Free Tier includes:
- <b>Workers:</b> 100,000 requests/day.
- <b>Durable Objects:</b> 100,000 requests/day, embedded SQLite storage, and 0 ms billable wall-clock time for hibernated WebSockets.
- <b>R2 Storage:</b> 10 GB storage free, 10,000,000 Class B read requests/month, 1,000,000 Class A write requests/month, and <b>$0 egress fees</b>.
For personal notes, this easily accommodates years of sync activity without touching billing limits.
</details>

<details>
<summary><b>Can Cloudflare read my files or note titles?</b></summary>
No. The system uses client-side Zero-Knowledge End-to-End Encryption. Content is encrypted with AES-256-GCM before leaving your device. File paths are encrypted with AES-256-GCM. File IDs and content hashes are blinded using HMAC-SHA-256. The server only sees encrypted bytes and hex hashes.
</details>

<details>
<summary><b>What happens if I edit the same note on two devices while offline?</b></summary>
When both devices reconnect, the first device commits normally. The second device's commit is flagged as a conflict. The plugin automatically duplicates the local diverged version to <code>${fileName}.sync-conflict-${timestamp}.${ext}</code> and downloads the authoritative remote version, ensuring zero data loss.
</details>

---

## 📄 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more details.

---

<div align="center">
Built with ❤️ for the Obsidian Community by <a href="https://github.com/ParsaUltimate">Parsa Ultimate</a>.
</div>
