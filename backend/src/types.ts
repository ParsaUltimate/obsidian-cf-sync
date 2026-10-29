/**
 * Shared types & wire protocol interfaces for Obsidian Cloudflare Sync
 */

export interface Env {
  VAULT_SYNC_DO: DurableObjectNamespace;
  VAULT_BUCKET: R2Bucket;
  AUTH_SECRET: string;
}

/**
 * SQLite row representation for synchronized files
 */
export interface FileRecord {
  file_id: string;
  encrypted_path: string;
  rev: number;
  opaque_hash: string;
  size: number;
  mtime: number;
  deleted: number; // 0 = active, 1 = deleted
  updated_by: string;
  updated_at: number;
}

/**
 * Metadata push payload sent over WebSocket from client to server
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
 * WebSocket messages from Client -> Server
 */
export type ClientMessage =
  | { type: "PING" }
  | { type: "PULL_DELTA"; sinceRev: number }
  | { type: "PUSH_META"; payload: PushMetaPayload };

/**
 * WebSocket messages from Server -> Client
 */
export type ServerMessage =
  | { type: "PONG"; ts: number }
  | { type: "DELTA_STATE"; records: FileRecord[] }
  | { type: "PUSH_ACK"; fileId: string; rev: number; updatedAt: number }
  | { type: "CONFLICT"; fileId: string; serverRecord: FileRecord }
  | { type: "REMOTE_CHANGE"; record: FileRecord }
  | { type: "ERROR"; message: string; code?: string };

/**
 * WebSocket attachment stored during hibernation
 */
export interface WsAttachment {
  clientId: string;
  vaultId: string;
  connectedAt: number;
}
