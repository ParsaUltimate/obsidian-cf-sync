/**
 * Pure Native IndexedDB Storage Layer for Obsidian Cloudflare E2EE Sync.
 *
 * Zero external dependencies. Operates seamlessly on desktop and mobile Capacitor WebViews.
 */

import { LocalFileState, OutboundQueueItem } from "../types";

export class LocalDB {
  private db: IDBDatabase | null = null;
  private dbName: string = "obsidian_cf_sync_db";
  private isReady = false;

  /**
   * Open or upgrade the IndexedDB database for a specific vault
   */
  async init(vaultId: string): Promise<void> {
    const targetDbName = `obsidian_cf_sync_${vaultId}`;
    if (this.isReady && this.db && this.dbName === targetDbName) {
      return;
    }

    if (this.db) {
      this.close();
    }

    // Isolate databases per vault
    this.dbName = targetDbName;

    return new Promise<void>((resolve, reject) => {
      const request = window.indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Store 1: files_state (local sync ledger)
        if (!db.objectStoreNames.contains("files_state")) {
          const filesStore = db.createObjectStore("files_state", {
            keyPath: "path",
          });
          filesStore.createIndex("by_fileId", "fileId", { unique: false });
          filesStore.createIndex("by_rev", "rev", { unique: false });
        }

        // Store 2: outbound_queue (pending offline mutations)
        if (!db.objectStoreNames.contains("outbound_queue")) {
          const queueStore = db.createObjectStore("outbound_queue", {
            keyPath: "id",
          });
          queueStore.createIndex("by_path", "path", { unique: false });
          queueStore.createIndex("by_createdAt", "createdAt", { unique: false });
        }

        // Store 3: sync_meta (key-value metadata: last_rev, last_sync_time)
        if (!db.objectStoreNames.contains("sync_meta")) {
          db.createObjectStore("sync_meta", { keyPath: "key" });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        this.isReady = true;
        resolve();
      };

      request.onerror = (event) => {
        const err = (event.target as IDBOpenDBRequest).error;
        reject(new Error(`Failed to open IndexedDB [${this.dbName}]: ${err?.message}`));
      };
    });
  }

  private getDB(): IDBDatabase {
    if (!this.db || !this.isReady) {
      throw new Error("LocalDB is not initialized. Call init() first.");
    }
    return this.db;
  }

  // ==========================================
  // Store 1: Files State (Local Sync Ledger)
  // ==========================================

  async getFileState(path: string): Promise<LocalFileState | undefined> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files_state", "readonly");
      const store = tx.objectStore("files_state");
      const request = store.get(path);

      request.onsuccess = () => resolve(request.result as LocalFileState | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  async getFileStateByFileId(fileId: string): Promise<LocalFileState | undefined> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files_state", "readonly");
      const store = tx.objectStore("files_state");
      const index = store.index("by_fileId");
      const request = index.get(fileId);

      request.onsuccess = () => resolve(request.result as LocalFileState | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  async setFileState(state: LocalFileState): Promise<void> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files_state", "readwrite");
      const store = tx.objectStore("files_state");
      const request = store.put(state);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteFileState(path: string): Promise<void> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files_state", "readwrite");
      const store = tx.objectStore("files_state");
      const request = store.delete(path);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getAllFileStates(): Promise<LocalFileState[]> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files_state", "readonly");
      const store = tx.objectStore("files_state");
      const request = store.getAll();

      request.onsuccess = () => resolve((request.result as LocalFileState[]) || []);
      request.onerror = () => reject(request.error);
    });
  }

  // ==========================================
  // Store 2: Outbound Queue (Offline Mutex Queue)
  // ==========================================

  async enqueueOutbound(item: OutboundQueueItem): Promise<void> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbound_queue", "readwrite");
      const store = tx.objectStore("outbound_queue");
      const request = store.put(item);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async dequeueOutbound(id: string): Promise<void> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbound_queue", "readwrite");
      const store = tx.objectStore("outbound_queue");
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async peekOutboundQueue(): Promise<OutboundQueueItem[]> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbound_queue", "readonly");
      const store = tx.objectStore("outbound_queue");
      const index = store.index("by_createdAt");
      const request = index.getAll();

      request.onsuccess = () => resolve((request.result as OutboundQueueItem[]) || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getOutboundByPath(path: string): Promise<OutboundQueueItem | undefined> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbound_queue", "readonly");
      const store = tx.objectStore("outbound_queue");
      const index = store.index("by_path");
      const request = index.get(path);

      request.onsuccess = () => resolve(request.result as OutboundQueueItem | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  async updateOutbound(item: OutboundQueueItem): Promise<void> {
    return this.enqueueOutbound(item);
  }

  async clearOutboundQueue(): Promise<void> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbound_queue", "readwrite");
      const store = tx.objectStore("outbound_queue");
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ==========================================
  // Store 3: Sync Meta (Key-Value Metadata)
  // ==========================================

  async getMeta<T = unknown>(key: string, defaultValue?: T): Promise<T> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sync_meta", "readonly");
      const store = tx.objectStore("sync_meta");
      const request = store.get(key);

      request.onsuccess = () => {
        if (request.result && request.result.value !== undefined) {
          resolve(request.result.value as T);
        } else {
          resolve(defaultValue as T);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async setMeta<T = unknown>(key: string, value: T): Promise<void> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sync_meta", "readwrite");
      const store = tx.objectStore("sync_meta");
      const request = store.put({ key, value });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ==========================================
  // Global Maintenance
  // ==========================================

  async clearAll(): Promise<void> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["files_state", "outbound_queue", "sync_meta"], "readwrite");
      tx.objectStore("files_state").clear();
      tx.objectStore("outbound_queue").clear();
      tx.objectStore("sync_meta").clear();

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isReady = false;
    }
  }
}
