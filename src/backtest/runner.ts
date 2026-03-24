#!/usr/bin/env tsx
/**
 * Backtest Runner — runs strategies against historical data.
 *
 * Usage:
 *   npx tsx src/backtest/runner.ts
 *   npx tsx src/backtest/runner.ts --symbol BTC-USDT --strategy book_imbalance
 *   npx tsx src/backtest/runner.ts --walkforward --steps 5
 *
 * Reads historical trade data from data/trades/, builds feature vectors,
 * runs strategies, and reports results.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import Decimal from "decimal.js";
import { Backtester } from "./backtester.js";
import { BookImbalanceStrategy } from "../models/strategies/book-imbalance.js";
import { LiquidationCascadeStrategy } from "../models/strategies/liquidation-cascade.js";
import { VolatilityRegimeStrategy } from "../models/strategies/volatility-regime.js";
import { stddev } from "../utils/math.js";
import type { FeatureVector, MarketRegime } from "../types/signals.js";
import type { Strategy } from "../models/strategy-base.js";
import type { BacktestResult } from "./backtester.js";

// ── CLI args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, def?: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return def ?? "";
  return args[idx + 1] ?? def ?? "";
}

const symbol = getArg("symbol", "BTC-USDT");
const strategyName = getArg("strategy", "all");
const walkForward = args.includes("--walkforward");
const steps = Number(getArg("steps", "5"));
const initialEquity = Number(getArg("equity", "10000"));

// ── Load data ─────────────────────────────────────────────────────

interface RawTrade {
  id: string;
  ts: number;
  p: string;
  q: string;
  s: "buy" | "sell";
  m: boolean;
}

async function loadTrades(sym: string): Promise<RawTrade[]> {
  const dir = join(process.cwd(), "data", "trades", sym.replace("/", "-"));
  if (!existsSync(dir)) {
    console.error(`  ❌ No trade data found at ${dir}`);
    console.error(`  Run: npx tsx scripts/download-data.ts --symbol ${sym} --days 7`);
    process.exit(1);
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson"))
    .sort();

  console.log(`  📂 Loading ${files.length} day(s) of data from ${dir}`);

  const allTrades: RawTrade[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        allTrades.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
  }

  console.log(`  📊 Loaded ${allTrades.length.toLocaleString()} trades`);
  return allTrades;
}

/**
 * Build feature vectors from raw trades.
 *
 * This is a simplified offline feature builder that mimics what the
 * FeatureEngine does in real-time. It aggregates trades into 1-second
 * windows and computes a feature vector per window.
 */
function buildFeatures(trades: RawTrade[], intervalMs = 1000): FeatureVector[] {
  if (trades.length === 0) return [];

  const features: FeatureVector[] = [];
  const windowMs = 5000; // trade flow window
  let windowStart = trades[0].ts;
  let tradeWindow: RawTrade[] = [];

  // Rolling state
  const priceHistory: number[] = [];
  const returnHistory: number[] = [];

  for (const trade of trades) {
    // Advance window
    if (trade.ts - windowStart >= intervalMs) {
      if (tradeWindow.length >= 3) {
        const f = computeWindowFeatures(tradeWindow, priceHistory, returnHistory, symbol);
        if (f) features.push(f);
      }

      // Slide window
      windowStart = trade.ts;
      tradeWindow = tradeWindow.filter((t) => trade.ts - t.ts < windowMs);
    }

    tradeWindow.push(trade);
    const price = Number(trade.p);
    priceHistory.push(price);

    if (priceHistory.length >= 2) {
      const prev = priceHistory[priceHistory.length - 2];
      if (prev > 0) returnHistory.push(Math.log(price / prev));
    }

    // Limit history size
    if (priceHistory.length > 10000) priceHistory.splice(0, 5000);
    if (returnHistory.length > 10000) returnHistory.splice(0, 5000);
  }

  return features;
}

