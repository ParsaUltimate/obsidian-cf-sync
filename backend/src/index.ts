import { Env } from "./types";
export { VaultSyncDO } from "./VaultSyncDO";

/**
 * Build standard CORS headers accommodating Obsidian Desktop, iOS, and Android
 */
function buildCorsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");

  // Allow all typical Obsidian origins (app://obsidian.md, capacitor://localhost, http://localhost, etc.)
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
  }

  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Content-Length, X-Requested-With, Cache-Control"
  );
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

/**
 * Constant-time string comparison to defend against timing attacks
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Authenticate incoming requests via Bearer header or query parameter
 */
function isAuthorized(request: Request, url: URL, env: Env): boolean {
  if (!env.AUTH_SECRET) {
    console.error("[Worker] AUTH_SECRET is not configured in environment variables!");
    return false;
  }

  // Check Authorization header
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (constantTimeEqual(token, env.AUTH_SECRET)) {
      return true;
    }
  }

  // Check query parameter (crucial for WebSocket connections where browser cannot pass custom headers)
  const queryToken = url.searchParams.get("token");
  if (queryToken && constantTimeEqual(queryToken.trim(), env.AUTH_SECRET)) {
    return true;
  }

  return false;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = buildCorsHeaders(request);

    // Handle preflight CORS OPTIONS requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Public health check route
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          service: "obsidian-cf-sync",
          timestamp: Date.now(),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...Object.fromEntries(corsHeaders),
          },
        }
      );
    }

    // All API routes require authorization
    if (!isAuthorized(request, url, env)) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "Invalid or missing Bearer token in Authorization header or query parameter.",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            ...Object.fromEntries(corsHeaders),
          },
        }
      );
    }

    // Route: WebSocket Upgrade -> /api/vault/:vaultId/ws
    const wsMatch = url.pathname.match(/^\/api\/vault\/([^/]+)\/ws$/);
    if (wsMatch) {
      const vaultId = decodeURIComponent(wsMatch[1]);
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket Upgrade", {
          status: 426,
          headers: corsHeaders,
        });
      }

      // Forward request to SQLite Durable Object
      const doId = env.VAULT_SYNC_DO.idFromName(vaultId);
      const stub = env.VAULT_SYNC_DO.get(doId);
      return stub.fetch(request);
    }

    // Route: Binary Blob Storage (R2) -> /api/vault/:vaultId/blob/:fileId
    const blobMatch = url.pathname.match(/^\/api\/vault\/([^/]+)\/blob\/([^/]+)$/);
    if (blobMatch) {
      const vaultId = decodeURIComponent(blobMatch[1]);
      const fileId = decodeURIComponent(blobMatch[2]);
      const r2Key = `${vaultId}/${fileId}`;

      switch (request.method) {
        case "PUT": {
          if (!request.body) {
            return new Response(
              JSON.stringify({ error: "Missing binary payload body" }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  ...Object.fromEntries(corsHeaders),
                },
              }
            );
          }

          // Concurrency pre-check: If client supplied X-Base-Rev, verify with DO before overwriting R2
          const baseRevHeader = request.headers.get("X-Base-Rev");
          if (baseRevHeader !== null) {
            const baseRev = parseInt(baseRevHeader, 10);
            if (!isNaN(baseRev)) {
              const doId = env.VAULT_SYNC_DO.idFromName(vaultId);
              const stub = env.VAULT_SYNC_DO.get(doId);
              const checkResp = await stub.fetch(
                new Request(
                  `https://internal/api/vault/${encodeURIComponent(vaultId)}/check-rev?fileId=${encodeURIComponent(fileId)}&baseRev=${baseRev}`
                )
              );
              if (checkResp.status === 409) {
                const conflictData = await checkResp.text();
                return new Response(conflictData, {
                  status: 409,
                  headers: {
                    "Content-Type": "application/json",
                    ...Object.fromEntries(corsHeaders),
                  },
                });
              }
            }
          }

          await env.VAULT_BUCKET.put(r2Key, request.body, {
            httpMetadata: {
              contentType: "application/octet-stream",
            },
          });

          return new Response(
            JSON.stringify({ ok: true, fileId }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                ...Object.fromEntries(corsHeaders),
              },
            }
          );
        }

        case "HEAD": {
          const obj = await env.VAULT_BUCKET.head(r2Key);
          if (!obj) {
            return new Response(null, {
              status: 404,
              headers: corsHeaders,
            });
          }
          const responseHeaders = new Headers(corsHeaders);
          responseHeaders.set("Content-Type", "application/octet-stream");
          if (obj.httpEtag) {
            responseHeaders.set("ETag", obj.httpEtag);
          }
          responseHeaders.set("Content-Length", String(obj.size));
          return new Response(null, {
            status: 200,
            headers: responseHeaders,
          });
        }

        case "GET": {
          const obj = await env.VAULT_BUCKET.get(r2Key);
          if (!obj) {
            return new Response(
              JSON.stringify({ error: "File blob not found" }),
              {
                status: 404,
                headers: {
                  "Content-Type": "application/json",
                  ...Object.fromEntries(corsHeaders),
                },
              }
            );
          }

          const responseHeaders = new Headers(corsHeaders);
          responseHeaders.set("Content-Type", "application/octet-stream");
          if (obj.httpEtag) {
            responseHeaders.set("ETag", obj.httpEtag);
          }
          responseHeaders.set("Cache-Control", "private, no-cache");

          return new Response(obj.body, {
            status: 200,
            headers: responseHeaders,
          });
        }

        case "DELETE": {
          await env.VAULT_BUCKET.delete(r2Key);
          return new Response(
            JSON.stringify({ ok: true, deleted: fileId }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                ...Object.fromEntries(corsHeaders),
              },
            }
          );
        }

        default:
          return new Response(
            JSON.stringify({ error: `Method ${request.method} not allowed` }),
            {
              status: 405,
              headers: {
                "Content-Type": "application/json",
                ...Object.fromEntries(corsHeaders),
              },
            }
          );
      }
    }

    return new Response(
      JSON.stringify({ error: "Not Found", path: url.pathname }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          ...Object.fromEntries(corsHeaders),
        },
      }
    );
  },
};
