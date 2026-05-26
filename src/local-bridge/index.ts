/**
 * local-bridge/index.ts
 * WebSocket bridge between an agent process and the hive-dashboard hub.
 * Publishes agent events to the hub and receives inbound dashboard messages.
 */

import WebSocket from "ws";

// ── Types ──

export interface InboundMessage {
  id: string;
  text: string;
  attachments?: string[];
  isSlashCommand: boolean;
  rawCommand?: string;
  channelKey: string;
}

export type BridgeEvent =
  | { type: "user_message"; source: "discord" | "dashboard"; text: string; attachments?: Array<{ url: string; mediaType: string }>; channelKey: string; ts: number }
  | { type: "agent_text"; text: string; channelKey: string; ts: number; final: boolean }
  | { type: "tool_use"; toolName: string; channelKey: string; ts: number }
  | { type: "tool_result"; toolName: string; channelKey: string; ts: number; ok: boolean }
  | { type: "system"; text: string; channelKey: string; ts: number }
  | { type: "session_reset"; channelKey: string; ts: number }
  | { type: "agent_status"; status: "online" | "thinking" | "idle"; ts: number };

export interface LocalBridgeHandle {
  publish(event: BridgeEvent): void;
  close(): void;
}

interface BridgeOptions {
  agentName: string;
  hubUrl: string;
  onInboundMessage: (payload: InboundMessage) => Promise<void>;
}

interface BridgeRuntime {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  createWebSocket: (url: string) => WebSocket;
  openState: number;
}

// ── Reconnect delays ──

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

const DEFAULT_RUNTIME: BridgeRuntime = {
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  setTimeout,
  clearTimeout,
  createWebSocket: (url) => new WebSocket(url),
  openState: WebSocket.OPEN,
};

export function startLocalBridge(opts: BridgeOptions, runtime: BridgeRuntime = DEFAULT_RUNTIME): LocalBridgeHandle {
  const { agentName, hubUrl, onInboundMessage } = opts;

  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  if (!hubUrl || typeof hubUrl !== "string" || hubUrl.length === 0) {
    runtime.log("[local-bridge] hubUrl unset — bridge disabled");
    return {
      publish(): void {},
      close(): void {},
    };
  }

  function connect(): void {
    if (closed) return;

    try {
      ws = runtime.createWebSocket(hubUrl);
    } catch (err) {
      runtime.log(`[local-bridge] Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      runtime.log(`[local-bridge] Connected to ${hubUrl}`);
      reconnectAttempt = 0;

      // Announce online status
      safeSend({
        type: "agent_status",
        status: "online",
        ts: Date.now(),
      });
    });

    ws.on("message", (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.kind === "send" && data.payload) {
          const payload = data.payload as InboundMessage;
          onInboundMessage(payload).catch(err => {
            runtime.error(`[local-bridge] Error handling inbound message:`, err);
          });
        }
      } catch (err) {
        runtime.error(`[local-bridge] Failed to parse message:`, err);
      }
    });

    ws.on("close", () => {
      runtime.log("[local-bridge] Disconnected from hub");
      ws = null;
      if (!closed) scheduleReconnect();
    });

    ws.on("error", (err) => {
      // Suppress ECONNREFUSED noise — reconnect will handle it
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ECONNREFUSED") {
        runtime.error(`[local-bridge] WebSocket error:`, err.message);
      }
    });
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    const idx = Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[idx];
    reconnectAttempt++;
    runtime.log(`[local-bridge] reconnecting in ${delay}ms...`);
    reconnectTimer = runtime.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function safeSend(event: BridgeEvent): void {
    if (ws && ws.readyState === runtime.openState) {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // drop silently — dashboard is best-effort
      }
    }
    // If disconnected, drop silently (no buffer)
  }

  // Start initial connection
  connect();

  return {
    publish(event: BridgeEvent): void {
      safeSend(event);
    },
    close(): void {
      closed = true;
      if (reconnectTimer) {
        runtime.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
    },
  };
}
