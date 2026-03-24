import { bus } from "../utils/event-bus.js";
import { RingBuffer } from "../utils/ring-buffer.js";
import { orderBookManager } from "../stream/order-book-manager.js";
import {
  ema, stddev, skewness, kurtosis, parkinsonVolatility,
  vwap, bookImbalance, linearSlope,
} from "../utils/math.js";
import { createChildLogger } from "../utils/logger.js";
import type { Trade, Exchange, Symbol } from "../types/market.js";
import type { FeatureVector, MarketRegime } from "../types/signals.js";
import type { AppConfig } from "../config/index.js";

const log = createChildLogger("feature-engine");

interface TradeAccum {
  price: number;
  qty: number;
  side: "buy" | "sell";
  ts: number;
}

/**
 * Feature Engine — computes the FeatureVector at regular intervals.
 *
 * This is where raw market data becomes actionable intelligence.
 * The engine maintains rolling windows of trades, prices, and book states
 * using ring buffers (zero allocation once warmed up).
 *
 * Feature categories:
 * 1. Order book microstructure (spread, imbalance, depth slope)
 * 2. Trade flow (buy/sell pressure, large trade detection, VWAP)
 * 3. Volatility regime (realized vol, Parkinson, vol-of-vol)
 * 4. Liquidity quality (resilience, spread stability)
 * 5. Cross-exchange (lead-lag, spread divergence)
 */
export class FeatureEngine {
  private tradeBuffers = new Map<string, RingBuffer<TradeAccum>>();
  private priceBuffers = new Map<string, RingBuffer<number>>();
  private returnBuffers = new Map<string, RingBuffer<number>>();
  private hlBuffers = new Map<string, RingBuffer<{ high: number; low: number }>>();
  private spreadHistory = new Map<string, RingBuffer<number>>();
  private volumeHistory = new Map<string, RingBuffer<number>>();
  private lastFeature = new Map<string, FeatureVector>();
  private intervals = new Map<string, ReturnType<typeof setInterval>>();

  private readonly tradeWindowSize: number;
  private readonly featureIntervalMs: number;

  constructor(
    private config: AppConfig,
    private symbols: Symbol[],
    private exchanges: Exchange[],
  ) {
    this.tradeWindowSize = Math.ceil(config.features.tradeWindowMs / 100); // ~50 trades at 100ms
    this.featureIntervalMs = config.features.featureIntervalMs;
  }

  start(): void {
    // Initialize buffers for each exchange:symbol pair
    for (const exchange of this.exchanges) {
      for (const symbol of this.symbols) {
        const key = `${exchange}:${symbol}`;
        this.tradeBuffers.set(key, new RingBuffer(500));
        this.priceBuffers.set(key, new RingBuffer(1000));
        this.returnBuffers.set(key, new RingBuffer(500));
        this.hlBuffers.set(key, new RingBuffer(60));   // 60 bars for Parkinson
        this.spreadHistory.set(key, new RingBuffer(200));
        this.volumeHistory.set(key, new RingBuffer(200));
      }
    }

    // Subscribe to trades
    bus.on("market:trade", (trade) => this.onTrade(trade));

    // Compute features at regular intervals
    for (const exchange of this.exchanges) {
      for (const symbol of this.symbols) {
        const key = `${exchange}:${symbol}`;
        const interval = setInterval(() => {
          this.computeAndEmit(exchange, symbol);
        }, this.featureIntervalMs);
        this.intervals.set(key, interval);
      }
    }

    log.info(
      { symbols: this.symbols, exchanges: this.exchanges, intervalMs: this.featureIntervalMs },
      "Feature engine started",
    );
  }

  stop(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }

  getLatest(exchange: Exchange, symbol: Symbol): FeatureVector | undefined {
    return this.lastFeature.get(`${exchange}:${symbol}`);
  }

