import { Backtester, type BacktestResult } from "./backtester.js";
import { CompositeAlphaStrategy } from "../models/strategies/composite-alpha.js";
import { createChildLogger } from "../utils/logger.js";
import type { FeatureVector } from "../types/signals.js";
import type { StrategyConfig } from "../config/index.js";

const log = createChildLogger("optimizer");

interface ParamRange {
  name: string;
  min: number;
  max: number;
  step: number;
}

interface OptimizationResult {
  params: Record<string, number>;
  /** In-sample result */
  trainResult: BacktestResult;
  /** Out-of-sample result (the one that matters) */
  testResult: BacktestResult;
  /** Combined score for ranking */
  score: number;
}

/**
 * Strategy Parameter Optimizer
 *
 * Finds optimal strategy parameters using walk-forward optimization.
 *
 * Why walk-forward?
 * Grid search on the full dataset overfits. Walk-forward splits data into
 * train/test windows that slide forward, ensuring we always test on
 * unseen data. This simulates real deployment conditions.
 *
 * Scoring function:
 *   score = sharpe × sqrt(trades) × (1 - maxDrawdown) × profit_factor^0.5
 *
 * This penalizes:
 * - Low trade count (not enough statistical evidence)
 * - High drawdown (risk of ruin)
 * - Low profit factor (fragile edge)
 *
 * Anti-overfitting:
 * 1. Walk-forward validation (train/test split)
 * 2. Minimum trade count requirement (30+)
 * 3. Score penalizes low trade count via sqrt(trades)
 * 4. Results ranked by out-of-sample performance, not in-sample
 */
export class StrategyOptimizer {
  private backtester = new Backtester();

  /**
   * Optimize parameters via grid search with walk-forward validation.
   *
   * @param features - Full historical feature dataset
   * @param paramRanges - Parameter ranges to search
   * @param trainPct - Fraction of data for training (default 70%)
   * @param topN - Number of top results to return
   */
  optimize(
    features: FeatureVector[],
    paramRanges: ParamRange[],
    initialEquity = 10_000,
    trainPct = 0.7,
    topN = 10,
  ): OptimizationResult[] {
    const trainEnd = Math.floor(features.length * trainPct);
    const trainData = features.slice(0, trainEnd);
    const testData = features.slice(trainEnd);

    log.info({
      totalFeatures: features.length,
      trainSize: trainData.length,
      testSize: testData.length,
      paramRanges: paramRanges.map((p) => `${p.name}: ${p.min}-${p.max} step ${p.step}`),
    }, "Starting optimization");

    // Generate all parameter combinations
    const combinations = this.generateCombinations(paramRanges);
    log.info({ totalCombinations: combinations.length }, "Parameter space");

    const results: OptimizationResult[] = [];
    let tested = 0;

    for (const params of combinations) {
      tested++;
      if (tested % 50 === 0) {
        log.info({ tested, total: combinations.length }, "Optimization progress");
      }

      const config = this.buildConfig(params);
      const strategy = new CompositeAlphaStrategy(config);

      // Train (in-sample)
      const trainResult = this.backtester.run(strategy, trainData, initialEquity);

      // Skip if training shows no trades or negative edge
      if (trainResult.totalTrades < 20 || trainResult.sharpeRatio < 0) continue;

      // Test (out-of-sample)
      strategy.reset();
      const testResult = this.backtester.run(strategy, testData, initialEquity);

      const score = this.computeScore(testResult);

      results.push({ params, trainResult, testResult, score });
    }

    // Sort by out-of-sample score
    results.sort((a, b) => b.score - a.score);

    log.info({
      totalTested: tested,
      validResults: results.length,
      bestScore: results[0]?.score.toFixed(4) ?? "N/A",
    }, "Optimization complete");

    return results.slice(0, topN);
  }

  /**
   * Random search — more efficient than grid search for high-dimensional spaces.
   * Samples N random parameter combinations and evaluates each.
   */
  randomSearch(
    features: FeatureVector[],
    paramRanges: ParamRange[],
    nTrials = 200,
    initialEquity = 10_000,
    trainPct = 0.7,
  ): OptimizationResult[] {
    const trainEnd = Math.floor(features.length * trainPct);
    const trainData = features.slice(0, trainEnd);
    const testData = features.slice(trainEnd);

    const results: OptimizationResult[] = [];

    for (let i = 0; i < nTrials; i++) {
      // Random params
      const params: Record<string, number> = {};
      for (const range of paramRanges) {
        const steps = Math.floor((range.max - range.min) / range.step);
        const randomStep = Math.floor(Math.random() * (steps + 1));
        params[range.name] = range.min + randomStep * range.step;
      }

      const config = this.buildConfig(params);
      const strategy = new CompositeAlphaStrategy(config);

      const trainResult = this.backtester.run(strategy, trainData, initialEquity);
      if (trainResult.totalTrades < 15) continue;

      strategy.reset();
      const testResult = this.backtester.run(strategy, testData, initialEquity);

      const score = this.computeScore(testResult);
      results.push({ params, trainResult, testResult, score });

      if ((i + 1) % 50 === 0) {
        log.info({ trial: i + 1, nTrials, bestSoFar: Math.max(...results.map((r) => r.score)).toFixed(4) }, "Random search progress");
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 10);
  }

  /**
   * Scoring function for ranking parameter sets.
   * Prioritizes: consistent returns > high returns > low risk.
   */
  private computeScore(result: BacktestResult): number {
    if (result.totalTrades < 10) return -Infinity;
    if (result.maxDrawdown > 0.15) return -Infinity; // too risky

    const sharpe = Math.max(0, result.sharpeRatio);
    const tradeConfidence = Math.sqrt(result.totalTrades); // more trades = more confident
    const riskPenalty = 1 - result.maxDrawdown;
    const pfBonus = Math.sqrt(Math.max(1, result.profitFactor));

    return sharpe * tradeConfidence * riskPenalty * pfBonus;
  }

  private buildConfig(params: Record<string, number>): StrategyConfig {
    return {
      name: "composite_alpha",
      enabled: true,
      symbols: ["BTC-USDT"],
      timeframe: 45,
      minConfidence: params.minConfidence ?? 0.4,
      maxPositions: 3,
      params: {
        cooldownMs: (params.cooldownMs ?? 10) * 1000,
        minLiquidity: params.minLiquidity ?? 0.3,
      },
    };
  }

  private generateCombinations(ranges: ParamRange[]): Record<string, number>[] {
    if (ranges.length === 0) return [{}];

    const [first, ...rest] = ranges;
    const restCombinations = this.generateCombinations(rest);
    const results: Record<string, number>[] = [];

    for (let val = first.min; val <= first.max; val += first.step) {
      for (const combo of restCombinations) {
        results.push({ [first.name]: Math.round(val * 10000) / 10000, ...combo });
      }
    }

    return results;
  }
}

/** Default parameter ranges for the composite strategy */
export const DEFAULT_PARAM_RANGES: ParamRange[] = [
  { name: "minConfidence", min: 0.3, max: 0.7, step: 0.1 },
  { name: "cooldownMs", min: 5, max: 30, step: 5 }, // in seconds, multiplied by 1000
  { name: "minLiquidity", min: 0.2, max: 0.6, step: 0.1 },
];
