/**
 * Binary Data Plane HTTP Client for Cloudflare R2 Blob Storage.
 *
 * Utilizes Obsidian's native requestUrl with transparent fallback to window.fetch.
 * Strictly zero Node.js networking modules (no 'http', 'https', or 'stream').
 */

import { requestUrl } from "obsidian";

export class BlobClient {
  private workerUrl: string;
  private authToken: string;

  constructor(workerUrl: string, authToken: string) {
    this.workerUrl = workerUrl.replace(/\/+$/, "");
    this.authToken = authToken.trim();
  }

  /**
   * Update configuration parameters dynamically
   */
  updateConfig(workerUrl: string, authToken: string): void {
    this.workerUrl = workerUrl.replace(/\/+$/, "");
    this.authToken = authToken.trim();
  }

  /**
   * Upload encrypted binary payload to Cloudflare R2
   */
  async uploadBlob(
    vaultId: string,
    fileId: string,
    encryptedBytes: Uint8Array,
    baseRev?: number
  ): Promise<void> {
    const url = `${this.workerUrl}/api/vault/${encodeURIComponent(vaultId)}/blob/${encodeURIComponent(fileId)}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      "Content-Type": "application/octet-stream",
    };

    if (baseRev !== undefined) {
      headers["X-Base-Rev"] = String(baseRev);
    }

    // Safely extract the exact ArrayBuffer slice without extra pool padding
    const payloadBuffer =
      encryptedBytes.byteOffset === 0 &&
      encryptedBytes.byteLength === encryptedBytes.buffer.byteLength
        ? encryptedBytes.buffer
        : encryptedBytes.buffer.slice(
            encryptedBytes.byteOffset,
            encryptedBytes.byteOffset + encryptedBytes.byteLength
          );

    // Attempt Obsidian's requestUrl first (handles mobile native requests seamlessly)
    if (typeof requestUrl === "function") {
      const response = await requestUrl({
        url,
        method: "PUT",
        headers,
        body: payloadBuffer as ArrayBuffer,
        throw: false,
      });

      if (response.status === 409) {
        throw new Error("CONFLICT_409");
      }

      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `Failed to upload R2 blob [HTTP ${response.status}]: ${response.text || "Unknown error"}`
        );
      }
      return;
    }

    // Fallback to standard window.fetch
    const fetchResponse = await window.fetch(url, {
      method: "PUT",
      headers,
      body: payloadBuffer as ArrayBuffer,
    });

    if (fetchResponse.status === 409) {
      throw new Error("CONFLICT_409");
    }

    if (!fetchResponse.ok) {
      const errText = await fetchResponse.text();
      throw new Error(
        `Failed to upload R2 blob [HTTP ${fetchResponse.status}]: ${errText || "Unknown error"}`
      );
    }
  }

  /**
   * Download encrypted binary payload from Cloudflare R2
   */
  async downloadBlob(vaultId: string, fileId: string): Promise<ArrayBuffer> {
    const url = `${this.workerUrl}/api/vault/${encodeURIComponent(vaultId)}/blob/${encodeURIComponent(fileId)}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
    };

    if (typeof requestUrl === "function") {
      const response = await requestUrl({
        url,
        method: "GET",
        headers,
        throw: false,
      });

      if (response.status === 404) {
        throw new Error(`Blob not found in R2 for fileId: ${fileId}`);
      }

      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `Failed to download R2 blob [HTTP ${response.status}]: ${response.text || "Unknown error"}`
        );
      }

      return response.arrayBuffer;
    }

    const fetchResponse = await window.fetch(url, {
      method: "GET",
      headers,
    });

    if (fetchResponse.status === 404) {
      throw new Error(`Blob not found in R2 for fileId: ${fileId}`);
    }

    if (!fetchResponse.ok) {
      const errText = await fetchResponse.text();
      throw new Error(
        `Failed to download R2 blob [HTTP ${fetchResponse.status}]: ${errText || "Unknown error"}`
      );
    }

    return await fetchResponse.arrayBuffer();
  }

  /**
   * Delete binary payload from Cloudflare R2
   */
  async deleteBlob(vaultId: string, fileId: string): Promise<void> {
    const url = `${this.workerUrl}/api/vault/${encodeURIComponent(vaultId)}/blob/${encodeURIComponent(fileId)}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
    };

    if (typeof requestUrl === "function") {
      const response = await requestUrl({
        url,
        method: "DELETE",
        headers,
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `Failed to delete R2 blob [HTTP ${response.status}]: ${response.text || "Unknown error"}`
        );
      }
      return;
    }

    const fetchResponse = await window.fetch(url, {
      method: "DELETE",
      headers,
    });

    if (!fetchResponse.ok) {
      const errText = await fetchResponse.text();
      throw new Error(
        `Failed to delete R2 blob [HTTP ${fetchResponse.status}]: ${errText || "Unknown error"}`
      );
    }
  }
}
