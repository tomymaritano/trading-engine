import { bus } from "../utils/event-bus.js";
import { RingBuffer } from "../utils/ring-buffer.js";
import { createChildLogger } from "../utils/logger.js";
import type { Trade, Exchange, Symbol } from "../types/market.js";

const log = createChildLogger("cross-exchange");

interface ExchangePrice {
  exchange: Exchange;
  price: number;
  ts: number;
}

interface SpreadSnapshot {
  ts: number;
  symbol: Symbol;
  /** Max price across exchanges */
  maxPrice: number;
  maxExchange: Exchange;
  /** Min price across exchanges */
  minPrice: number;
  minExchange: Exchange;
  /** Absolute spread in quote currency */
  spreadAbs: number;
  /** Spread in basis points */
  spreadBps: number;
  /** Which exchange moved first (leads) — measured by where price changed first */
  leadExchange: Exchange | null;
  /** Lead-lag score: positive = our primary exchange leads, negative = lags */
  leadLagScore: number;
}

/**
 * Cross-Exchange Analysis Engine
 *
 * Computes real-time spread and lead-lag relationships across exchanges.
 *
 * Key insight: price discovery doesn't happen simultaneously.
 * Binance typically leads for high-cap pairs because it has the most
 * volume. When BTC moves 10 bps on Binance, Kraken/OKX follow
 * 50-500ms later. This delay is the edge.
 *
 * How it works:
 * 1. Track last trade price per exchange per symbol
 * 2. On each trade, compute spread vs other exchanges
 * 3. Detect which exchange's price changed first (lead-lag)
 * 4. Emit cross-exchange features to the feature engine
 *
 * The lead-lag detection uses a simple method:
 * - Track price change timestamps per exchange
 * - The exchange that moves first after a quiet period is the "leader"
 * - Score = cumulative (leader_trades - follower_trades) over a window
 */
export class CrossExchangeEngine {
  private lastPrices = new Map<string, Map<Exchange, ExchangePrice>>();
  private spreadHistory = new Map<string, RingBuffer<SpreadSnapshot>>();
  private priceChangeTimestamps = new Map<string, Map<Exchange, number[]>>();

  constructor(
    private symbols: Symbol[],
    private exchanges: Exchange[],
  ) {
    for (const sym of symbols) {
      this.lastPrices.set(sym, new Map());
      this.spreadHistory.set(sym, new RingBuffer(500));
      const tsMap = new Map<Exchange, number[]>();
      for (const ex of exchanges) tsMap.set(ex, []);
      this.priceChangeTimestamps.set(sym, tsMap);
    }
  }

  start(): void {
    if (this.exchanges.length < 2) {
      log.info("Need 2+ exchanges for cross-exchange analysis, skipping");
      return;
    }

    bus.on("market:trade", (trade) => this.onTrade(trade));
    log.info({ exchanges: this.exchanges, symbols: this.symbols }, "Cross-exchange engine started");
  }

  /** Get latest spread for a symbol */
  getSpread(symbol: Symbol): SpreadSnapshot | undefined {
    return this.spreadHistory.get(symbol)?.latest();
  }

  /** Get average spread over recent history (in bps) */
  getAvgSpreadBps(symbol: Symbol): number {
    const buf = this.spreadHistory.get(symbol);
    if (!buf || buf.size === 0) return 0;
    const spreads = buf.toArray();
    return spreads.reduce((sum, s) => sum + s.spreadBps, 0) / spreads.length;
  }

  /** Get lead-lag score: positive = first exchange leads */
  getLeadLagScore(symbol: Symbol): number {
    const snap = this.getSpread(symbol);
    return snap?.leadLagScore ?? 0;
  }

