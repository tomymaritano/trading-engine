import Redis from "ioredis";
import { createChildLogger } from "../utils/logger.js";
import { bus } from "../utils/event-bus.js";

const log = createChildLogger("redis-state");

const KEYS = {
  equityHistory: "cx:equity_history",
  positions: "cx:positions",
  latestPrices: "cx:prices",
  features: "cx:features",
  sessionState: "cx:session",
  priceHistory: (symbol: string) => `cx:price_history:${symbol}`,
} as const;

const MAX_EQUITY_POINTS = 2000;
const MAX_PRICE_POINTS = 2000;

export interface RedisStateOptions {
  url: string;
}

/**
 * Redis state adapter — real-time state that survives engine restarts.
 *
 * Replaces the old state-history.json file with Redis-backed storage.
 * Uses Redis data structures optimized for each use case:
 * - Sorted sets for time-series (equity, prices) — auto-trimmed
 * - Hashes for current state (positions, features, session)
 * - Simple keys with TTL for ephemeral data
 */
export class RedisState {
  private redis: Redis;
  private connected = false;

  constructor(opts: RedisStateOptions) {
    this.redis = new Redis(opts.url, {
      retryStrategy: (times) => Math.min(times * 500, 5000),
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }

  async start(): Promise<void> {
    try {
      await this.redis.connect();
      this.connected = true;
      log.info("Connected to Redis");
    } catch (err) {
      log.error({ err }, "Failed to connect to Redis");
      return;
    }

    this.subscribeToEvents();
    await this.initSession();
    log.info("Redis state tracking started");
  }

  async stop(): Promise<void> {
    this.redis.disconnect();
    log.info("Redis state stopped");
  }

  // ── Write methods ───────────────────────────────────────────

  async addEquityPoint(equity: number): Promise<void> {
    if (!this.connected) return;
    const ts = Date.now();
    const pipeline = this.redis.pipeline();
    pipeline.zadd(KEYS.equityHistory, ts, JSON.stringify({ ts, equity }));
    pipeline.zremrangebyrank(KEYS.equityHistory, 0, -(MAX_EQUITY_POINTS + 1));
    await pipeline.exec();
  }

  async updatePrice(symbol: string, price: number): Promise<void> {
    if (!this.connected) return;
    const ts = Date.now();
    const pipeline = this.redis.pipeline();
    pipeline.hset(KEYS.latestPrices, symbol, JSON.stringify({ price, ts }));
    pipeline.zadd(KEYS.priceHistory(symbol), ts, JSON.stringify({ ts, price }));
    pipeline.zremrangebyrank(KEYS.priceHistory(symbol), 0, -(MAX_PRICE_POINTS + 1));
    await pipeline.exec();
  }

  async updatePositions(positions: Record<string, unknown>): Promise<void> {
    if (!this.connected) return;
    await this.redis.set(KEYS.positions, JSON.stringify(positions), "EX", 300);
  }

  async updateFeatures(symbol: string, features: Record<string, number>): Promise<void> {
    if (!this.connected) return;
    await this.redis.hset(KEYS.features, symbol, JSON.stringify(features));
  }

  async recordTrade(): Promise<void> {
    if (!this.connected) return;
    await this.redis.hincrby(KEYS.sessionState, "totalTrades", 1);
  }

  async recordSignal(): Promise<void> {
    if (!this.connected) return;
    await this.redis.hincrby(KEYS.sessionState, "totalSignals", 1);
  }

  // ── Read methods (for dashboard restore) ────────────────────

  async getEquityHistory(): Promise<{ ts: number; equity: number }[]> {
    if (!this.connected) return [];
    const raw = await this.redis.zrange(KEYS.equityHistory, 0, -1);
    return raw.map((r) => JSON.parse(r));
  }

  async getPriceHistory(symbol: string): Promise<{ ts: number; price: number }[]> {
    if (!this.connected) return [];
    const raw = await this.redis.zrange(KEYS.priceHistory(symbol), 0, -1);
    return raw.map((r) => JSON.parse(r));
  }

  async getLatestPrices(): Promise<Record<string, { price: number; ts: number }>> {
    if (!this.connected) return {};
    const raw = await this.redis.hgetall(KEYS.latestPrices);
    const result: Record<string, { price: number; ts: number }> = {};
    for (const [symbol, json] of Object.entries(raw)) {
      result[symbol] = JSON.parse(json);
    }
    return result;
  }

  async getPositions(): Promise<Record<string, unknown> | null> {
    if (!this.connected) return null;
    const raw = await this.redis.get(KEYS.positions);
    return raw ? JSON.parse(raw) : null;
  }

  async getFeatures(): Promise<Record<string, Record<string, number>>> {
    if (!this.connected) return {};
    const raw = await this.redis.hgetall(KEYS.features);
    const result: Record<string, Record<string, number>> = {};
    for (const [symbol, json] of Object.entries(raw)) {
      result[symbol] = JSON.parse(json);
    }
    return result;
  }

  async getSessionState(): Promise<{ totalTrades: number; totalSignals: number; sessionStart: number }> {
    if (!this.connected) return { totalTrades: 0, totalSignals: 0, sessionStart: Date.now() };
    const raw = await this.redis.hgetall(KEYS.sessionState);
    return {
      totalTrades: parseInt(raw.totalTrades ?? "0", 10),
      totalSignals: parseInt(raw.totalSignals ?? "0", 10),
      sessionStart: parseInt(raw.sessionStart ?? String(Date.now()), 10),
    };
  }

  /** Full state restore for dashboard (replaces old getStateHistory) */
  async getFullState(): Promise<{
    equityHistory: { ts: number; equity: number }[];
    latestPrices: Record<string, { price: number; ts: number }>;
    session: { totalTrades: number; totalSignals: number; sessionStart: number };
  }> {
    const [equityHistory, latestPrices, session] = await Promise.all([
      this.getEquityHistory(),
      this.getLatestPrices(),
      this.getSessionState(),
    ]);
    return { equityHistory, latestPrices, session };
  }

  get stats() {
    return { connected: this.connected };
  }

  // ── Private ─────────────────────────────────────────────────

  private async initSession(): Promise<void> {
    const existing = await this.redis.hget(KEYS.sessionState, "sessionStart");
    if (!existing) {
      await this.redis.hset(KEYS.sessionState, "sessionStart", Date.now());
    }
  }

  private subscribeToEvents(): void {
    // Throttle price updates to 1 per symbol per 2 seconds
    const lastPriceTs: Record<string, number> = {};
    bus.on("market:trade", (trade) => {
      const now = Date.now();
      if (lastPriceTs[trade.symbol] && now - lastPriceTs[trade.symbol] < 2000) return;
      lastPriceTs[trade.symbol] = now;
      this.updatePrice(trade.symbol, trade.price.toNumber());
    });

    bus.on("order:filled", () => {
      this.recordTrade();
    });

    bus.on("signal:new", () => {
      this.recordSignal();
    });

    bus.on("feature:vector", (features) => {
      if (features.symbol) {
        this.updateFeatures(features.symbol, features as unknown as Record<string, number>);
      }
    });
  }
}
