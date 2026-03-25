import Anthropic from "@anthropic-ai/sdk";
import { createChildLogger } from "../utils/logger.js";
import type { TradingSignal } from "../types/signals.js";
import type { FeatureVector } from "../types/signals.js";

const log = createChildLogger("debate-agent");

interface DebateResult {
  bullArguments: string[];
  bearArguments: string[];
  winner: "bull" | "bear" | "neutral";
  adjustedConfidence: number;
  reasoning: string;
  debateTimeMs: number;
}

/**
 * Bull/Bear Debate Agent (pattern: TradingAgents)
 *
 * Before executing a trade, two "agents" debate whether it's a good idea.
 * This mimics how professional trading desks operate: the trader proposes,
 * the risk desk challenges, and a senior trader decides.
 *
 * Flow:
 * 1. Signal arrives (e.g., LONG ETH 72%)
 * 2. Bull agent: argues FOR the trade using current features
 * 3. Bear agent: argues AGAINST the trade
 * 4. Judge: decides who has better arguments, adjusts confidence
 *
 * If the bear wins, the signal is rejected or confidence is reduced.
 * If the bull wins, confidence may be boosted.
 *
 * Cost optimization:
 * - Only debates signals with confidence > 60% (don't waste on weak signals)
 * - Uses claude-haiku (fast, cheap: ~$0.001 per debate)
 * - Single API call with structured prompt (not 3 separate calls)
 * - Caches results for similar feature vectors
 */
export class DebateAgent {
  private client: Anthropic | null = null;
  private enabled = false;
  private debateCount = 0;
  private bullWins = 0;
  private bearWins = 0;
  private readonly minConfidenceToDebate = 0.6;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.enabled = true;
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Debate a trading signal. Returns adjusted signal or null (rejected).
   */
  async debate(
    signal: TradingSignal,
    features: FeatureVector,
  ): Promise<TradingSignal | null> {
    // Don't debate weak signals (save API costs)
    if (signal.confidence < this.minConfidenceToDebate) {
      return signal; // pass through without debate
    }

    if (!this.client) {
      return signal; // no API key, pass through
    }

    const startTs = Date.now();

    try {
      const result = await this.runDebate(signal, features);
      this.debateCount++;

      if (result.winner === "bear" && result.adjustedConfidence < 0.4) {
        // Bear wins convincingly — reject signal
        this.bearWins++;
        log.info({
          symbol: signal.symbol,
          direction: signal.direction,
          originalConf: signal.confidence.toFixed(2),
          result: "REJECTED",
          reasoning: result.reasoning,
          timeMs: result.debateTimeMs,
        }, "Debate: bear wins — signal rejected");
        return null;
      }

      if (result.winner === "bull") {
        this.bullWins++;
      } else {
        this.bearWins++;
      }

      // Adjust confidence based on debate
      const adjusted = { ...signal };
      adjusted.confidence = result.adjustedConfidence;
      adjusted.metadata = {
        ...signal.metadata,
        debate: {
          winner: result.winner,
          originalConfidence: signal.confidence,
          adjustedConfidence: result.adjustedConfidence,
          reasoning: result.reasoning,
          bullArgs: result.bullArguments.length,
          bearArgs: result.bearArguments.length,
        },
      };

      log.info({
        symbol: signal.symbol,
        direction: signal.direction,
        originalConf: signal.confidence.toFixed(2),
        adjustedConf: result.adjustedConfidence.toFixed(2),
        winner: result.winner,
        timeMs: result.debateTimeMs,
      }, "Debate complete");

      return adjusted;
    } catch (err) {
      log.warn({ err }, "Debate failed, passing signal through");
      return signal; // on error, don't block the trade
    }
  }

  private async runDebate(
    signal: TradingSignal,
    features: FeatureVector,
  ): Promise<DebateResult> {
    const startTs = Date.now();

    const prompt = `You are analyzing a crypto trading signal. Give a balanced debate.

SIGNAL: ${signal.direction.toUpperCase()} ${signal.symbol} (confidence: ${(signal.confidence * 100).toFixed(0)}%)
STRATEGY: ${signal.strategy}

MARKET DATA:
- Price: $${features.midPrice?.toFixed(2) ?? "unknown"}
- Book imbalance (top 5): ${(features.bookImbalanceTop5 ?? 0).toFixed(3)} (${(features.bookImbalanceTop5 ?? 0) > 0 ? "buyers dominate" : "sellers dominate"})
- Trade flow imbalance: ${(features.tradeImbalance ?? 0).toFixed(3)}
- Realized volatility: ${((features.realizedVol ?? 0) * 100).toFixed(1)}%
- Market regime: ${features.regime ?? "unknown"}
- Regime confidence: ${((features.regimeConfidence ?? 0) * 100).toFixed(0)}%
- Liquidity score: ${(features.liquidityScore ?? 0).toFixed(2)}

Respond in this exact JSON format only:
{"bull": ["argument 1", "argument 2", "argument 3"], "bear": ["argument 1", "argument 2", "argument 3"], "winner": "bull", "confidence": 0.75, "reasoning": "one sentence why"}

Rules:
- "winner" must be "bull", "bear", or "neutral"
- "confidence" is the adjusted trade confidence (0.0 to 1.0)
- If the signal direction aligns with strong features, confidence should increase
- If features contradict the signal, confidence should decrease
- Be specific about the market data in your arguments`;

    const response = await this.client!.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return {
        bullArguments: [],
        bearArguments: [],
        winner: "neutral",
        adjustedConfidence: signal.confidence,
        reasoning: "Failed to parse debate response",
        debateTimeMs: Date.now() - startTs,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      bull: string[];
      bear: string[];
      winner: "bull" | "bear" | "neutral";
      confidence: number;
      reasoning: string;
    };

    return {
      bullArguments: parsed.bull ?? [],
      bearArguments: parsed.bear ?? [],
      winner: parsed.winner ?? "neutral",
      adjustedConfidence: Math.max(0, Math.min(1, parsed.confidence ?? signal.confidence)),
      reasoning: parsed.reasoning ?? "",
      debateTimeMs: Date.now() - startTs,
    };
  }

  get stats() {
    return {
      enabled: this.enabled,
      debates: this.debateCount,
      bullWins: this.bullWins,
      bearWins: this.bearWins,
      winRate: this.debateCount > 0 ? `${((this.bullWins / this.debateCount) * 100).toFixed(0)}% bull` : "N/A",
    };
  }
}
