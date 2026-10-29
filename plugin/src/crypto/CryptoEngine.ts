/**
 * Zero-Knowledge End-to-End Encryption Engine for Obsidian Cloudflare Sync.
 *
 * STRICTLY 100% Native Web Crypto API (window.crypto.subtle).
 * Zero Node.js built-ins (no 'crypto', no 'buffer', no 'stream').
 */

/**
 * Fast chunk-based Base64 encoder safe for large binary arrays without stack overflow.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 0x2000; // 8KB chunks (safe for all JavaScript engines / call stack limits)
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Fast Base64 decoder returning a Uint8Array, safe against whitespace / line breaks.
 */
export function base64ToUint8Array(b64: string): Uint8Array {
  const sanitized = b64.replace(/\s+/g, "");
  const binary = atob(sanitized);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert ArrayBuffer or Uint8Array to a lowercase hex string.
 */
export function bufferToHex(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(
          buffer instanceof ArrayBuffer ? buffer : buffer.buffer,
          buffer instanceof ArrayBuffer ? 0 : buffer.byteOffset,
          buffer.byteLength
        );
  const hexParts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hexParts.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return hexParts.join("");
}

export class CryptoEngine {
  private aesKey: CryptoKey | null = null;
  private hmacKey: CryptoKey | null = null;
  private isInitialized = false;

  /**
   * Derive AES-256-GCM and HMAC-SHA-256 keys from user passphrase and deterministic salt.
   *
   * Salt: SHA-256("obsidian-cf-sync:" + vaultId)
   * PBKDF2: 100,000 iterations of SHA-256 deriving 512 bits:
   *  - 0..31: AES-256-GCM encryption key
   *  - 32..63: HMAC-SHA-256 path & opaque hash key
   */
  async deriveKeys(passphrase: string, vaultId: string): Promise<void> {
    if (!passphrase || !vaultId) {
      throw new Error("Passphrase and Vault ID are both required for key derivation.");
    }

    const encoder = new TextEncoder();

    // 1. Compute deterministic salt: SHA-256("obsidian-cf-sync:" + vaultId)
    const saltInput = encoder.encode(`obsidian-cf-sync:${vaultId}`);
    const saltBuffer = await window.crypto.subtle.digest("SHA-256", saltInput);

    // 2. Import raw passphrase as PBKDF2 key material
    const baseKey = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );

    // 3. Derive 512 bits (64 bytes)
    const derivedBits = await window.crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: saltBuffer,
        iterations: 100000,
        hash: "SHA-256",
      },
      baseKey,
      512
    );

    // 4. Split 512 bits: 256 bits for AES-256-GCM, 256 bits for HMAC-SHA-256
    // Use .slice() to create independent ArrayBuffers with byteOffset === 0 (avoids WebKit/iOS JSCore offset bugs)
    const aesKeyBytes = derivedBits.slice(0, 32);
    const hmacKeyBytes = derivedBits.slice(32, 64);

    this.aesKey = await window.crypto.subtle.importKey(
      "raw",
      aesKeyBytes,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );

    this.hmacKey = await window.crypto.subtle.importKey(
      "raw",
      hmacKeyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    this.isInitialized = true;
  }

  /**
   * Check if keys have been derived
   */
  hasKeys(): boolean {
    return this.isInitialized && this.aesKey !== null && this.hmacKey !== null;
  }

  private assertReady(): { aesKey: CryptoKey; hmacKey: CryptoKey } {
    if (!this.aesKey || !this.hmacKey || !this.isInitialized) {
      throw new Error("CryptoEngine is not initialized. Call deriveKeys() first.");
    }
    return { aesKey: this.aesKey, hmacKey: this.hmacKey };
  }

  /**
   * Helper to safely convert ArrayBuffer or ArrayBufferView to concrete ArrayBuffer
   */
  private toArrayBuffer(input: ArrayBuffer | ArrayBufferView): ArrayBuffer {
    if (input instanceof ArrayBuffer) {
      return input;
    }
    const view = new Uint8Array(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }

  /**
   * Encrypt raw binary ArrayBuffer or ArrayBufferView using AES-256-GCM.
   * Format: [12-byte random IV] + [AES-256-GCM Ciphertext + 16-byte Tag]
   */
  async encryptBytes(plain: ArrayBuffer | ArrayBufferView): Promise<Uint8Array> {
    const { aesKey } = this.assertReady();
    const plainBuffer = this.toArrayBuffer(plain);

    // Generate 12-byte random IV
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    const ciphertextBuffer = await window.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      aesKey,
      plainBuffer
    );

    // Concatenate IV + Ciphertext
    const combined = new Uint8Array(12 + ciphertextBuffer.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertextBuffer), 12);

    return combined;
  }

  /**
   * Decrypt [12-byte IV + Ciphertext] payload using AES-256-GCM.
   */
  async decryptBytes(payload: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
    const { aesKey } = this.assertReady();
    const buffer = this.toArrayBuffer(payload);

    if (buffer.byteLength < 28) {
      // 12 bytes IV + 16 bytes GCM Auth Tag minimum
      throw new Error("Payload too short to contain valid IV and AES-GCM auth tag.");
    }

    const iv = new Uint8Array(buffer, 0, 12);
    const ciphertext = new Uint8Array(buffer, 12);

    return await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      aesKey,
      ciphertext
    );
  }

  /**
   * Encrypt a string (e.g., relativePath) and return Base64 string
   */
  async encryptString(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const plainBytes = encoder.encode(text);
    const encryptedBytes = await this.encryptBytes(plainBytes);
    return uint8ArrayToBase64(encryptedBytes);
  }

  /**
   * Decrypt a Base64 string into a UTF-8 string
   */
  async decryptString(b64: string): Promise<string> {
    const encryptedBytes = base64ToUint8Array(b64);
    const decryptedBuffer = await this.decryptBytes(encryptedBytes);
    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
  }

  /**
   * Compute deterministic file ID: HMAC-SHA256(masterSecret, normalizePath(relativePath))
   * Returns a 64-character lowercase hex string.
   */
  async computeFileId(normalizedPath: string): Promise<string> {
    const { hmacKey } = this.assertReady();
    const encoder = new TextEncoder();
    const signature = await window.crypto.subtle.sign(
      "HMAC",
      hmacKey,
      encoder.encode(normalizedPath)
    );
    return bufferToHex(signature);
  }

  /**
   * Compute opaque hash for server-side deduplication and echo suppression.
   * HMAC-SHA256(masterSecret, SHA-256(plaintextBuffer))
   * Returns a 64-character lowercase hex string.
   */
  async computeOpaqueHash(plainBuffer: ArrayBuffer | ArrayBufferView): Promise<string> {
    const { hmacKey } = this.assertReady();
    const buffer = this.toArrayBuffer(plainBuffer);

    // 1. Hash content
    const sha256Buffer = await window.crypto.subtle.digest("SHA-256", buffer);

    // 2. HMAC the hash to prevent leaking plaintext digest to Cloudflare
    const hmacBuffer = await window.crypto.subtle.sign(
      "HMAC",
      hmacKey,
      sha256Buffer
    );

    return bufferToHex(hmacBuffer);
  }
}
