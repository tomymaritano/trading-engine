#!/usr/bin/env tsx
/**
 * Strategy Optimizer — find parameters that work out-of-sample.
 *
 * Usage:
 *   npx tsx scripts/optimize.ts --symbol BTC-USDT
 *   npx tsx scripts/optimize.ts --symbol BTC-USDT --trials 500
 *   npx tsx scripts/optimize.ts --symbol ETH-USDT --method grid
 */

import { existsSync, readdirSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { StrategyOptimizer, DEFAULT_PARAM_RANGES } from "../src/backtest/optimizer.js";
import { stddev } from "../src/utils/math.js";
import type { FeatureVector, MarketRegime } from "../src/types/signals.js";

// ── CLI ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name: string, def = ""): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const symbol = arg("symbol", "BTC-USDT");
const method = arg("method", "random"); // grid | random
const trials = Number(arg("trials", "200"));
const equity = Number(arg("equity", "10000"));

// ── Load trades ──────────────────────────────────────────────────

interface RawTrade {
  id: string;
  ts: number;
  p: string;
  q: string;
  s: "buy" | "sell";
  m: boolean;
}

async function loadTrades(): Promise<RawTrade[]> {
  const dir = join(process.cwd(), "data", "trades", symbol);
  if (!existsSync(dir)) {
    console.error(`  ❌ No data at ${dir}. Run: npm run download -- --symbol ${symbol.replace("-", "")} --days 30`);
    process.exit(1);
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort();
  console.log(`  📂 Loading ${files.length} days from ${dir}`);

  const all: RawTrade[] = [];
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) {
        try { all.push(JSON.parse(line)); } catch {}
      }
    }
  }

  console.log(`  📊 ${all.length.toLocaleString()} trades loaded`);
  return all;
}

// ── Build features (same as backtest runner) ─────────────────────