  private onTrade(trade: Trade): void {
    const key = `${trade.exchange}:${trade.symbol}`;
    const tradeBuf = this.tradeBuffers.get(key);
    const priceBuf = this.priceBuffers.get(key);
    const returnBuf = this.returnBuffers.get(key);

    if (!tradeBuf || !priceBuf) return;

    const price = trade.price.toNumber();
    const qty = trade.qty.toNumber();

    tradeBuf.push({ price, qty, side: trade.side, ts: trade.ts });
    priceBuf.push(price);

    // Compute log return
    const prevPrice = priceBuf.get(1);
    if (prevPrice && prevPrice > 0) {
      returnBuf?.push(Math.log(price / prevPrice));
    }
  }

  private computeAndEmit(exchange: Exchange, symbol: Symbol): void {
    const key = `${exchange}:${symbol}`;
    const trades = this.tradeBuffers.get(key);
    const prices = this.priceBuffers.get(key);
    const returns = this.returnBuffers.get(key);
    const book = orderBookManager.getBook(exchange, symbol);

    if (!trades || !prices || !returns || trades.size < 5) return;

    const now = Date.now();
    const windowMs = this.config.features.tradeWindowMs;

    // Filter trades within the window
    const recentTrades: TradeAccum[] = [];
    for (const t of trades) {
      if (now - t.ts < windowMs) recentTrades.push(t);
    }
    if (recentTrades.length === 0) return;

    // ── Trade flow features ────────────────────────────────
    let buyVol = 0, sellVol = 0, totalVol = 0;
    let largeTrades = 0;
    const allQtys = recentTrades.map((t) => t.qty);
    const meanQty = allQtys.reduce((a, b) => a + b, 0) / allQtys.length;
    const sdQty = stddev(allQtys);
    const largeThreshold = meanQty + 2 * sdQty;

    for (const t of recentTrades) {
      totalVol += t.qty;
      if (t.side === "buy") buyVol += t.qty;
      else sellVol += t.qty;
      if (t.qty > largeThreshold) largeTrades++;
    }

    const tradeImbalance = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;
    const largeTradeRatio = recentTrades.length > 0 ? largeTrades / recentTrades.length : 0;
    const aggIntensity = recentTrades.length / (windowMs / 1000); // trades per second

    // Volume acceleration: compare recent volume to older volume
    const volBuf = this.volumeHistory.get(key);
    volBuf?.push(totalVol);
    const recentVols = volBuf?.toArray() ?? [];
    const volumeAcceleration = recentVols.length >= 2
      ? linearSlope(recentVols.slice(-10))
      : 0;

    // ── Volatility features ────────────────────────────────
    const returnArr = returns.toArray();
    const realizedVol = stddev(returnArr) * Math.sqrt(365 * 24 * 3600 / (windowMs / 1000));
    const returnSkew = skewness(returnArr);
    const returnKurtosis = kurtosis(returnArr);

    // Vol-of-vol: rolling stddev of rolling stddev windows
    const volWindows: number[] = [];
    for (let i = 0; i + 20 <= returnArr.length; i += 10) {
      volWindows.push(stddev(returnArr.slice(i, i + 20)));
    }
    const volOfVol = volWindows.length > 1 ? stddev(volWindows) : 0;

    // Parkinson volatility
    const hlBuf = this.hlBuffers.get(key);
    if (recentTrades.length > 0) {
      const high = Math.max(...recentTrades.map((t) => t.price));
      const low = Math.min(...recentTrades.map((t) => t.price));
      hlBuf?.push({ high, low });
    }
    const parkinsonVol = parkinsonVolatility(hlBuf?.toArray() ?? []);

    // ── Book features ──────────────────────────────────────
    const spreadBuf = this.spreadHistory.get(key);
    if (book) spreadBuf?.push(book.cachedSpreadBps);
    const spreadVol = stddev(spreadBuf?.toArray() ?? []);

    // Depth resilience: how much does depth recover after a large trade?
    // Simplified: compare current depth to average depth
    const depthResilience = 0.5; // TODO: implement properly with depth history

    // When book data is available, compute from depth/spread.
    // When no book (e.g., deltas haven't built up yet), estimate from trade flow.
    // A liquid market has frequent trades with small price changes.
    const liquidityScore = book && book.cachedMidPrice > 0
      ? Math.min(1, (1 / (book.cachedSpreadBps + 1)) * 0.4 +
          Math.min(1, (book.cachedBidDepth + book.cachedAskDepth) / 1_000_000) * 0.3 +
          (1 - Math.min(1, spreadVol / 10)) * 0.3)
      : Math.min(0.7, aggIntensity / 20); // estimate: 20 trades/s = 0.7 liquidity

    // ── Regime detection ───────────────────────────────────
    const { regime, confidence } = this.detectRegime(returnArr, realizedVol, tradeImbalance);

    // ── Cross-exchange features (placeholder) ──────────────
    // In production, compare books across exchanges
    const exchangeSpread = 0;
    const leadLagScore = 0;

    // ── Assemble feature vector ────────────────────────────
    const features: FeatureVector = {
      ts: now,
      symbol,

      // Book
      bidAskSpread: book?.cachedSpread ?? 0,
      midPrice: book?.cachedMidPrice ?? 0,
      weightedMidPrice: book?.cachedWeightedMid ?? 0,
      bookImbalance: book?.cachedImbalanceTop5 ?? 0,
      bookImbalanceTop5: book?.cachedImbalanceTop5 ?? 0,
      bookImbalanceTop20: book?.cachedImbalanceTop20 ?? 0,
      bookDepthBid: book?.cachedBidDepth ?? 0,
      bookDepthAsk: book?.cachedAskDepth ?? 0,
      bidAskSlope: 0, // TODO: implement cumulative depth curve slope

      // Trade flow
      tradeImbalance,
      vwap: vwap(recentTrades),
      volumeAcceleration,
      largeTradeRatio,
      buyPressure: buyVol - sellVol,
      aggTradeIntensity: aggIntensity,

      // Volatility
      realizedVol,
      volOfVol,
      returnSkew,
      returnKurtosis,
      parkinsonVol,

      // Liquidity
      liquidityScore,
      spreadVolatility: spreadVol,
      depthResilience,

      // Cross-exchange
      exchangeSpread,
      leadLagScore,

      // Regime
      regime,
      regimeConfidence: confidence,

      // Funding & liquidations (populated elsewhere)
      fundingRate: 0,
      liquidationPressure: 0,
      openInterestDelta: 0,
    };

    this.lastFeature.set(key, features);
    bus.emit("feature:vector", features);

    // Detect regime changes
    const prevFeature = this.lastFeature.get(key);
    if (prevFeature && prevFeature.regime !== regime) {
      bus.emit("feature:regime_change", {
        symbol,
        from: prevFeature.regime,
        to: regime,
        confidence,
      });
    }
  }