function computeWindowFeatures(
  trades: RawTrade[],
  priceHistory: number[],
  returnHistory: number[],
  sym: string,
): FeatureVector | null {
  if (trades.length === 0) return null;

  let buyVol = 0, sellVol = 0;
  let high = -Infinity, low = Infinity;
  let pxSum = 0, qtySum = 0;

  for (const t of trades) {
    const px = Number(t.p);
    const qty = Number(t.q);
    pxSum += px * qty;
    qtySum += qty;
    if (t.s === "buy") buyVol += qty;
    else sellVol += qty;
    if (px > high) high = px;
    if (px < low) low = px;
  }

  const totalVol = buyVol + sellVol;
  const vwapVal = qtySum > 0 ? pxSum / qtySum : 0;
  const tradeImbalance = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;
  const midPrice = vwapVal;

  // Volatility from returns
  const recentReturns = returnHistory.slice(-100);
  const realizedVol = recentReturns.length > 5 ? stddev(recentReturns) * Math.sqrt(86400) : 0;

  // Simplified regime detection
  let regime: MarketRegime = "mean_reverting";
  if (realizedVol > 0.03) regime = "volatile";
  else if (realizedVol < 0.008) regime = "low_vol";
  else if (Math.abs(tradeImbalance) > 0.3) regime = tradeImbalance > 0 ? "trending_up" : "trending_down";

  return {
    ts: trades[trades.length - 1].ts,
    symbol: sym,
    bidAskSpread: midPrice * 0.0001, // estimate: 1 bps
    midPrice,
    weightedMidPrice: midPrice,
    bookImbalance: tradeImbalance * 0.5, // proxy: use trade imbalance as book proxy
    bookImbalanceTop5: tradeImbalance * 0.6,
    bookImbalanceTop20: tradeImbalance * 0.3,
    bookDepthBid: totalVol * midPrice * 0.5,
    bookDepthAsk: totalVol * midPrice * 0.5,
    bidAskSlope: 0,
    tradeImbalance,
    vwap: vwapVal,
    volumeAcceleration: 0,
    largeTradeRatio: 0.05,
    buyPressure: buyVol - sellVol,
    aggTradeIntensity: trades.length / 5,
    realizedVol,
    volOfVol: 0,
    returnSkew: 0,
    returnKurtosis: 0,
    parkinsonVol: high > 0 && low > 0 ? Math.log(high / low) / (2 * Math.sqrt(Math.LN2)) : 0,
    liquidityScore: 0.6,
    spreadVolatility: 1,
    depthResilience: 0.5,
    exchangeSpread: 0,
    leadLagScore: 0,
    regime,
    regimeConfidence: 0.6,
    fundingRate: 0,
    liquidationPressure: 0,
    openInterestDelta: 0,
  };
}

// ── Strategies ────────────────────────────────────────────────────

function getStrategies(): Strategy[] {
  const config = {
    name: "",
    enabled: true,
    symbols: [symbol],
    timeframe: 30,
    minConfidence: 0.4,
    maxPositions: 3,
    params: { signalCooldownMs: 10_000 },
  };

  const all: Strategy[] = [
    new BookImbalanceStrategy({ ...config, name: "book_imbalance" }),
    new LiquidationCascadeStrategy({ ...config, name: "liquidation_cascade" }),
    new VolatilityRegimeStrategy({ ...config, name: "volatility_regime" }),
  ];

  if (strategyName === "all") return all;
  return all.filter((s) => s.name === strategyName);
}

// ── Report ────────────────────────────────────────────────────────