function buildFeatures(trades: RawTrade[], intervalMs = 1000): FeatureVector[] {
  if (trades.length === 0) return [];

  const features: FeatureVector[] = [];
  const windowMs = 5000;
  let windowStart = trades[0].ts;
  let tradeWindow: RawTrade[] = [];
  const priceHistory: number[] = [];
  const returnHistory: number[] = [];

  for (const trade of trades) {
    if (trade.ts - windowStart >= intervalMs) {
      if (tradeWindow.length >= 3) {
        const f = computeFeatures(tradeWindow, priceHistory, returnHistory);
        if (f) features.push(f);
      }
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

    if (priceHistory.length > 10000) priceHistory.splice(0, 5000);
    if (returnHistory.length > 10000) returnHistory.splice(0, 5000);
  }

  return features;
}

function computeFeatures(
  trades: RawTrade[],
  priceHistory: number[],
  returnHistory: number[],
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
    if (t.s === "buy") buyVol += qty; else sellVol += qty;
    if (px > high) high = px;
    if (px < low) low = px;
  }

  const totalVol = buyVol + sellVol;
  const vwapVal = qtySum > 0 ? pxSum / qtySum : 0;
  const tradeImbalance = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;
  const midPrice = vwapVal;

  const recentReturns = returnHistory.slice(-100);
  const realizedVol = recentReturns.length > 5 ? stddev(recentReturns) * Math.sqrt(86400) : 0;
  const parkinsonVol = high > 0 && low > 0 ? Math.log(high / low) / (2 * Math.sqrt(Math.LN2)) : 0;

  let regime: MarketRegime = "mean_reverting";
  if (realizedVol > 0.03) regime = "volatile";
  else if (realizedVol < 0.008) regime = "low_vol";
  else if (Math.abs(tradeImbalance) > 0.3) regime = tradeImbalance > 0 ? "trending_up" : "trending_down";

  // Volume acceleration
  const recentVols = priceHistory.slice(-20).map((_, i, arr) => {
    if (i === 0) return 0;
    return Math.abs(arr[i] - arr[i - 1]);
  });
  const volAccel = recentVols.length > 5
    ? (recentVols.slice(-5).reduce((a, b) => a + b, 0) / 5) -
      (recentVols.slice(-10, -5).reduce((a, b) => a + b, 0) / 5)
    : 0;

  return {
    ts: trades[trades.length - 1].ts,
    symbol,
    bidAskSpread: midPrice * 0.0001,
    midPrice,
    weightedMidPrice: midPrice,
    bookImbalance: tradeImbalance * 0.5,
    bookImbalanceTop5: tradeImbalance * 0.6,
    bookImbalanceTop20: tradeImbalance * 0.3,
    bookDepthBid: totalVol * midPrice * 0.5,
    bookDepthAsk: totalVol * midPrice * 0.5,
    bidAskSlope: 0,
    tradeImbalance,
    vwap: vwapVal,
    volumeAcceleration: volAccel,
    largeTradeRatio: 0.05,
    buyPressure: buyVol - sellVol,
    aggTradeIntensity: trades.length / 5,
    realizedVol,
    volOfVol: 0,
    returnSkew: 0,
    returnKurtosis: 0,
    parkinsonVol,
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

// ── Main ──────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════╗
║           Strategy Optimizer                         ║
╠══════════════════════════════════════════════════════╣
║  Symbol:    ${symbol.padEnd(40)}║
║  Method:    ${method.padEnd(40)}║
║  Trials:    ${String(trials).padEnd(40)}║
║  Equity:    $${equity.toLocaleString().padEnd(39)}║
╚══════════════════════════════════════════════════════╝
`);

const trades = await loadTrades();

console.log("\n  ⚙️  Building features...");
const startBuild = Date.now();
const features = buildFeatures(trades);
console.log(`  📊 ${features.length.toLocaleString()} features in ${((Date.now() - startBuild) / 1000).toFixed(1)}s`);

if (features.length < 500) {
  console.error("\n  ❌ Need 500+ feature vectors. Download more data.");
  process.exit(1);
}

console.log(`\n  🔍 Running ${method} search (${trials} evaluations)...\n`);

const optimizer = new StrategyOptimizer();
const startOpt = Date.now();

const results = method === "grid"
  ? optimizer.optimize(features, DEFAULT_PARAM_RANGES, equity, 0.7, 10)
  : optimizer.randomSearch(features, DEFAULT_PARAM_RANGES, trials, equity, 0.7);

const elapsed = ((Date.now() - startOpt) / 1000).toFixed(1);

// ── Results ───────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

console.log(`\n  ⏱  Optimization done in ${elapsed}s\n`);

if (results.length === 0) {
  console.log(`  ${RED}❌ No viable parameter sets found.${RESET}`);
  console.log(`  This means none of the tested configurations produced positive results.`);
  console.log(`  Possible causes:`);
  console.log(`    - Not enough data (need 30+ days)`);
  console.log(`    - Market conditions don't suit these strategies`);
  console.log(`    - Need real order book data (not just trades)`);
  process.exit(0);
}

console.log(`${BOLD}${CYAN}  ┌─────────────────────────────────────────────────────────────┐${RESET}`);
console.log(`${BOLD}${CYAN}  │  TOP ${Math.min(5, results.length)} PARAMETER SETS (ranked by out-of-sample score)     │${RESET}`);
console.log(`${BOLD}${CYAN}  └─────────────────────────────────────────────────────────────┘${RESET}`);

for (let i = 0; i < Math.min(5, results.length); i++) {
  const r = results[i];
  const t = r.testResult;
  const returnColor = t.totalReturn >= 0 ? GREEN : RED;

  console.log(`
  ${BOLD}#${i + 1}${RESET} ${DIM}score: ${r.score.toFixed(2)}${RESET}
  ${DIM}params:${RESET} ${JSON.stringify(r.params)}

  ${DIM}          IN-SAMPLE    OUT-OF-SAMPLE${RESET}
  Trades:   ${String(r.trainResult.totalTrades).padEnd(13)}${t.totalTrades}
  Return:   ${((r.trainResult.totalReturn * 100).toFixed(2) + "%").padEnd(13)}${returnColor}${(t.totalReturn * 100).toFixed(2)}%${RESET}
  Sharpe:   ${r.trainResult.sharpeRatio.toFixed(2).padEnd(13)}${t.sharpeRatio.toFixed(2)}
  Win Rate: ${((r.trainResult.winRate * 100).toFixed(1) + "%").padEnd(13)}${(t.winRate * 100).toFixed(1)}%
  Max DD:   ${((r.trainResult.maxDrawdown * 100).toFixed(2) + "%").padEnd(13)}${(t.maxDrawdown * 100).toFixed(2)}%
  PF:       ${r.trainResult.profitFactor.toFixed(2).padEnd(13)}${t.profitFactor.toFixed(2)}`);
}

// Overfitting check
if (results.length > 0) {
  const best = results[0];
  const trainSharpe = best.trainResult.sharpeRatio;
  const testSharpe = best.testResult.sharpeRatio;
  const overfitRatio = trainSharpe > 0 ? testSharpe / trainSharpe : 0;

  console.log(`
${BOLD}  ── Overfitting Check ──${RESET}
  Train Sharpe:    ${trainSharpe.toFixed(2)}
  Test Sharpe:     ${testSharpe.toFixed(2)}
  OOS/IS Ratio:    ${overfitRatio.toFixed(2)} ${overfitRatio > 0.5 ? `${GREEN}(good)${RESET}` : overfitRatio > 0.3 ? `${YELLOW}(marginal)${RESET}` : `${RED}(likely overfit)${RESET}`}

  ${DIM}Rule of thumb: OOS/IS > 0.5 = robust, 0.3-0.5 = marginal, < 0.3 = overfit${RESET}
`);

  // Save best params
  const paramsFile = join(process.cwd(), "data", `best-params-${symbol}.json`);
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(paramsFile, JSON.stringify({
    symbol,
    optimizedAt: new Date().toISOString(),
    method,
    totalTrials: trials,
    dataPoints: features.length,
    bestParams: best.params,
    trainResult: {
      trades: best.trainResult.totalTrades,
      sharpe: best.trainResult.sharpeRatio,
      return: best.trainResult.totalReturn,
      maxDrawdown: best.trainResult.maxDrawdown,
      winRate: best.trainResult.winRate,
    },
    testResult: {
      trades: best.testResult.totalTrades,
      sharpe: best.testResult.sharpeRatio,
      return: best.testResult.totalReturn,
      maxDrawdown: best.testResult.maxDrawdown,
      winRate: best.testResult.winRate,
    },
    overfitRatio,
  }, null, 2));

  console.log(`  💾 Best params saved to ${paramsFile}`);
}
