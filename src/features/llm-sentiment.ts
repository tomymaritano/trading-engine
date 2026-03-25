import Anthropic from "@anthropic-ai/sdk";
import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";
import type { Symbol } from "../types/market.js";

const log = createChildLogger("llm-sentiment");

interface HeadlineSentiment {
  headline: string;
  sentiment: number; // -1 to +1
  confidence: number;
}

interface LLMSentimentResult {
  ts: number;
  symbol: Symbol;
  overallSentiment: number; // -1 (bearish) to +1 (bullish)
  headlines: HeadlineSentiment[];
  source: string;
}

/**
 * LLM Sentiment Agent (pattern: TradingAgents)
 *
 * Uses Claude to analyze crypto news headlines and extract
 * actionable sentiment signals.
 *
 * Why LLM instead of rule-based?
 * - Understands context: "ETH merge delayed" is bearish, "ETH merge successful" is bullish
 * - Handles sarcasm, nuance, and crypto-specific jargon
 * - Adapts to new narratives without retraining
 *
 * Cost: ~$0.01 per analysis (10 headlines × claude-haiku)
 * Frequency: every 5 minutes
 * Sources: CryptoPanic API (free, aggregates multiple outlets)
 */
export class LLMSentimentAgent {
  private client: Anthropic | null = null;
  private enabled = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private analysisCount = 0;
  private lastResults = new Map<string, LLMSentimentResult>();

  constructor(private symbols: Symbol[]) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.enabled = true;
    }
  }

  start(): void {
    if (!this.enabled) {
      log.info("LLM sentiment disabled (set ANTHROPIC_API_KEY)");
      return;
    }

    // Initial analysis
    this.analyzeAll().catch((err) => log.warn({ err }, "Initial sentiment analysis failed"));

    // Poll every 5 minutes
    this.pollInterval = setInterval(() => {
      this.analyzeAll().catch((err) => log.warn({ err }, "Sentiment analysis failed"));
    }, 5 * 60_000);

    log.info({ symbols: this.symbols }, "LLM sentiment agent started");
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  /** Get latest sentiment for a symbol */
  getSentiment(symbol: Symbol): number {
    return this.lastResults.get(symbol)?.overallSentiment ?? 0;
  }

  private async analyzeAll(): Promise<void> {
    // Fetch headlines
    const headlines = await this.fetchHeadlines();
    if (headlines.length === 0) return;

    // Analyze with Claude for each symbol
    for (const symbol of this.symbols) {
      const base = symbol.split("-")[0]; // ETH-USDT → ETH
      const relevant = headlines.filter((h) =>
        h.toLowerCase().includes(base.toLowerCase()) ||
        h.toLowerCase().includes("crypto") ||
        h.toLowerCase().includes("bitcoin") ||
        h.toLowerCase().includes("market"),
      );

      if (relevant.length === 0) continue;

      const result = await this.analyzeSentiment(symbol, relevant.slice(0, 10));
      if (result) {
        this.lastResults.set(symbol, result);

        // Emit to sentiment engine via bus
        bus.emit("feature:anomaly", {
          symbol,
          type: "llm_sentiment",
          severity: Math.abs(result.overallSentiment),
          details: `LLM sentiment: ${result.overallSentiment > 0 ? "bullish" : "bearish"} (${(result.overallSentiment * 100).toFixed(0)}%), ${result.headlines.length} headlines`,
        });
      }
    }
  }

  private async analyzeSentiment(symbol: Symbol, headlines: string[]): Promise<LLMSentimentResult | null> {
    if (!this.client) return null;

    try {
      const response = await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: `Analyze these crypto news headlines for ${symbol} trading sentiment.

Headlines:
${headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

For each headline, rate sentiment from -1.0 (very bearish) to +1.0 (very bullish).
Then give an overall sentiment score.

Respond in this exact JSON format only, no other text:
{"overall": 0.3, "headlines": [{"idx": 1, "score": 0.5, "conf": 0.8}, {"idx": 2, "score": -0.3, "conf": 0.6}]}`,
        }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";

      // Parse JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as {
        overall: number;
        headlines: Array<{ idx: number; score: number; conf: number }>;
      };

      this.analysisCount++;

      const result: LLMSentimentResult = {
        ts: Date.now(),
        symbol,
        overallSentiment: Math.max(-1, Math.min(1, parsed.overall)),
        headlines: parsed.headlines.map((h) => ({
          headline: headlines[h.idx - 1] ?? "",
          sentiment: Math.max(-1, Math.min(1, h.score)),
          confidence: Math.max(0, Math.min(1, h.conf)),
        })),
        source: "claude_haiku",
      };

      log.info({
        symbol,
        sentiment: result.overallSentiment.toFixed(2),
        headlines: result.headlines.length,
      }, "LLM sentiment analyzed");

      return result;
    } catch (err) {
      log.warn({ err, symbol }, "LLM sentiment analysis failed");
      return null;
    }
  }

  /**
   * Fetch crypto news headlines from CryptoPanic (free API).
   * Falls back to a simple Google News RSS if CryptoPanic is unavailable.
   */
  private async fetchHeadlines(): Promise<string[]> {
    try {
      // CryptoPanic free API (no auth needed for public posts)
      const res = await fetch(
        "https://cryptopanic.com/api/free/v1/posts/?auth_token=&public=true&kind=news",
        { signal: AbortSignal.timeout(5000) },
      );

      if (res.ok) {
        const data = await res.json() as { results: Array<{ title: string }> };
        return (data.results ?? []).map((r) => r.title).slice(0, 20);
      }
    } catch {
      // CryptoPanic failed, try fallback
    }

    // Fallback: CoinGecko status updates (always available)
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/status_updates?per_page=20",
        { signal: AbortSignal.timeout(5000) },
      );

      if (res.ok) {
        const data = await res.json() as { status_updates: Array<{ body: string }> };
        return (data.status_updates ?? []).map((u) => u.body.slice(0, 200)).slice(0, 20);
      }
    } catch {
      // Both sources failed
    }

    return [];
  }

  get stats() {
    return {
      enabled: this.enabled,
      analyses: this.analysisCount,
      symbols: [...this.lastResults.keys()],
    };
  }
}