function printResult(name: string, result: BacktestResult): void {
  const { totalTrades, winRate, totalReturn, maxDrawdown, sharpeRatio, sortinoRatio, profitFactor, avgHoldingPeriodMs, calmarRatio, expectancy } = result;

  const returnColor = totalReturn >= 0 ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";

  console.log(`
${bold}${cyan}  ┌──────────────────────────────────────────┐${reset}
${bold}${cyan}  │  ${name.padEnd(40)}│${reset}
${bold}${cyan}  ├──────────────────────────────────────────┤${reset}
  │  Trades:        ${String(totalTrades).padEnd(24)}│
  │  Win Rate:      ${(winRate * 100).toFixed(1).padStart(5)}%${" ".repeat(18)}│
  │  Total Return:  ${returnColor}${(totalReturn * 100).toFixed(2).padStart(6)}%${reset}${" ".repeat(17)}│
  │  Max Drawdown:  ${(maxDrawdown * 100).toFixed(2).padStart(6)}%${" ".repeat(17)}│
  │  Sharpe:        ${sharpeRatio.toFixed(2).padStart(6)}${" ".repeat(18)}│
  │  Sortino:       ${sortinoRatio.toFixed(2).padStart(6)}${" ".repeat(18)}│
  │  Profit Factor: ${profitFactor === Infinity ? "  ∞".padEnd(6) : profitFactor.toFixed(2).padStart(6)}${" ".repeat(18)}│
  │  Calmar:        ${calmarRatio.toFixed(2).padStart(6)}${" ".repeat(18)}│
  │  Expectancy:    $${expectancy.toFixed(2).padStart(8)}${" ".repeat(14)}│
  │  Avg Hold:      ${formatHoldTime(avgHoldingPeriodMs).padStart(8)}${" ".repeat(14)}│
${cyan}  └──────────────────────────────────────────┘${reset}`);

  // Quality assessment
  const checks = [
    { label: "Sharpe > 2.0", pass: sharpeRatio > 2.0 },
    { label: "Win Rate > 55%", pass: winRate > 0.55 },
    { label: "Profit Factor > 1.5", pass: profitFactor > 1.5 },
    { label: "Max DD < 5%", pass: maxDrawdown < 0.05 },
    { label: "Trades > 30", pass: totalTrades > 30 },
    { label: "Expectancy > 0", pass: expectancy > 0 },
  ];

  console.log(`\n  ${dim}Quality Checks:${reset}`);
  for (const check of checks) {
    const icon = check.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`    ${icon} ${check.label}`);
  }
}

function formatHoldTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════╗
║            Backtest Runner                   ║
╠══════════════════════════════════════════════╣
║  Symbol:     ${symbol.padEnd(31)}║
║  Strategy:   ${strategyName.padEnd(31)}║
║  Equity:     $${initialEquity.toLocaleString().padEnd(29)}║
║  Walk-fwd:   ${String(walkForward).padEnd(31)}║
╚══════════════════════════════════════════════╝
`);

  // Load data
  const trades = await loadTrades(symbol);

  // Build features
  console.log("\n  ⚙️  Building feature vectors...");
  const startBuild = Date.now();
  const features = buildFeatures(trades);
  console.log(`  📊 ${features.length.toLocaleString()} feature vectors built in ${((Date.now() - startBuild) / 1000).toFixed(1)}s`);

  if (features.length < 100) {
    console.error("\n  ❌ Not enough data for meaningful backtest (need 100+ feature vectors)");
    process.exit(1);
  }

  // Run backtests
  const backtester = new Backtester();
  const strategies = getStrategies();

  console.log(`\n  🚀 Running ${strategies.length} strategy(ies)...\n`);

  for (const strategy of strategies) {
    if (walkForward) {
      console.log(`  ── Walk-Forward: ${strategy.name} (${steps} steps) ──\n`);
      const results = backtester.walkForward(strategy, features, initialEquity, 0.7, steps);

      for (let i = 0; i < results.length; i++) {
        printResult(`${strategy.name} [step ${i + 1}/${steps}]`, results[i]);
      }

      // Aggregate out-of-sample results
      const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);
      const avgSharpe = results.reduce((s, r) => s + r.sharpeRatio, 0) / results.length;
      const avgWinRate = results.reduce((s, r) => s + r.winRate, 0) / results.length;
      const maxDD = Math.max(...results.map((r) => r.maxDrawdown));

      console.log(`\n  ── Walk-Forward Summary ──`);
      console.log(`  Total OOS trades: ${totalTrades}`);
      console.log(`  Avg Sharpe:       ${avgSharpe.toFixed(2)}`);
      console.log(`  Avg Win Rate:     ${(avgWinRate * 100).toFixed(1)}%`);
      console.log(`  Worst Max DD:     ${(maxDD * 100).toFixed(2)}%`);
    } else {
      const result = backtester.run(strategy, features, initialEquity);
      printResult(strategy.name, result);
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
