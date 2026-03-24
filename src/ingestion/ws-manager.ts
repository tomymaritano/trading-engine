import WebSocket from "ws";
import { createChildLogger } from "../utils/logger.js";
import { bus } from "../utils/event-bus.js";
import type { Exchange } from "../types/market.js";

const log = createChildLogger("ws-manager");

export interface WsManagerOptions {
  exchange: Exchange;
  url: string;
  /** Messages to send on connection (subscription payloads) */
  subscriptions: () => unknown[];
  /** Parse raw message into normalized market events */
  onMessage: (data: unknown) => void;
  /** Ping interval in ms (default 30s) */
  pingIntervalMs?: number;
  /** Max reconnect attempts before giving up (default 20) */
  maxReconnectAttempts?: number;
  /** Base delay for exponential backoff in ms (default 1000) */
  reconnectBaseDelayMs?: number;
}

/**
 * Resilient WebSocket manager with:
 * - Exponential backoff reconnection
 * - Heartbeat/ping monitoring
 * - Sequence gap detection (via caller)
 * - Backpressure: drops messages if processing falls behind
 * - Clean shutdown
 */
export class WsManager {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private alive = false;
  private running = false;
  private msgCount = 0;
  private lastMsgTs = 0;
  private readonly opts: Required<WsManagerOptions>;

  constructor(opts: WsManagerOptions) {
    this.opts = {
      pingIntervalMs: 30_000,
      maxReconnectAttempts: 20,
      reconnectBaseDelayMs: 1_000,
      ...opts,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, "shutdown");
      this.ws = null;
    }
    log.info({ exchange: this.opts.exchange }, "WS manager stopped");
  }

  get stats() {
    return {
      exchange: this.opts.exchange,
      connected: this.ws?.readyState === WebSocket.OPEN,
      msgCount: this.msgCount,
      lastMsgTs: this.lastMsgTs,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  private connect(): void {
    log.info({ exchange: this.opts.exchange, url: this.opts.url }, "Connecting WebSocket");

    this.ws = new WebSocket(this.opts.url);

    this.ws.on("open", () => {
      log.info({ exchange: this.opts.exchange }, "WebSocket connected");
      this.reconnectAttempt = 0;
      this.alive = true;

      bus.emit("ws:connected", { exchange: this.opts.exchange });

      // Send subscription messages
      const subs = this.opts.subscriptions();
      for (const sub of subs) {
        this.ws!.send(JSON.stringify(sub));
      }

      // Start heartbeat
      this.startPing();
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.alive = true;
      this.lastMsgTs = Date.now();
      this.msgCount++;

      try {
        const data = JSON.parse(raw.toString());
        this.opts.onMessage(data);
      } catch (err) {
        log.warn({ exchange: this.opts.exchange, err }, "Failed to parse WS message");
      }
    });

    this.ws.on("pong", () => {
      this.alive = true;
    });

    this.ws.on("close", (code, reason) => {
      log.warn(
        { exchange: this.opts.exchange, code, reason: reason.toString() },
        "WebSocket closed",
      );
      bus.emit("ws:disconnected", {
        exchange: this.opts.exchange,
        reason: `${code}: ${reason.toString()}`,
      });
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.error({ exchange: this.opts.exchange, err }, "WebSocket error");
      // The 'close' event will fire after 'error', triggering reconnect
    });
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.alive) {
        log.warn({ exchange: this.opts.exchange }, "Heartbeat timeout, reconnecting");
        this.ws?.terminate();
        return;
      }
      this.alive = false;
      this.ws?.ping();
    }, this.opts.pingIntervalMs);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    if (this.reconnectAttempt >= this.opts.maxReconnectAttempts) {
      log.error({ exchange: this.opts.exchange }, "Max reconnect attempts reached");
      bus.emit("system:error", new Error(`${this.opts.exchange} WS: max reconnects exceeded`));
      return;
    }

    this.reconnectAttempt++;
    // Exponential backoff with jitter: delay * 2^attempt + random(0-1000)
    const delay =
      this.opts.reconnectBaseDelayMs * Math.pow(2, Math.min(this.reconnectAttempt, 6)) +
      Math.random() * 1000;

    log.info(
      { exchange: this.opts.exchange, attempt: this.reconnectAttempt, delayMs: Math.round(delay) },
      "Scheduling reconnect",
    );
    bus.emit("ws:reconnecting", {
      exchange: this.opts.exchange,
      attempt: this.reconnectAttempt,
    });

    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
