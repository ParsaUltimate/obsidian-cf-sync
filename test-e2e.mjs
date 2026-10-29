/**
 * Automated Verification Script for obsidian-cf-sync
 *
 * Tests:
 * 1. Checks that the bundled plugin main.js contains 0 node built-ins
 * 2. Tests the CryptoEngine algorithms with Web Crypto API:
 *    - Key derivation via PBKDF2 (100,000 iterations)
 *    - AES-256-GCM encryption and decryption roundtrip
 *    - Base64 encoding/decoding
 *    - File ID HMAC calculation
 *    - Content opaque hash calculation
 */

import fs from "node:fs";
import path from "node:path";

// In Node 20+, globalThis.crypto is the Web Crypto API
if (typeof window === "undefined") {
  globalThis.window = {
    crypto: globalThis.crypto,
  };
}

async function runTests() {
  console.log("=== 1. Checking Plugin Bundle for Node.js Built-ins ===");
  const bundlePath = path.resolve("plugin/main.js");
  if (!fs.existsSync(bundlePath)) {
    throw new Error("main.js does not exist!");
  }

  const bundle = fs.readFileSync(bundlePath, "utf8");
  const forbiddenModules = ["fs", "crypto", "path", "stream", "os", "http", "buffer"];
  for (const mod of forbiddenModules) {
    const pattern1 = `require("${mod}")`;
    const pattern2 = `require('${mod}')`;
    if (bundle.includes(pattern1) || bundle.includes(pattern2)) {
      throw new Error(`Forbidden Node module found in bundle: ${mod}`);
    }
  }
  console.log("✓ PASS: Bundle contains ZERO Node.js built-in requirements.");
  console.log(`✓ Bundle Size: ${(bundle.length / 1024).toFixed(1)} KB`);

  console.log("\n=== 2. Testing CryptoEngine with Web Crypto API ===");

  // Mock TextEncoder / TextDecoder if needed (standard in Node)
  const { CryptoEngine, uint8ArrayToBase64, base64ToUint8Array, bufferToHex } = await import(
    "./plugin/src/crypto/CryptoEngine.ts"
  );

  const engine = new CryptoEngine();
  const testPassphrase = "correct horse battery staple 1234!";
  const testVaultId = "my-secret-vault";

  console.log("• Deriving keys (100k PBKDF2 iterations)...");
  const startDerive = Date.now();
  await engine.deriveKeys(testPassphrase, testVaultId);
  console.log(`✓ Keys derived in ${Date.now() - startDerive}ms`);

  // Test String Encryption / Decryption
  console.log("• Testing string encryption & decryption (relative path)...");
  const samplePath = "Personal/Journal/2026-10-22.md";
  const encryptedPath = await engine.encryptString(samplePath);
  const decryptedPath = await engine.decryptString(encryptedPath);
  if (decryptedPath !== samplePath) {
    throw new Error(`Path roundtrip failed! Expected ${samplePath}, got ${decryptedPath}`);
  }
  console.log(`✓ Path encrypted to Base64: ${encryptedPath}`);
  console.log(`✓ Path successfully decrypted: ${decryptedPath}`);

  // Test Binary Data Encryption / Decryption
  console.log("• Testing binary payload encryption & decryption (AES-256-GCM)...");
  const testContent = "Hello from Obsidian E2EE Sync on Cloudflare Free Tier! 🚀\n" + "x".repeat(5000);
  const plainBytes = new TextEncoder().encode(testContent);
  const encryptedBytes = await engine.encryptBytes(plainBytes.buffer);

  // Check IV prefix (12 bytes) + GCM Tag (16 bytes)
  if (encryptedBytes.byteLength !== plainBytes.byteLength + 12 + 16) {
    throw new Error(
      `Ciphertext size mismatch: expected ${plainBytes.byteLength + 28}, got ${encryptedBytes.byteLength}`
    );
  }

  const decryptedBuffer = await engine.decryptBytes(encryptedBytes.buffer);
  const decryptedText = new TextDecoder().decode(decryptedBuffer);
  if (decryptedText !== testContent) {
    throw new Error("Binary payload roundtrip failed! Decrypted text does not match original.");
  }
  console.log(`✓ Binary encryption roundtrip PASSED (${plainBytes.byteLength} bytes)`);

  // Test File ID HMAC
  console.log("• Testing deterministic fileId HMAC...");
  const fileId1 = await engine.computeFileId(samplePath);
  const fileId2 = await engine.computeFileId(samplePath);
  const fileIdDifferent = await engine.computeFileId(samplePath + "2");
  if (fileId1 !== fileId2) {
    throw new Error("FileId is not deterministic!");
  }
  if (fileId1 === fileIdDifferent) {
    throw new Error("FileId collision on different path!");
  }
  if (fileId1.length !== 64) {
    throw new Error(`FileId length is not 64 hex characters: ${fileId1.length}`);
  }
  console.log(`✓ File ID HMAC: ${fileId1} (64 hex characters)`);

  // Test Opaque Hash
  console.log("• Testing opaque content hash...");
  const hash1 = await engine.computeOpaqueHash(plainBytes.buffer);
  const hash2 = await engine.computeOpaqueHash(plainBytes.buffer);
  const hashDifferent = await engine.computeOpaqueHash(new TextEncoder().encode("Different").buffer);
  if (hash1 !== hash2) {
    throw new Error("Opaque hash is not deterministic!");
  }
  if (hash1 === hashDifferent) {
    throw new Error("Opaque hash collision on different content!");
  }
  console.log(`✓ Content Opaque Hash: ${hash1}`);

  // Test Utilities
  console.log("• Testing Base64 & Hex utilities...");
  const sampleBin = new Uint8Array([0, 255, 128, 42, 64, 127]);
  const b64 = uint8ArrayToBase64(sampleBin);
  const restoredBin = base64ToUint8Array(b64);
  for (let i = 0; i < sampleBin.length; i++) {
    if (sampleBin[i] !== restoredBin[i]) {
      throw new Error("Base64 roundtrip failed for binary sample!");
    }
  }

  // Test Base64 decoding with whitespace and linebreaks
  const b64WithSpaces = "  " + b64.substring(0, 4) + "\n\t" + b64.substring(4) + " \r\n";
  const restoredFromSpaces = base64ToUint8Array(b64WithSpaces);
  if (restoredFromSpaces.length !== sampleBin.length || restoredFromSpaces[0] !== sampleBin[0]) {
    throw new Error("Base64 decoding failed on string with whitespace!");
  }
  console.log("✓ Base64 whitespace tolerance verified");

  const hex = bufferToHex(sampleBin);
  if (hex !== "00ff802a407f") {
    throw new Error(`Hex conversion failed! Got: ${hex}`);
  }
  console.log("✓ Utilities PASSED");

  // Test 3: Non-zero byteOffset TypedArray safety (pool / subarray test)
  console.log("\n=== 3. Testing Non-Zero ByteOffset TypedArray Safety ===");
  const bigBuffer = new Uint8Array(100);
  bigBuffer.fill(99);
  const slicedView = bigBuffer.subarray(20, 60); // 40 bytes with byteOffset: 20
  slicedView.fill(42);

  const encView = await engine.encryptBytes(slicedView);
  const decView = await engine.decryptBytes(encView);
  const decBytes = new Uint8Array(decView);
  if (decBytes.byteLength !== 40 || decBytes[0] !== 42 || decBytes[39] !== 42) {
    throw new Error("Non-zero byteOffset encryption roundtrip failed!");
  }
  console.log("✓ Non-zero byteOffset encryption roundtrip PASSED");

  const hashFromView = await engine.computeOpaqueHash(slicedView);
  const independentBuffer = new Uint8Array(40);
  independentBuffer.fill(42);
  const hashFromIndependent = await engine.computeOpaqueHash(independentBuffer);
  if (hashFromView !== hashFromIndependent) {
    throw new Error("Hash of subarray does not match hash of independent buffer!");
  }
  console.log("✓ Opaque hash from subarray with non-zero byteOffset matches independent buffer");

  // Test 4: Large Binary (100KB) Base64 Chunking Test
  console.log("\n=== 4. Testing 100KB Large Payload Base64 Chunking ===");
  const largeArray = new Uint8Array(100 * 1024);
  for (let i = 0; i < largeArray.length; i++) largeArray[i] = i % 256;
  const largeB64 = uint8ArrayToBase64(largeArray);
  const restoredLarge = base64ToUint8Array(largeB64);
  if (restoredLarge.byteLength !== largeArray.byteLength || restoredLarge[50000] !== largeArray[50000]) {
    throw new Error("Large 100KB Base64 roundtrip failed!");
  }
  console.log(`✓ 100KB payload successfully encoded to ${largeB64.length} Base64 chars without call stack overflow`);

  // Test 5: Multi-Layer Path Ignore Engine & Recursive Vault Scanner
  console.log("\n=== 5. Testing Multi-Layer Path Ignore Engine & Scanner ===");
  const { createRequire } = await import("module");
  const requireModule = createRequire(path.resolve("plugin/package.json"));
  const { SyncEngine, DEFAULT_SETTINGS } = requireModule("./main.js");

  // Create a minimal mock SyncEngine instance to test shouldIgnorePath
  const mockEngine = Object.create(SyncEngine.prototype);
  mockEngine.settings = { ...DEFAULT_SETTINGS, syncConflictFiles: false };

  // Rule checks required by specification:
  const test1 = mockEngine.shouldIgnorePath("obsidian-cf-sync/plugin/node_modules/esbuild/bin/esbuild");
  if (test1 !== true) {
    throw new Error(`Expected true for obsidian-cf-sync/plugin/node_modules/esbuild/bin/esbuild, got ${test1}`);
  }
  console.log('✓ shouldIgnorePath("obsidian-cf-sync/plugin/node_modules/esbuild/bin/esbuild") === true');

  const test2 = mockEngine.shouldIgnorePath("Projects/my-app/node_modules/pkg/index.js");
  if (test2 !== true) {
    throw new Error(`Expected true for Projects/my-app/node_modules/pkg/index.js, got ${test2}`);
  }
  console.log('✓ shouldIgnorePath("Projects/my-app/node_modules/pkg/index.js") === true');

  const test3 = mockEngine.shouldIgnorePath(".obsidian/workspace-mobile.json");
  if (test3 !== true) {
    throw new Error(`Expected true for .obsidian/workspace-mobile.json, got ${test3}`);
  }
  console.log('✓ shouldIgnorePath(".obsidian/workspace-mobile.json") === true');

  const test4 = mockEngine.shouldIgnorePath("Daily Notes/2026-10-22.md");
  if (test4 !== false) {
    throw new Error(`Expected false for Daily Notes/2026-10-22.md, got ${test4}`);
  }
  console.log('✓ shouldIgnorePath("Daily Notes/2026-10-22.md") === false');

  // Verify Conflict File behavior toggle
  const testConflictDefault = mockEngine.shouldIgnorePath("Notes/MyNote.sync-conflict-20261022-120000.md");
  if (testConflictDefault !== true) {
    throw new Error(`Expected conflict file to be ignored by default, got ${testConflictDefault}`);
  }
  mockEngine.settings.syncConflictFiles = true;
  const testConflictAllowed = mockEngine.shouldIgnorePath("Notes/MyNote.sync-conflict-20261022-120000.md");
  if (testConflictAllowed !== false) {
    throw new Error(`Expected conflict file to NOT be ignored when syncConflictFiles: true, got ${testConflictAllowed}`);
  }
  mockEngine.settings.syncConflictFiles = false;
  console.log("✓ Conflict file ignore toggle verified");

  // Verify Recursive Vault Scanner skips node_modules at folder level
  console.log("• Testing recursive vault scanner short-circuiting on node_modules...");
  const listedDirectories = [];
  const enqueuedFiles = [];

  const mockFileSystem = {
    "": {
      folders: ["Daily Notes", "node_modules", ".git"],
      files: ["README.md"],
    },
    "Daily Notes": {
      folders: [],
      files: ["Daily Notes/2026-10-22.md"],
    },
    node_modules: {
      folders: ["node_modules/esbuild"],
      files: ["node_modules/package.json"],
    },
    ".git": {
      folders: [".git/objects"],
      files: [".git/HEAD"],
    },
  };

  mockEngine.crypto = {
    hasKeys: () => true,
  };
  mockEngine.app = {
    vault: {
      adapter: {
        list: async (dir) => {
          listedDirectories.push(dir);
          const entry = mockFileSystem[dir] || { folders: [], files: [] };
          return entry;
        },
        stat: async (file) => ({ mtime: 1000 }),
        exists: async (file) => true,
      },
    },
  };
  mockEngine.localDb = {
    getFileState: async (path) => null,
    getAllFileStates: async () => [],
  };
  mockEngine.enqueueLocalFile = async (path) => {
    enqueuedFiles.push(path);
  };
  mockEngine.scheduleDeletion = async (path) => {};

  await mockEngine.scanVaultForUnsyncedChanges();

  if (listedDirectories.includes("node_modules") || listedDirectories.includes(".git")) {
    throw new Error(
      `Recursive scanner did NOT short-circuit! Directories listed: ${JSON.stringify(listedDirectories)}`
    );
  }

  if (enqueuedFiles.includes("node_modules/package.json") || enqueuedFiles.includes(".git/HEAD")) {
    throw new Error(
      `Ignored files were enqueued: ${JSON.stringify(enqueuedFiles)}`
    );
  }

  if (!enqueuedFiles.includes("README.md") || !enqueuedFiles.includes("Daily Notes/2026-10-22.md")) {
    throw new Error(
      `Valid files were missed by scanner: ${JSON.stringify(enqueuedFiles)}`
    );
  }
  console.log("✓ Recursive scanner successfully skipped node_modules & .git without enumerating children");
  console.log(`✓ Directories visited: ${JSON.stringify(listedDirectories)}`);
  console.log(`✓ Valid files enqueued: ${JSON.stringify(enqueuedFiles)}`);

  console.log("\n==========================================");
  console.log("🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉");
  console.log("==========================================");
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