  /**
   * Regime detection via a simple state machine.
   *
   * Production upgrade path: replace with Hidden Markov Model
   * or Gaussian Mixture Model trained on historical features.
   */
  private detectRegime(
    returns: number[],
    realizedVol: number,
    tradeImbalance: number,
  ): { regime: MarketRegime; confidence: number } {
    if (returns.length < 20) return { regime: "low_vol", confidence: 0.3 };

    const recentReturns = returns.slice(-20);
    const trend = linearSlope(recentReturns.map((_, i) =>
      recentReturns.slice(0, i + 1).reduce((a, b) => a + b, 0),
    ));
    const vol = stddev(recentReturns);

    // High volatility regime
    if (vol > 0.02) {
      if (Math.abs(trend) > 0.001) {
        return {
          regime: trend > 0 ? "trending_up" : "trending_down",
          confidence: Math.min(0.9, Math.abs(trend) * 100),
        };
      }
      return { regime: "volatile", confidence: Math.min(0.85, vol * 30) };
    }

    // Low volatility
    if (vol < 0.005) {
      return { regime: "low_vol", confidence: 0.7 };
    }

    // Mean-reverting: strong imbalance tends to revert
    if (Math.abs(tradeImbalance) > 0.3) {
      return { regime: "mean_reverting", confidence: Math.abs(tradeImbalance) };
    }

    // Trending with moderate vol
    if (Math.abs(trend) > 0.0005) {
      return {
        regime: trend > 0 ? "trending_up" : "trending_down",
        confidence: Math.min(0.75, Math.abs(trend) * 200),
      };
    }

    return { regime: "mean_reverting", confidence: 0.5 };
  }
}
