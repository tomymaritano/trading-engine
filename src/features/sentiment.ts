import { createChildLogger } from "../utils/logger.js";
import { bus } from "../utils/event-bus.js";
import { RingBuffer } from "../utils/ring-buffer.js";
import { sleep } from "../utils/time.js";
import type { Symbol } from "../types/market.js";

const log = createChildLogger("sentiment");

interface SentimentData {
  ts: number;
  symbol: Symbol;
  /** -1 (extreme fear) to +1 (extreme greed) */
  score: number;
  source: string;
  /** Raw count of positive/negative mentions */
  positiveMentions: number;
  negativeMentions: number;
  totalMentions: number;
}

/**
 * Sentiment Analysis Engine
 *
 * Aggregates sentiment signals from multiple sources:
 * 1. Fear & Greed Index (crypto-specific)
 * 2. Funding rate bias (positive = greedy longs, negative = fearful)
 * 3. Liquidation asymmetry (more long liqs = bearish sentiment)
 * 4. Social media volume spikes (proxy for retail FOMO/panic)
 *
 * Architecture decision: we use proxy signals instead of NLP because:
 * - NLP sentiment on crypto Twitter is noisy (irony, memes, bots)
 * - Funding rate and liquidation data are FACTUAL, not opinion
 * - Fear & Greed Index already aggregates social signals
 * - Latency: NLP adds 100ms+, proxy signals are sub-ms
 *
 * For Phase 3, add:
 * - RSS/Atom feed monitoring for major news (CoinDesk, The Block)
 * - LLM-based sentiment extraction from headlines
 * - On-chain metrics (exchange inflows, whale movements)
 */
export class SentimentEngine {
  private history = new Map<string, RingBuffer<SentimentData>>();
  private fearGreedCache: { ts: number; value: number } | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private symbols: Symbol[]) {
    for (const sym of symbols) {
      this.history.set(sym, new RingBuffer(500));
    }
  }

  start(): void {
    // Poll Fear & Greed Index every 5 minutes
    this.pollInterval = setInterval(() => {
      this.fetchFearGreedIndex().catch((err) =>
        log.warn({ err }, "Failed to fetch Fear & Greed Index"),
      );
    }, 5 * 60_000);

    // Initial fetch
    this.fetchFearGreedIndex().catch(() => {});

    // Derive sentiment from market events
    bus.on("market:liquidation", (liq) => {
      this.onLiquidation(liq);
    });

    bus.on("market:funding", (funding) => {
      this.onFundingRate(funding);
    });

    log.info({ symbols: this.symbols }, "Sentiment engine started");
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  /** Get current composite sentiment score for a symbol */
  getScore(symbol: Symbol): number {
    const buf = this.history.get(symbol);
    if (!buf || buf.size === 0) return 0;

    // Weighted average of recent sentiment, newer = heavier weight
    const entries = buf.toArray();
    const alpha = 0.3; // exponential decay
    let weightedSum = 0;
    let weightSum = 0;

    for (let i = 0; i < entries.length; i++) {
      const weight = Math.pow(1 - alpha, entries.length - 1 - i);
      weightedSum += entries[i].score * weight;
      weightSum += weight;
    }

    return weightSum > 0 ? weightedSum / weightSum : 0;
  }

  /** Get Fear & Greed Index (0-100, cached) */
  getFearGreedIndex(): number {
    return this.fearGreedCache?.value ?? 50;
  }

  private async fetchFearGreedIndex(): Promise<void> {
    try {
      const res = await fetch("https://api.alternative.me/fng/?limit=1");
      if (!res.ok) return;

      const json = await res.json() as {
        data: Array<{ value: string; timestamp: string }>;
      };

      if (json.data && json.data[0]) {
        const value = Number(json.data[0].value);
        this.fearGreedCache = { ts: Date.now(), value };

        // Convert 0-100 to -1 to +1 scale
        const normalizedScore = (value - 50) / 50;

        for (const symbol of this.symbols) {
          this.addSentiment({
            ts: Date.now(),
            symbol,
            score: normalizedScore,
            source: "fear_greed_index",
            positiveMentions: 0,
            negativeMentions: 0,
            totalMentions: 0,
          });
        }

        log.debug({ value, normalized: normalizedScore.toFixed(2) }, "Fear & Greed updated");
      }
    } catch {
      // Silently fail — sentiment is supplementary
    }
  }

  /**
   * Derive sentiment from liquidation events.
   *
   * Mass long liquidations → bearish sentiment (forced selling)
   * Mass short liquidations → bullish sentiment (short squeeze)
   */
  private onLiquidation(liq: { symbol: string; side: "long" | "short"; notional: { toNumber(): number } }): void {
    const notional = liq.notional.toNumber();
    // Significant liquidation: > $100k
    if (notional < 100_000) return;

    const score = liq.side === "long" ? -0.3 : 0.3; // long liqs are bearish
    const scaled = score * Math.min(1, notional / 1_000_000); // scale by size

    this.addSentiment({
      ts: Date.now(),
      symbol: liq.symbol,
      score: scaled,
      source: "liquidation",
      positiveMentions: liq.side === "short" ? 1 : 0,
      negativeMentions: liq.side === "long" ? 1 : 0,
      totalMentions: 1,
    });
  }

  /**
   * Derive sentiment from funding rate.
   *
   * High positive funding → longs are greedy, paying to stay leveraged
   * High negative funding → shorts dominate, market is fearful
   */
  private onFundingRate(funding: { symbol: string; rate: { toNumber(): number } }): void {
    const rate = funding.rate.toNumber();
    // Typical funding is ±0.01%. Beyond ±0.05% is extreme.
    const score = Math.max(-1, Math.min(1, rate * 2000)); // scale: 0.05% → ±1

    this.addSentiment({
      ts: Date.now(),
      symbol: funding.symbol,
      score,
      source: "funding_rate",
      positiveMentions: 0,
      negativeMentions: 0,
      totalMentions: 0,
    });
  }

  private addSentiment(data: SentimentData): void {
    const buf = this.history.get(data.symbol);
    if (buf) buf.push(data);
  }
}
