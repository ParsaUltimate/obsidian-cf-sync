import { DurableObject } from "cloudflare:workers";
import {
  Env,
  FileRecord,
  ClientMessage,
  ServerMessage,
  WsAttachment,
} from "./types";

export class VaultSyncDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  /**
   * Initialize SQLite schema for vault file revision ledger
   */
  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        file_id TEXT PRIMARY KEY,
        encrypted_path TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1,
        opaque_hash TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_rev ON files(rev);
    `);
  }

  /**
   * Handle incoming HTTP & WebSocket requests to this Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const clientId =
        url.searchParams.get("clientId") || `client_${crypto.randomUUID()}`;
      const pathMatch = url.pathname.match(/\/api\/vault\/([^/]+)\/ws/);
      const vaultId = pathMatch
        ? decodeURIComponent(pathMatch[1])
        : url.searchParams.get("vaultId") || "default";

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Hibernation API: accepts WebSocket and associates tags
      this.ctx.acceptWebSocket(server, [clientId]);

      const attachment: WsAttachment = {
        clientId,
        vaultId,
        connectedAt: Date.now(),
      };
      server.serializeAttachment(attachment);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // Internal check-rev route called by Worker before R2 blob upload
    if (url.pathname.includes("/check-rev")) {
      const fileId = url.searchParams.get("fileId") || "";
      const baseRev = parseInt(url.searchParams.get("baseRev") || "0", 10);
      const rows = this.sql
        .exec(`SELECT rev, deleted FROM files WHERE file_id = ?`, fileId)
        .toArray() as unknown as { rev: number; deleted: number }[];

      const row = rows[0];
      const currentRev = row ? Number(row.rev) : 0;
      const isDeleted = row ? row.deleted === 1 : false;

      // Conflict if rev mismatch, UNLESS file was deleted and client is creating anew with baseRev 0
      if (currentRev !== baseRev && !(isDeleted && baseRev === 0)) {
        return new Response(
          JSON.stringify({
            error: "Conflict",
            fileId,
            currentRev,
            baseRev,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true, currentRev }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Expected WebSocket Upgrade", { status: 426 });
  }

  /**
   * WebSocket message handler under the Hibernation API
   */
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") {
      ws.send(
        JSON.stringify({
          type: "ERROR",
          message: "Binary WebSocket messages are not supported. Use HTTP R2 data plane.",
        } satisfies ServerMessage)
      );
      return;
    }

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      ws.send(
        JSON.stringify({
          type: "ERROR",
          message: "Malformed JSON payload",
        } satisfies ServerMessage)
      );
      return;
    }

    const attachment = (ws.deserializeAttachment() as WsAttachment | null) || {
      clientId: "unknown",
      vaultId: "default",
      connectedAt: Date.now(),
    };
    const clientId = attachment.clientId;
    const vaultId = attachment.vaultId;

    switch (parsed.type) {
      case "PING": {
        const response: ServerMessage = { type: "PONG", ts: Date.now() };
        ws.send(JSON.stringify(response));
        break;
      }

      case "PULL_DELTA": {
        const sinceRev = Number(parsed.sinceRev || 0);
        const rows = this.sql
          .exec(
            `SELECT file_id, encrypted_path, rev, opaque_hash, size, mtime, deleted, updated_by, updated_at
             FROM files
             WHERE rev > ?
             ORDER BY rev ASC`,
            sinceRev
          )
          .toArray() as unknown as FileRecord[];

        if (rows.length === 0) {
          ws.send(JSON.stringify({ type: "DELTA_STATE", records: [] } satisfies ServerMessage));
          break;
        }

        // Chunk in batches of 250 records to strictly stay within the 1 MB WebSocket frame limit
        const chunkSize = 250;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          const response: ServerMessage = {
            type: "DELTA_STATE",
            records: chunk,
          };
          ws.send(JSON.stringify(response));
        }
        break;
      }

      case "PUSH_META": {
        const {
          fileId,
          encryptedPath,
          baseRev,
          opaqueHash,
          size,
          mtime,
          deleted,
        } = parsed.payload;

        const existingRows = this.sql
          .exec(
            `SELECT file_id, encrypted_path, rev, opaque_hash, size, mtime, deleted, updated_by, updated_at
             FROM files
             WHERE file_id = ?`,
            fileId
          )
          .toArray() as unknown as FileRecord[];

        const existing = existingRows.length > 0 ? existingRows[0] : undefined;
        const currentRev = existing ? Number(existing.rev) : 0;

        // Idempotency 1: If exact same content hash is already committed and active
        if (
          existing &&
          existing.opaque_hash === opaqueHash &&
          !deleted &&
          existing.deleted === 0
        ) {
          const ack: ServerMessage = {
            type: "PUSH_ACK",
            fileId,
            rev: currentRev,
            updatedAt: existing.updated_at,
          };
          ws.send(JSON.stringify(ack));
          return;
        }

        // Idempotency 2: If file is already deleted on the server and client is pushing deletion
        if (existing && existing.deleted === 1 && deleted) {
          const ack: ServerMessage = {
            type: "PUSH_ACK",
            fileId,
            rev: currentRev,
            updatedAt: existing.updated_at,
          };
          ws.send(JSON.stringify(ack));
          return;
        }

        // Optimistic concurrency check:
        // A conflict occurs if server rev does not match baseRev, EXCEPT when the server record
        // is a tombstone (deleted === 1) and the client is re-creating the file anew (baseRev === 0).
        const isRecreatingDeletedFile =
          existing && existing.deleted === 1 && !deleted && baseRev === 0;

        if (currentRev !== baseRev && !isRecreatingDeletedFile) {
          const conflict: ServerMessage = {
            type: "CONFLICT",
            fileId,
            serverRecord: existing || {
              file_id: fileId,
              encrypted_path: encryptedPath,
              rev: currentRev,
              opaque_hash: "",
              size: 0,
              mtime: 0,
              deleted: 0,
              updated_by: "server",
              updated_at: Date.now(),
            },
          };
          ws.send(JSON.stringify(conflict));
          return;
        }

        // Compute monotonic vault-wide revision number
        const maxRevResult = this.sql
          .exec(`SELECT COALESCE(MAX(rev), 0) AS max_rev FROM files`)
          .toArray() as unknown as [{ max_rev: number }];

        const nextRev = Number(maxRevResult[0]?.max_rev || 0) + 1;
        const now = Date.now();
        const deletedInt = deleted ? 1 : 0;

        this.sql.exec(
          `INSERT INTO files (file_id, encrypted_path, rev, opaque_hash, size, mtime, deleted, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(file_id) DO UPDATE SET
             encrypted_path = excluded.encrypted_path,
             rev = excluded.rev,
             opaque_hash = excluded.opaque_hash,
             size = excluded.size,
             mtime = excluded.mtime,
             deleted = excluded.deleted,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
          fileId,
          encryptedPath,
          nextRev,
          opaqueHash,
          size,
          mtime,
          deletedInt,
          clientId,
          now
        );

        // If file is deleted, clean up binary payload in R2 storage
        if (deleted) {
          try {
            await this.env.VAULT_BUCKET.delete(`${vaultId}/${fileId}`);
          } catch (r2Err) {
            console.error(
              `[VaultSyncDO] Failed to purge deleted R2 blob ${vaultId}/${fileId}:`,
              r2Err
            );
          }
        }

        // Send ACK back to the committing client
        const ack: ServerMessage = {
          type: "PUSH_ACK",
          fileId,
          rev: nextRev,
          updatedAt: now,
        };
        ws.send(JSON.stringify(ack));

        // Broadcast delta to all other hibernated WebSockets connected to this vault
        const broadcast: ServerMessage = {
          type: "REMOTE_CHANGE",
          record: {
            file_id: fileId,
            encrypted_path: encryptedPath,
            rev: nextRev,
            opaque_hash: opaqueHash,
            size,
            mtime,
            deleted: deletedInt,
            updated_by: clientId,
            updated_at: now,
          },
        };
        const broadcastStr = JSON.stringify(broadcast);

        for (const peer of this.ctx.getWebSockets()) {
          if (peer !== ws) {
            try {
              peer.send(broadcastStr);
            } catch (peerErr) {
              console.warn("[VaultSyncDO] Failed to send broadcast to peer:", peerErr);
            }
          }
        }
        break;
      }

      default: {
        const errorMsg: ServerMessage = {
          type: "ERROR",
          message: `Unknown message type: ${(parsed as { type: string }).type}`,
        };
        ws.send(JSON.stringify(errorMsg));
      }
    }
  }

  /**
   * WebSocket close handler
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    try {
      ws.close(code, reason || "Durable Object closing connection");
    } catch (_) {}
  }

  /**
   * WebSocket error handler
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("[VaultSyncDO] WebSocket error:", error);
    try {
      ws.close(1011, "Internal server error occurred on WebSocket");
    } catch (_) {}
  }
}
