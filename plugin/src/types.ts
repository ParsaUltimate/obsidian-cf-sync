/**
 * Client-side interfaces, wire protocol payloads, and local state models
 * for Obsidian Cloudflare E2EE Real-Time Sync.
 *
 * NOTE: STRICTLY ZERO Node.js built-ins.
 */

export interface SyncPluginSettings {
  workerUrl: string;
  vaultId: string;
  authToken: string;
  passphrase: string;
  deviceName: string;
  autoSync: boolean;
  debounceIntervalMs: number;
  ignoredPaths: string[];
  syncConflictFiles: boolean;
}

export const DEFAULT_SETTINGS: SyncPluginSettings = {
  workerUrl: "",
  vaultId: "",
  authToken: "",
  passphrase: "",
  deviceName: "Obsidian Device",
  autoSync: true,
  debounceIntervalMs: 1000,
  ignoredPaths: [
    "node_modules",
    ".git",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/graph.json",
    ".obsidian/backlink.json",
    ".obsidian/canvas.json",
  ],
  syncConflictFiles: false,
};

/**
 * SQLite file record format returned by server
 */
export interface FileRecord {
  file_id: string;
  encrypted_path: string;
  rev: number;
  opaque_hash: string;
  size: number;
  mtime: number;
  deleted: number; // 0 or 1
  updated_by: string;
  updated_at: number;
}

/**
 * Metadata push payload sent over WebSocket
 */
export interface PushMetaPayload {
  fileId: string;
  encryptedPath: string;
  baseRev: number;
  opaqueHash: string;
  size: number;
  mtime: number;
  deleted: boolean;
}

/**
 * Wire Protocol: Client -> Server
 */
export type ClientMessage =
  | { type: "PING" }
  | { type: "PULL_DELTA"; sinceRev: number }
  | { type: "PUSH_META"; payload: PushMetaPayload };

/**
 * Wire Protocol: Server -> Client
 */
export type ServerMessage =
  | { type: "PONG"; ts: number }
  | { type: "DELTA_STATE"; records: FileRecord[] }
  | { type: "PUSH_ACK"; fileId: string; rev: number; updatedAt: number }
  | { type: "CONFLICT"; fileId: string; serverRecord: FileRecord }
  | { type: "REMOTE_CHANGE"; record: FileRecord }
  | { type: "ERROR"; message: string; code?: string };

/**
 * Local IndexedDB stored file sync state
 */
export interface LocalFileState {
  path: string;
  fileId: string;
  rev: number;
  opaqueHash: string;
  mtime: number;
  size: number;
  syncedAt: number;
}

/**
 * Offline and outbound pending queue item
 */
export interface OutboundQueueItem {
  id: string;
  action: "upload" | "delete";
  path: string;
  fileId: string;
  baseRev: number;
  mtime: number;
  attempts: number;
  createdAt: number;
}

export type SyncStatus =
  | "idle"
  | "syncing"
  | "synced"
  | "conflict"
  | "offline"
  | "error";

export interface SyncStats {
  status: SyncStatus;
  pendingUploads: number;
  lastSyncTime: number;
  lastRev: number;
  errorMessage: string | null;
}
