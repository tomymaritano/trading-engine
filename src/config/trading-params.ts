import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("trading-params");

/**
 * Runtime Trading Parameters — configurable from the dashboard.
 *
 * These are the knobs the user controls:
 * - Trade size (fixed $ amount per trade)
 * - Leverage (1x-10x)
 * - Mode (paper/live)
 * - Safety checks (model requirements)
 */

export const TradingParamsSchema = z.object({
  /** Fixed $ amount per trade (overrides maxPositionPct if set) */
  tradeSize: z.number().min(0.10).max(100_000).default(200),

  /** Leverage multiplier (1x = no leverage) */
  leverage: z.number().min(1).max(10).default(1),

  /** Trading mode */
  mode: z.enum(["paper", "live"]).default("paper"),

  /** Require trained ML model to start live trading */
  requireTrainedModel: z.boolean().default(true),

  /** Minimum days of training data required for live mode */
  minTrainingDays: z.number().default(14),

  /** Minimum out-of-sample Sharpe ratio required for live mode */
  minSharpeForLive: z.number().default(0),

  /** Wallet address for dYdX (empty = not connected) */
  walletAddress: z.string().default(""),

  /** Exchange for live trading */
  liveExchange: z.enum(["binance_futures", "dydx", "none"]).default("none"),
});

export type TradingParams = z.infer<typeof TradingParamsSchema>;

/** Global mutable trading params — updated from dashboard */
let currentParams: TradingParams = TradingParamsSchema.parse({});

export function getTradingParams(): TradingParams {
  return { ...currentParams };
}

export function updateTradingParams(update: Partial<TradingParams>): TradingParams {
  const merged = { ...currentParams, ...update };
  currentParams = TradingParamsSchema.parse(merged);
  log.info({ params: currentParams }, "Trading params updated");
  return currentParams;
}

/**
 * Pre-flight checks before allowing live trading.
 * Returns list of failed checks (empty = all clear).
 */
export function preflightChecks(params: TradingParams): string[] {
  const failures: string[] = [];

  if (params.mode !== "live") return []; // no checks needed for paper

  // 1. Must have trained model
  if (params.requireTrainedModel) {
    const modelExists = require("node:fs").existsSync("ml/models/signal_filter.txt");
    if (!modelExists) {
      failures.push("No trained ML model found. Run: npm run train");
    }
  }

  // 2. Must have wallet or API keys for live exchange
  if (params.liveExchange === "dydx" && !params.walletAddress) {
    failures.push("dYdX wallet address not configured");
  }

  if (params.liveExchange === "binance_futures") {
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
      failures.push("Binance API keys not configured (BINANCE_API_KEY, BINANCE_API_SECRET)");
    }
  }

  if (params.liveExchange === "none") {
    failures.push("No exchange selected for live trading");
  }

  // 3. Leverage sanity check
  if (params.leverage > 5) {
    failures.push(`Leverage ${params.leverage}x is very high — are you sure?`);
  }

  // 4. Trade size sanity check
  if (params.tradeSize > 10_000) {
    failures.push(`Trade size $${params.tradeSize} is very large — are you sure?`);
  }

  return failures;
}
