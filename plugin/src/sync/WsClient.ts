/**
 * Robust, Auto-reconnecting WebSocket Client with Exponential Backoff & Heartbeat.
 *
 * Utilizes native window.WebSocket with zero Node.js dependencies.
 */

import { ClientMessage, ServerMessage } from "../types";

export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "reconnecting";

export interface WsClientOptions {
  workerUrl: string;
  vaultId: string;
  authToken: string;
  clientId: string;
  onMessage: (message: ServerMessage) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onError?: (error: unknown) => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private workerUrl: string;
  private vaultId: string;
  private authToken: string;
  private clientId: string;

  private onMessage: (message: ServerMessage) => void;
  private onStatusChange?: (status: ConnectionStatus) => void;
  private onError?: (error: unknown) => void;

  private isExplicitlyClosed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatIntervalTimer: number | null = null;
  private heartbeatTimeoutTimer: number | null = null;

  private readonly PING_INTERVAL_MS = 25000; // 25s
  private readonly PONG_TIMEOUT_MS = 10000; // 10s
  private readonly BASE_RECONNECT_DELAY_MS = 1000;
  private readonly MAX_RECONNECT_DELAY_MS = 30000;

  constructor(options: WsClientOptions) {
    this.workerUrl = options.workerUrl;
    this.vaultId = options.vaultId;
    this.authToken = options.authToken;
    this.clientId = options.clientId;
    this.onMessage = options.onMessage;
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
  }

  updateConfig(workerUrl: string, vaultId: string, authToken: string): void {
    const changed =
      this.workerUrl !== workerUrl ||
      this.vaultId !== vaultId ||
      this.authToken !== authToken;

    this.workerUrl = workerUrl;
    this.vaultId = vaultId;
    this.authToken = authToken;

    if (changed && this.ws) {
      this.reconnect();
    }
  }

  /**
   * Connect to the Cloudflare Worker Durable Object WebSocket endpoint
   */
  connect(): void {
    if (!this.workerUrl || !this.vaultId || !this.authToken) {
      this.setStatus("disconnected");
      return;
    }

    this.isExplicitlyClosed = false;
    this.clearTimers();

    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }

    const wsUrl = this.buildWebSocketUrl();
    this.setStatus("connecting");

    try {
      this.ws = new window.WebSocket(wsUrl);
    } catch (err) {
      this.handleSocketError(err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      this.startHeartbeat();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleIncomingRawMessage(event.data);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.clearTimers();
      this.ws = null;

      if (!this.isExplicitlyClosed) {
        this.setStatus("disconnected");
        this.scheduleReconnect();
      } else {
        this.setStatus("disconnected");
      }
    };

    this.ws.onerror = (event: Event) => {
      this.handleSocketError(event);
    };
  }

  /**
   * Close connection explicitly
   */
  disconnect(): void {
    this.isExplicitlyClosed = true;
    this.clearTimers();

    if (this.ws) {
      try {
        this.ws.close(1000, "Client initiated disconnect");
      } catch (_) {}
      this.ws = null;
    }

    this.setStatus("disconnected");
  }

  /**
   * Force an immediate reconnection
   */
  reconnect(): void {
    this.disconnect();
    this.reconnectAttempts = 0;
    this.connect();
  }

  /**
   * Check if WebSocket is currently OPEN
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === window.WebSocket.OPEN;
  }

  /**
   * Send a JSON protocol message to server
   */
  send(message: ClientMessage): boolean {
    if (!this.isConnected() || !this.ws) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this.handleSocketError(err);
      return false;
    }
  }

  private buildWebSocketUrl(): string {
    const rawUrl = this.workerUrl.replace(/\/+$/, "");
    let wsScheme = "wss://";
    let hostAndPath = rawUrl;

    if (rawUrl.startsWith("http://")) {
      wsScheme = "ws://";
      hostAndPath = rawUrl.substring(7);
    } else if (rawUrl.startsWith("https://")) {
      wsScheme = "wss://";
      hostAndPath = rawUrl.substring(8);
    } else if (rawUrl.startsWith("ws://") || rawUrl.startsWith("wss://")) {
      // already ws/wss
      return `${rawUrl}/api/vault/${encodeURIComponent(this.vaultId)}/ws?token=${encodeURIComponent(this.authToken)}&vaultId=${encodeURIComponent(this.vaultId)}&clientId=${encodeURIComponent(this.clientId)}`;
    }

    return `${wsScheme}${hostAndPath}/api/vault/${encodeURIComponent(this.vaultId)}/ws?token=${encodeURIComponent(this.authToken)}&vaultId=${encodeURIComponent(this.vaultId)}&clientId=${encodeURIComponent(this.clientId)}`;
  }

  private handleIncomingRawMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }

    try {
      const parsed = JSON.parse(data) as ServerMessage;

      // Handle heartbeat responses internally
      if (parsed.type === "PONG") {
        this.clearHeartbeatTimeout();
        return;
      }

      this.onMessage(parsed);
    } catch (err) {
      console.warn("[WsClient] Failed to parse message:", err);
    }
  }

  private startHeartbeat(): void {
    this.clearTimers();

    this.heartbeatIntervalTimer = window.setInterval(() => {
      if (this.isConnected()) {
        this.send({ type: "PING" });

        // Clear any previous pending pong timeout before scheduling a new one
        this.clearHeartbeatTimeout();

        // Set deadline for receiving PONG
        this.heartbeatTimeoutTimer = window.setTimeout(() => {
          console.warn("[WsClient] Heartbeat timeout. Server did not reply with PONG.");
          if (this.ws) {
            try {
              this.ws.close(4000, "Heartbeat timeout");
            } catch (_) {}
          }
        }, this.PONG_TIMEOUT_MS);
      }
    }, this.PING_INTERVAL_MS);
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer !== null) {
      window.clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.isExplicitlyClosed || this.reconnectTimer !== null) {
      return;
    }

    this.setStatus("reconnecting");
    this.reconnectAttempts++;

    // Exponential backoff with random jitter (0.8x - 1.2x)
    const factor = Math.min(Math.pow(1.5, this.reconnectAttempts - 1), 30);
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.min(
      this.BASE_RECONNECT_DELAY_MS * factor * jitter,
      this.MAX_RECONNECT_DELAY_MS
    );

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatIntervalTimer !== null) {
      window.clearInterval(this.heartbeatIntervalTimer);
      this.heartbeatIntervalTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  private handleSocketError(error: unknown): void {
    if (this.onError) {
      this.onError(error);
    }
  }
}