  private onTrade(trade: Trade): void {
    const sym = trade.symbol;
    const prices = this.lastPrices.get(sym);
    if (!prices) return;

    const prevPrice = prices.get(trade.exchange)?.price ?? 0;
    const newPrice = trade.price.toNumber();

    prices.set(trade.exchange, {
      exchange: trade.exchange,
      price: newPrice,
      ts: trade.ts,
    });

    // Track price changes for lead-lag detection
    if (prevPrice > 0 && Math.abs(newPrice - prevPrice) / prevPrice > 0.00005) {
      // Price changed by > 0.5 bps — significant
      const tsMap = this.priceChangeTimestamps.get(sym);
      const changes = tsMap?.get(trade.exchange);
      if (changes) {
        changes.push(trade.ts);
        // Keep last 200 changes
        if (changes.length > 200) changes.splice(0, 100);
      }
    }

    // Need prices from at least 2 exchanges to compute spread
    if (prices.size < 2) return;

    // Compute spread
    let maxPrice = -Infinity, minPrice = Infinity;
    let maxExchange: Exchange = trade.exchange;
    let minExchange: Exchange = trade.exchange;

    for (const [ex, data] of prices) {
      // Only consider fresh prices (< 5s old)
      if (trade.ts - data.ts > 5000) continue;

      if (data.price > maxPrice) {
        maxPrice = data.price;
        maxExchange = ex;
      }
      if (data.price < minPrice) {
        minPrice = data.price;
        minExchange = ex;
      }
    }

    if (maxPrice === -Infinity || minPrice === Infinity) return;

    const midPrice = (maxPrice + minPrice) / 2;
    const spreadAbs = maxPrice - minPrice;
    const spreadBps = midPrice > 0 ? (spreadAbs / midPrice) * 10000 : 0;

    // Lead-lag scoring
    const leadLag = this.computeLeadLag(sym, trade.ts);

    const snapshot: SpreadSnapshot = {
      ts: trade.ts,
      symbol: sym,
      maxPrice,
      maxExchange,
      minPrice,
      minExchange,
      spreadAbs,
      spreadBps,
      leadExchange: leadLag.leader,
      leadLagScore: leadLag.score,
    };

    this.spreadHistory.get(sym)?.push(snapshot);
  }

  /**
   * Compute lead-lag by comparing price change timestamps.
   *
   * For each pair of consecutive price movements across exchanges,
   * the exchange that moved first gets +1, the follower gets -1.
   * The score is the cumulative sum over a recent window.
   */
  private computeLeadLag(
    symbol: Symbol,
    now: number,
  ): { leader: Exchange | null; score: number } {
    const tsMap = this.priceChangeTimestamps.get(symbol);
    if (!tsMap || this.exchanges.length < 2) {
      return { leader: null, score: 0 };
    }

    const windowMs = 60_000; // look at last 60s of price changes
    const scores = new Map<Exchange, number>();

    for (const ex of this.exchanges) {
      scores.set(ex, 0);
    }

    // For each exchange pair, count who moved first
    for (let i = 0; i < this.exchanges.length; i++) {
      for (let j = i + 1; j < this.exchanges.length; j++) {
        const exA = this.exchanges[i];
        const exB = this.exchanges[j];
        const changesA = (tsMap.get(exA) ?? []).filter((t) => now - t < windowMs);
        const changesB = (tsMap.get(exB) ?? []).filter((t) => now - t < windowMs);

        // Count how many times A moved before B (within 500ms window)
        let aLeads = 0, bLeads = 0;

        for (const tA of changesA) {
          // Find closest change in B after tA
          const bAfter = changesB.find((tB) => tB > tA && tB - tA < 500);
          if (bAfter) aLeads++;
        }

        for (const tB of changesB) {
          const aAfter = changesA.find((tA) => tA > tB && tA - tB < 500);
          if (aAfter) bLeads++;
        }

        scores.set(exA, (scores.get(exA) ?? 0) + aLeads - bLeads);
        scores.set(exB, (scores.get(exB) ?? 0) + bLeads - aLeads);
      }
    }

    // Find the leader
    let leader: Exchange | null = null;
    let maxScore = 0;

    for (const [ex, score] of scores) {
      if (score > maxScore) {
        maxScore = score;
        leader = ex;
      }
    }

    // Normalize score to [-1, 1] range
    const totalChanges = [...scores.values()].reduce((a, b) => a + Math.abs(b), 0);
    const normalizedScore = totalChanges > 0
      ? (scores.get(this.exchanges[0]) ?? 0) / (totalChanges / 2)
      : 0;

    return { leader, score: normalizedScore };
  }
}
