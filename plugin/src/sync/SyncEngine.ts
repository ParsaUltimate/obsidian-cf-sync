/**
 * Core Real-Time Synchronization Engine for Obsidian Cloudflare E2EE Sync.
 *
 * Implements:
 * - Echo-safe Mutex (prevents feedback loops)
 * - Debounced local file watcher with offline queueing
 * - Atomic revision progression & deterministic conflict resolution
 * - Mobile lifecycle listeners (Capacitor/WebView foreground resume)
 * - Zero Node.js built-ins: 100% Obsidian Vault Adapter & Web APIs.
 */

import { App, Notice, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { CryptoEngine } from "../crypto/CryptoEngine";
import { LocalDB } from "../storage/LocalDB";
import { BlobClient } from "./BlobClient";
import { WsClient } from "./WsClient";
import {
  FileRecord,
  LocalFileState,
  OutboundQueueItem,
  ServerMessage,
  SyncPluginSettings,
  SyncStats,
  SyncStatus,
} from "../types";

function formatTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export class SyncEngine {
  private app: App;
  private settings: SyncPluginSettings;
  private crypto: CryptoEngine;
  private localDb: LocalDB;
  private blobClient: BlobClient;
  private wsClient: WsClient;

  // Echo suppression: normalizedPath -> expectedOpaqueHash
  private suppressedPaths = new Map<string, { hash: string; expiresAt: number }>();

  // Debounce timers: normalizedPath -> timeout id
  private debounceTimers = new Map<string, number>();

  // In-flight push meta promises: fileId -> { resolve, reject, timer }
  private pendingPushPromises = new Map<
    string,
    {
      resolve: (ack: { rev: number; updatedAt: number }) => void;
      reject: (err: Error) => void;
      conflict: (serverRecord: FileRecord) => void;
      timer: number;
    }
  >();

  // Mutex lock for queue processing
  private isProcessingQueue = false;

  // Synchronization status state
  private status: SyncStatus = "idle";
  private lastErrorMessage: string | null = null;
  private onStatusChangeCallback?: (stats: SyncStats) => void;

  // Event listener references for clean teardown
  private onVisibilityChangeRef: () => void;
  private onOnlineRef: () => void;
  private onResumeRef: () => void;

  constructor(
    app: App,
    settings: SyncPluginSettings,
    crypto: CryptoEngine,
    localDb: LocalDB,
    blobClient: BlobClient,
    onStatusChange?: (stats: SyncStats) => void
  ) {
    this.app = app;
    this.settings = settings;
    this.crypto = crypto;
    this.localDb = localDb;
    this.blobClient = blobClient;
    this.onStatusChangeCallback = onStatusChange;

    const clientId = `${this.settings.deviceName.replace(/\s+/g, "_")}_${Math.random().toString(36).substring(2, 8)}`;

    this.wsClient = new WsClient({
      workerUrl: this.settings.workerUrl,
      vaultId: this.settings.vaultId,
      authToken: this.settings.authToken,
      clientId,
      onMessage: (msg) => this.handleServerMessage(msg),
      onStatusChange: (wsStatus) => {
        if (wsStatus === "connected") {
          this.setStatus("idle");
          this.pullDelta();
          this.processOutboundQueue();
        } else if (wsStatus === "reconnecting" || wsStatus === "disconnected") {
          this.setStatus("offline");
        }
      },
      onError: (err) => {
        console.warn("[SyncEngine] WsClient error:", err);
      },
    });

    this.onVisibilityChangeRef = () => this.handleVisibilityChange();
    this.onOnlineRef = () => this.handleOnline();
    this.onResumeRef = () => this.handleResume();
  }

  /**
   * Start the synchronization engine
   */
  async start(): Promise<void> {
    if (!this.settings.workerUrl || !this.settings.vaultId || !this.settings.passphrase) {
      this.setStatus("offline", "Settings incomplete. Configure sync parameters first.");
      return;
    }

    try {
      // 1. Initialize Crypto Keys
      await this.crypto.deriveKeys(this.settings.passphrase, this.settings.vaultId);

      // 2. Initialize IndexedDB
      await this.localDb.init(this.settings.vaultId);

      // 3. Connect WebSocket
      this.wsClient.connect();

      // 4. Register mobile resume & network listeners
      document.addEventListener("visibilitychange", this.onVisibilityChangeRef);
      window.addEventListener("online", this.onOnlineRef);
      window.addEventListener("resume", this.onResumeRef);

      // 5. Initial vault delta check
      await this.scanVaultForUnsyncedChanges();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      console.error("[SyncEngine] Failed to start:", err);
    }
  }

  /**
   * Stop the synchronization engine and release resources
   */
  destroy(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChangeRef);
    window.removeEventListener("online", this.onOnlineRef);
    window.removeEventListener("resume", this.onResumeRef);

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear pending promises
    for (const pending of this.pendingPushPromises.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("SyncEngine destroyed"));
    }
    this.pendingPushPromises.clear();

    this.wsClient.disconnect();
    this.localDb.close();
    this.suppressedPaths.clear();
  }

  /**
   * Update configuration dynamically from Settings tab
   */
  async updateSettings(newSettings: SyncPluginSettings): Promise<void> {
    const credsChanged =
      this.settings.passphrase !== newSettings.passphrase ||
      this.settings.vaultId !== newSettings.vaultId;

    this.settings = newSettings;
    this.blobClient.updateConfig(newSettings.workerUrl, newSettings.authToken);
    this.wsClient.updateConfig(
      newSettings.workerUrl,
      newSettings.vaultId,
      newSettings.authToken
    );

    if (credsChanged) {
      try {
        await this.crypto.deriveKeys(this.settings.passphrase, this.settings.vaultId);
        await this.localDb.init(this.settings.vaultId);
        this.wsClient.reconnect();
      } catch (err) {
        console.error("[SyncEngine] Failed to update encryption credentials:", err);
      }
    }
  }

  /**
   * Check if a path should be excluded from synchronization.
   * Multi-layer ignore engine evaluating hardcoded system rules, volatile Obsidian files,
   * conflict artifacts, and user-configured glob / prefix rules.
   */
  public shouldIgnorePath(rawPath: string): boolean {
    if (!rawPath) return true;
    const norm = normalizePath(rawPath.replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "");
    if (!norm) return true;

    // 1. Any path segment matching hardcoded blacklisted segment names
    const segments = norm.split("/");
    const ignoredSegments = new Set([
      "node_modules",
      ".git",
      ".svn",
      ".hg",
      ".DS_Store",
      "Thumbs.db",
      "obsidian-cf-sync",
      ".trash",
    ]);

    for (const segment of segments) {
      if (ignoredSegments.has(segment)) {
        return true;
      }
    }

    // 2. Volatile Obsidian workspace and cache files causing sync storms
    const volatileFiles = [
      ".obsidian/workspace.json",
      ".obsidian/workspace-mobile.json",
      ".obsidian/graph.json",
      ".obsidian/backlink.json",
      ".obsidian/canvas.json",
    ];
    for (const volatile of volatileFiles) {
      if (norm === volatile || norm.endsWith("/" + volatile)) {
        return true;
      }
    }

    // 3. Conflict artifact files (*.sync-conflict-*) unless explicitly enabled
    if (!this.settings.syncConflictFiles) {
      const fileName = segments[segments.length - 1];
      if (fileName && fileName.includes(".sync-conflict-")) {
        return true;
      }
    }

    // 4. User-Configurable patterns in settings.ignoredPaths
    if (this.settings.ignoredPaths && Array.isArray(this.settings.ignoredPaths)) {
      for (const rawPattern of this.settings.ignoredPaths) {
        const pattern = rawPattern.trim();
        if (!pattern) continue;

        const normPattern = normalizePath(pattern.replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "");

        // Exact match
        if (norm === normPattern) return true;

        // Path segment match (e.g. pattern "node_modules" or ".temp")
        if (!normPattern.includes("/")) {
          if (segments.includes(normPattern)) return true;
        }

        // Prefix match (e.g. pattern "archive" matches "archive/notes.md")
        if (norm.startsWith(normPattern + "/")) return true;

        // Wildcard / Glob pattern (e.g. "*.tmp" or "drafts/*")
        if (normPattern.includes("*")) {
          const regexStr =
            "^" +
            normPattern
              .split("*")
              .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
              .join(".*") +
            "$";
          try {
            const regex = new RegExp(regexStr, "i");
            if (regex.test(norm)) return true;
          } catch (_) {}
        }
      }
    }

    return false;
  }

  // ==========================================
  // Vault File Watcher Handlers
  // ==========================================

  handleFileCreated(file: TAbstractFile): void {
    if (!(file instanceof TFile) || this.shouldIgnorePath(file.path)) return;
    this.scheduleDebouncedPush(file.path);
  }

  handleFileModified(file: TAbstractFile): void {
    if (!(file instanceof TFile) || this.shouldIgnorePath(file.path)) return;
    this.scheduleDebouncedPush(file.path);
  }

  async handleFileDeleted(file: TAbstractFile): Promise<void> {
    if (this.shouldIgnorePath(file.path)) return;
    const normPath = normalizePath(file.path);

    // Cancel any pending debounced upload for this path
    const existingTimer = this.debounceTimers.get(normPath);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      this.debounceTimers.delete(normPath);
    }

    if (file instanceof TFolder) {
      // Find all files in LocalDB that were inside this folder
      const allStates = await this.localDb.getAllFileStates();
      const prefix = normPath + "/";
      for (const state of allStates) {
        if (state.path.startsWith(prefix) && !this.shouldIgnorePath(state.path)) {
          const childTimer = this.debounceTimers.get(state.path);
          if (childTimer !== undefined) {
            window.clearTimeout(childTimer);
            this.debounceTimers.delete(state.path);
          }
          await this.scheduleDeletion(state.path);
        }
      }
    } else {
      await this.scheduleDeletion(normPath);
    }
  }

  handleFileRenamed(file: TAbstractFile, oldPath: string): void {
    const normOldPath = normalizePath(oldPath);
    const normNewPath = normalizePath(file.path);

    const oldIgnored = this.shouldIgnorePath(normOldPath);
    const newIgnored = this.shouldIgnorePath(normNewPath);

    if (oldIgnored && newIgnored) return;

    if (file instanceof TFile) {
      if (!oldIgnored && newIgnored) {
        // Moved into ignored location -> treat as remote deletion of oldPath
        this.scheduleDeletion(normOldPath);
      } else if (oldIgnored && !newIgnored) {
        // Moved out of ignored location -> treat as fresh creation of file.path
        this.scheduleDebouncedPush(normNewPath);
      } else {
        // Neither ignored -> standard rename (delete oldPath + upload file.path)
        this.scheduleDeletion(normOldPath);
        this.scheduleDebouncedPush(normNewPath);
      }
    } else if (file instanceof TFolder) {
      // Recursively handle folder rename for all nested files
      const allFiles = this.app.vault.getFiles();
      const prefix = normNewPath + "/";
      for (const childFile of allFiles) {
        if (childFile.path.startsWith(prefix)) {
          const relativeToFolder = childFile.path.substring(prefix.length);
          const childOldPath = normalizePath(`${normOldPath}/${relativeToFolder}`);
          const childNewPath = normalizePath(childFile.path);

          const childOldIgnored = this.shouldIgnorePath(childOldPath);
          const childNewIgnored = this.shouldIgnorePath(childNewPath);

          if (childOldIgnored && childNewIgnored) continue;

          if (!childOldIgnored && childNewIgnored) {
            this.scheduleDeletion(childOldPath);
          } else if (childOldIgnored && !childNewIgnored) {
            this.scheduleDebouncedPush(childNewPath);
          } else {
            this.scheduleDeletion(childOldPath);
            this.scheduleDebouncedPush(childNewPath);
          }
        }
      }
    }
  }

  /**
   * Debounce local modifications (1000ms) before committing to outbound queue
   */
  private scheduleDebouncedPush(filePath: string): void {
    const normPath = normalizePath(filePath);

    const existingTimer = this.debounceTimers.get(normPath);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(async () => {
      this.debounceTimers.delete(normPath);
      await this.enqueueLocalFile(normPath);
    }, this.settings.debounceIntervalMs || 1000);

    this.debounceTimers.set(normPath, timer);
  }

  /**
   * Read file, verify echo suppression, and enqueue for upload
   */
  private async enqueueLocalFile(normPath: string): Promise<void> {
    if (!this.crypto.hasKeys()) return;

    try {
      const exists = await this.app.vault.adapter.exists(normPath);
      if (!exists) return;

      const fileData = await this.app.vault.adapter.readBinary(normPath);
      const opaqueHash = await this.crypto.computeOpaqueHash(fileData);

      // Check 1: Echo suppression mutex
      const suppression = this.suppressedPaths.get(normPath);
      if (suppression) {
        if (Date.now() < suppression.expiresAt && suppression.hash === opaqueHash) {
          this.suppressedPaths.delete(normPath);
          return;
        }
        if (Date.now() >= suppression.expiresAt) {
          this.suppressedPaths.delete(normPath);
        }
      }

      // Check 2: Idempotency vs LocalDB
      const localState = await this.localDb.getFileState(normPath);
      if (localState && localState.opaqueHash === opaqueHash) {
        // Disk contents match local sync state
        return;
      }

      const fileId = await this.crypto.computeFileId(normPath);
      const stat = await this.app.vault.adapter.stat(normPath);
      const baseRev = localState ? localState.rev : 0;
      const mtime = stat ? stat.mtime : Date.now();

      // Check 3: Consolidate with existing outbound queue item for this path
      const existingQueueItem = await this.localDb.getOutboundByPath(normPath);
      if (existingQueueItem) {
        if (existingQueueItem.action === "upload") {
          existingQueueItem.mtime = mtime;
          existingQueueItem.createdAt = Date.now();
          await this.localDb.updateOutbound(existingQueueItem);
          this.processOutboundQueue();
          return;
        } else if (existingQueueItem.action === "delete") {
          // File was pending delete but was recreated locally
          await this.localDb.dequeueOutbound(existingQueueItem.id);
        }
      }

      const queueItem: OutboundQueueItem = {
        id: `upload_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        action: "upload",
        path: normPath,
        fileId,
        baseRev,
        mtime,
        attempts: 0,
        createdAt: Date.now(),
      };

      await this.localDb.enqueueOutbound(queueItem);
      this.processOutboundQueue();
    } catch (err) {
      console.error(`[SyncEngine] Error enqueuing local file ${normPath}:`, err);
    }
  }

  /**
   * Enqueue a file deletion operation
   */
  private async scheduleDeletion(normPath: string): Promise<void> {
    if (!this.crypto.hasKeys()) return;

    try {
      const fileId = await this.crypto.computeFileId(normPath);
      const localState = await this.localDb.getFileState(normPath);
      const baseRev = localState ? localState.rev : 0;

      // Consolidate with existing outbound item
      const existingQueueItem = await this.localDb.getOutboundByPath(normPath);
      if (existingQueueItem) {
        if (existingQueueItem.action === "delete") {
          return; // Already queued for deletion
        } else if (existingQueueItem.action === "upload") {
          // Dequeue pending upload since the file is now deleted
          await this.localDb.dequeueOutbound(existingQueueItem.id);
        }
      }

      const queueItem: OutboundQueueItem = {
        id: `delete_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        action: "delete",
        path: normPath,
        fileId,
        baseRev,
        mtime: Date.now(),
        attempts: 0,
        createdAt: Date.now(),
      };

      await this.localDb.enqueueOutbound(queueItem);
      this.processOutboundQueue();
    } catch (err) {
      console.error(`[SyncEngine] Error scheduling deletion for ${normPath}:`, err);
    }
  }

  // ==========================================
  // Outbound Queue Processor
  // ==========================================

  /**
   * Sequentially process outbound items with R2 binary upload + DO metadata commit
   */
  async processOutboundQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    if (!this.wsClient.isConnected() || !this.crypto.hasKeys()) return;

    this.isProcessingQueue = true;
    this.setStatus("syncing");

    try {
      const queue = await this.localDb.peekOutboundQueue();

      for (const item of queue) {
        if (!this.wsClient.isConnected()) break;

        try {
          if (item.action === "upload") {
            const exists = await this.app.vault.adapter.exists(item.path);
            if (!exists) {
              await this.localDb.dequeueOutbound(item.id);
              continue;
            }

            const rawBuffer = await this.app.vault.adapter.readBinary(item.path);
            const opaqueHash = await this.crypto.computeOpaqueHash(rawBuffer);

            // Re-verify local baseRev to avoid self-conflict
            const currentState = await this.localDb.getFileState(item.path);
            const activeBaseRev = currentState ? currentState.rev : item.baseRev;

            // Encrypt binary payload for R2 data plane
            const encryptedBytes = await this.crypto.encryptBytes(rawBuffer);
            // Encrypt relative path for metadata
            const encryptedPath = await this.crypto.encryptString(item.path);

            // Step 1: Upload encrypted blob to R2 (passing activeBaseRev for pre-check)
            await this.blobClient.uploadBlob(
              this.settings.vaultId,
              item.fileId,
              encryptedBytes,
              activeBaseRev
            );

            // Step 2: Commit metadata via Durable Object WebSocket
            const ackPromise = this.waitForPushAck(item.fileId);
            this.wsClient.send({
              type: "PUSH_META",
              payload: {
                fileId: item.fileId,
                encryptedPath,
                baseRev: activeBaseRev,
                opaqueHash,
                size: rawBuffer.byteLength,
                mtime: item.mtime,
                deleted: false,
              },
            });

            const ack = await ackPromise;

            // Step 3: Record local state
            await this.localDb.setFileState({
              path: item.path,
              fileId: item.fileId,
              rev: ack.rev,
              opaqueHash,
              mtime: item.mtime,
              size: rawBuffer.byteLength,
              syncedAt: Date.now(),
            });

            // Update highest vault revision
            const currentLastRev = await this.localDb.getMeta<number>("last_rev", 0);
            if (ack.rev > currentLastRev) {
              await this.localDb.setMeta("last_rev", ack.rev);
            }

            await this.localDb.dequeueOutbound(item.id);
          } else if (item.action === "delete") {
            const encryptedPath = await this.crypto.encryptString(item.path);

            const ackPromise = this.waitForPushAck(item.fileId);
            this.wsClient.send({
              type: "PUSH_META",
              payload: {
                fileId: item.fileId,
                encryptedPath,
                baseRev: item.baseRev,
                opaqueHash: "DELETED",
                size: 0,
                mtime: item.mtime,
                deleted: true,
              },
            });

            const ack = await ackPromise;

            await this.localDb.deleteFileState(item.path);

            const currentLastRev = await this.localDb.getMeta<number>("last_rev", 0);
            if (ack.rev > currentLastRev) {
              await this.localDb.setMeta("last_rev", ack.rev);
            }

            await this.localDb.dequeueOutbound(item.id);
          }
        } catch (itemErr: unknown) {
          if (
            itemErr instanceof Error &&
            (itemErr.message === "CONFLICT" || itemErr.message === "CONFLICT_409")
          ) {
            // Handled or pre-check conflict: dequeue item and pull delta to resolve
            await this.localDb.dequeueOutbound(item.id);
            if (itemErr.message === "CONFLICT_409") {
              await this.pullDelta();
            }
          } else {
            console.error(`[SyncEngine] Error syncing item ${item.path}:`, itemErr);
            item.attempts++;
            await this.localDb.updateOutbound(item);
          }
        }
      }

      await this.localDb.setMeta("last_sync_time", Date.now());
      this.setStatus("synced");
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Await PUSH_ACK or CONFLICT response from DO WebSocket
   */
  private waitForPushAck(
    fileId: string
  ): Promise<{ rev: number; updatedAt: number }> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingPushPromises.delete(fileId);
        reject(new Error(`PUSH_META timed out after 15s for fileId ${fileId}`));
      }, 15000);

      this.pendingPushPromises.set(fileId, {
        resolve: (ack) => {
          window.clearTimeout(timer);
          resolve(ack);
        },
        reject: (err) => {
          window.clearTimeout(timer);
          reject(err);
        },
        conflict: async (serverRecord) => {
          window.clearTimeout(timer);
          try {
            await this.resolveConflict(serverRecord);
            reject(new Error("CONFLICT"));
          } catch (resErr) {
            reject(resErr instanceof Error ? resErr : new Error(String(resErr)));
          }
        },
        timer,
      });
    });
  }

  // ==========================================
  // Conflict Resolution
  // ==========================================

  /**
   * Deterministic conflict resolution:
   * 1. Preserves local modified file as `${baseName}.sync-conflict-${timestamp}.${ext}`
   * 2. Writes authoritative server version to original path
   */
  private async resolveConflict(serverRecord: FileRecord): Promise<void> {
    this.setStatus("conflict");

    try {
      const plainPath = await this.crypto.decryptString(serverRecord.encrypted_path);
      const normPath = normalizePath(plainPath);

      const exists = await this.app.vault.adapter.exists(normPath);
      let localBytes: ArrayBuffer | null = null;
      if (exists) {
        localBytes = await this.app.vault.adapter.readBinary(normPath);
      }

      // If local content differs from server hash, save conflict copy
      if (localBytes) {
        const localHash = await this.crypto.computeOpaqueHash(localBytes);
        if (localHash !== serverRecord.opaque_hash) {
          const extIndex = normPath.lastIndexOf(".");
          const ext = extIndex !== -1 ? normPath.substring(extIndex + 1) : "";
          const base = extIndex !== -1 ? normPath.substring(0, extIndex) : normPath;
          const timestamp = formatTimestamp(new Date());
          const conflictPath = `${base}.sync-conflict-${timestamp}${ext ? "." + ext : ""}`;

          await this.app.vault.adapter.writeBinary(conflictPath, localBytes);
          new Notice(`Conflict resolved for "${normPath}". Local edits saved to "${conflictPath}".`, 8000);
        }
      }

      // Apply server version
      if (serverRecord.deleted === 1) {
        if (exists) {
          await this.app.vault.adapter.remove(normPath);
        }
        await this.localDb.deleteFileState(normPath);
      } else {
        const encryptedBlob = await this.blobClient.downloadBlob(
          this.settings.vaultId,
          serverRecord.file_id
        );
        const decrypted = await this.crypto.decryptBytes(encryptedBlob);

        await this.ensureParentDirectory(normPath);

        // Echo suppression
        this.suppressedPaths.set(normPath, {
          hash: serverRecord.opaque_hash,
          expiresAt: Date.now() + 5000,
        });

        await this.app.vault.adapter.writeBinary(normPath, decrypted);

        await this.localDb.setFileState({
          path: normPath,
          fileId: serverRecord.file_id,
          rev: serverRecord.rev,
          opaqueHash: serverRecord.opaque_hash,
          mtime: serverRecord.mtime,
          size: decrypted.byteLength,
          syncedAt: Date.now(),
        });
      }

      // Update max rev
      const curMaxRev = await this.localDb.getMeta<number>("last_rev", 0);
      if (serverRecord.rev > curMaxRev) {
        await this.localDb.setMeta("last_rev", serverRecord.rev);
      }
    } catch (err) {
      console.error("[SyncEngine] Failed during conflict resolution:", err);
    }
  }

  // ==========================================
  // Delta & Inbound Server Message Handling
  // ==========================================

  /**
   * Request remote revision ledger delta since last known local revision
   */
  async pullDelta(): Promise<void> {
    if (!this.wsClient.isConnected() || !this.crypto.hasKeys()) return;

    const lastRev = await this.localDb.getMeta<number>("last_rev", 0);
    this.wsClient.send({
      type: "PULL_DELTA",
      sinceRev: lastRev,
    });
  }

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case "PUSH_ACK": {
        const pending = this.pendingPushPromises.get(msg.fileId);
        if (pending) {
          this.pendingPushPromises.delete(msg.fileId);
          pending.resolve({ rev: msg.rev, updatedAt: msg.updatedAt });
        }
        break;
      }

      case "CONFLICT": {
        const pending = this.pendingPushPromises.get(msg.fileId);
        if (pending) {
          this.pendingPushPromises.delete(msg.fileId);
          pending.conflict(msg.serverRecord);
        } else {
          await this.resolveConflict(msg.serverRecord);
        }
        break;
      }

      case "DELTA_STATE": {
        await this.applyDeltaState(msg.records);
        break;
      }

      case "REMOTE_CHANGE": {
        await this.applyDeltaState([msg.record]);
        break;
      }

      case "ERROR": {
        console.error("[SyncEngine] Server protocol error:", msg.message);
        this.setStatus("error", msg.message);
        break;
      }
    }
  }

  /**
   * Apply received delta records from server to local vault
   */
  private async applyDeltaState(records: FileRecord[]): Promise<void> {
    if (!records || records.length === 0 || !this.crypto.hasKeys()) return;

    this.setStatus("syncing");

    try {
      // Sort chronologically by revision
      const sorted = [...records].sort((a, b) => a.rev - b.rev);

      let highestRev = await this.localDb.getMeta<number>("last_rev", 0);

      for (const record of sorted) {
        try {
          const plainPath = await this.crypto.decryptString(record.encrypted_path);
          const normPath = normalizePath(plainPath);

          if (this.shouldIgnorePath(normPath)) {
            if (record.rev > highestRev) highestRev = record.rev;
            continue;
          }

          if (record.deleted === 1) {
            const exists = await this.app.vault.adapter.exists(normPath);
            if (exists) {
              await this.app.vault.adapter.remove(normPath);
            }
            await this.localDb.deleteFileState(normPath);
          } else {
            // Check if local file has uncommitted offline modifications
            const pendingOutbound = await this.localDb.getOutboundByPath(normPath);
            const exists = await this.app.vault.adapter.exists(normPath);

            let localOpaqueHash = "";
            if (exists) {
              const localBytes = await this.app.vault.adapter.readBinary(normPath);
              localOpaqueHash = await this.crypto.computeOpaqueHash(localBytes);
            }

            const localState = await this.localDb.getFileState(normPath);

            // Conflict condition: uncommitted local changes exist and differ from server hash
            if (
              (pendingOutbound || (localState && localState.opaqueHash !== localOpaqueHash)) &&
              localOpaqueHash !== record.opaque_hash &&
              exists
            ) {
              await this.resolveConflict(record);
              if (pendingOutbound) {
                await this.localDb.dequeueOutbound(pendingOutbound.id);
              }
            } else if (exists && localOpaqueHash === record.opaque_hash) {
              // Local content already matches authoritative remote version: update metadata only
              const stat = await this.app.vault.adapter.stat(normPath);
              await this.localDb.setFileState({
                path: normPath,
                fileId: record.file_id,
                rev: record.rev,
                opaqueHash: record.opaque_hash,
                mtime: record.mtime,
                size: stat ? stat.size : 0,
                syncedAt: Date.now(),
              });
            } else {
              // Download and apply authoritative server version
              const encryptedBlob = await this.blobClient.downloadBlob(
                this.settings.vaultId,
                record.file_id
              );
              const decrypted = await this.crypto.decryptBytes(encryptedBlob);

              await this.ensureParentDirectory(normPath);

              // Register in echo suppression
              this.suppressedPaths.set(normPath, {
                hash: record.opaque_hash,
                expiresAt: Date.now() + 5000,
              });

              await this.app.vault.adapter.writeBinary(normPath, decrypted);

              await this.localDb.setFileState({
                path: normPath,
                fileId: record.file_id,
                rev: record.rev,
                opaqueHash: record.opaque_hash,
                mtime: record.mtime,
                size: decrypted.byteLength,
                syncedAt: Date.now(),
              });
            }
          }

          if (record.rev > highestRev) {
            highestRev = record.rev;
          }
        } catch (recordErr) {
          console.error("[SyncEngine] Failed applying delta record:", record, recordErr);
        }
      }

      await this.localDb.setMeta("last_rev", highestRev);
      await this.localDb.setMeta("last_sync_time", Date.now());
      this.setStatus("synced");

      // Process any outbound changes queued locally
      this.processOutboundQueue();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
    }
  }

  // ==========================================
  // Mobile Lifecycle & Vault Scanning
  // ==========================================

  private handleVisibilityChange(): void {
    if (document.visibilityState === "visible") {
      this.handleAppForegrounded();
    }
  }

  private handleOnline(): void {
    if (!this.wsClient.isConnected()) {
      this.wsClient.reconnect();
    }
  }

  private handleResume(): void {
    this.handleAppForegrounded();
  }

  private async handleAppForegrounded(): Promise<void> {
    if (!this.wsClient.isConnected()) {
      this.wsClient.connect();
    } else {
      await this.pullDelta();
    }
    await this.scanVaultForUnsyncedChanges();
  }

  /**
   * Scan local vault files to detect files modified while app was suspended.
   * Traverses vault via adapter.list() and short-circuits ignored directories (node_modules, .git, etc.)
   * without descending into them.
   */
  async scanVaultForUnsyncedChanges(): Promise<void> {
    if (!this.crypto.hasKeys()) return;

    // 1. Recursive filesystem traversal via adapter.list(), short-circuiting ignored directories
    const scanDir = async (dirPath: string): Promise<void> => {
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await this.app.vault.adapter.list(dirPath);
      } catch (err) {
        console.warn(`[SyncEngine] Failed to list directory "${dirPath}":`, err);
        return;
      }

      // Short-circuit ignored directories immediately without descending
      for (const folder of listing.folders) {
        const normFolder = normalizePath(folder);
        if (this.shouldIgnorePath(normFolder)) {
          continue;
        }
        await scanDir(normFolder);
      }

      for (const file of listing.files) {
        const normFile = normalizePath(file);
        if (this.shouldIgnorePath(normFile)) {
          continue;
        }

        const state = await this.localDb.getFileState(normFile);
        const stat = await this.app.vault.adapter.stat(normFile);
        const mtime = stat ? stat.mtime : Date.now();

        // If file has newer modification time than stored state
        if (!state || mtime > state.mtime) {
          await this.enqueueLocalFile(normFile);
        }
      }
    };

    await scanDir("");

    // 2. Reconciliation: Detect files deleted from disk while app was suspended / closed
    const allStates = await this.localDb.getAllFileStates();
    for (const state of allStates) {
      if (this.shouldIgnorePath(state.path)) continue;
      const exists = await this.app.vault.adapter.exists(state.path);
      if (!exists) {
        await this.scheduleDeletion(state.path);
      }
    }
  }

  private async ensureParentDirectory(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    if (parts.length <= 1) return;
    parts.pop(); // Remove file name
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(current);
      if (!exists) {
        try {
          await this.app.vault.adapter.mkdir(current);
        } catch (_) {}
      }
    }
  }

  // ==========================================
  // Status and Observability
  // ==========================================

  private setStatus(status: SyncStatus, errorMessage: string | null = null): void {
    this.status = status;
    this.lastErrorMessage = errorMessage;

    if (this.onStatusChangeCallback) {
      this.getStats().then((stats) => {
        if (this.onStatusChangeCallback) {
          this.onStatusChangeCallback(stats);
        }
      });
    }
  }

  async getStats(): Promise<SyncStats> {
    const queue = await this.localDb.peekOutboundQueue().catch(() => []);
    const lastRev = await this.localDb.getMeta<number>("last_rev", 0).catch(() => 0);
    const lastSyncTime = await this.localDb
      .getMeta<number>("last_sync_time", 0)
      .catch(() => 0);

    return {
      status: this.status,
      pendingUploads: queue.length,
      lastSyncTime,
      lastRev,
      errorMessage: this.lastErrorMessage,
    };
  }

  /**
   * Force a complete delta pull and outbound queue flush
   */
  async forceSync(): Promise<void> {
    this.setStatus("syncing");
    if (!this.wsClient.isConnected()) {
      this.wsClient.connect();
    }
    await this.pullDelta();
    await this.scanVaultForUnsyncedChanges();
    await this.processOutboundQueue();
  }
}
