#!/usr/bin/env tsx
/**
 * Optimizer using REAL order book data from capture.
 *
 * This is the version that matters — it computes real book imbalance,
 * depth, spread, and liquidity from actual L2 snapshots.
 *
 * Usage:
 *   npx tsx scripts/optimize-with-book.ts
 *   npx tsx scripts/optimize-with-book.ts --trials 300
 */

import { existsSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { StrategyOptimizer, DEFAULT_PARAM_RANGES } from "../src/backtest/optimizer.js";
import { stddev, bookImbalance, weightedMidPrice, vwap } from "../src/utils/math.js";
import type { FeatureVector, MarketRegime } from "../src/types/signals.js";

const args = process.argv.slice(2);
function arg(name: string, def = ""): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const trials = Number(arg("trials", "200"));
const captureDir = join(process.cwd(), "data", "capture");

// ── Find capture data ────────────────────────────────────────────

import { readdirSync } from "node:fs";

const dates = existsSync(captureDir)
  ? readdirSync(captureDir).filter((d: string) => !d.startsWith(".")).sort()
  : [];

if (dates.length === 0) {
  console.error("❌ No capture data found. Run: npm run capture -- --symbols BTC-USDT --duration 4h");
  process.exit(1);
}

console.log(`
╔══════════════════════════════════════════════════════╗
║     Optimizer with REAL Order Book Data              ║
╠══════════════════════════════════════════════════════╣
║  Capture dates: ${dates.join(", ").padEnd(35)}║
║  Trials:        ${String(trials).padEnd(35)}║
╚══════════════════════════════════════════════════════╝
`);

// ── Load data ────────────────────────────────────────────────────

interface BookSnapshot {
  ts: number;
  bids: [string, string][];
  asks: [string, string][];
}

interface RawTrade {
  ts: number;
  p: string;
  q: string;
  s: "buy" | "sell";
}

const books: BookSnapshot[] = [];
const trades: RawTrade[] = [];

for (const date of dates) {
  const bookFile = join(captureDir, date, "book.ndjson");
  const tradeFile = join(captureDir, date, "trades.ndjson");

  if (existsSync(bookFile)) {
    const rl = createInterface({ input: createReadStream(bookFile), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const data = JSON.parse(line);
          if (data.type === "book_snapshot" && data.bids && data.asks) {
            books.push({ ts: data.ts, bids: data.bids, asks: data.asks });
          }
        } catch {}
      }
    }
  }

  if (existsSync(tradeFile)) {
    const rl = createInterface({ input: createReadStream(tradeFile), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const data = JSON.parse(line);
          if (data.type === "trade") {
            trades.push({ ts: data.ts, p: data.p, q: data.q, s: data.s });
          }
        } catch {}
      }
    }
  }
}

console.log(`  📊 Loaded ${books.length.toLocaleString()} book snapshots + ${trades.length.toLocaleString()} trades\n`);

if (books.length < 100) {
  console.error("❌ Need 100+ book snapshots. Run capture longer.");
  process.exit(1);
}

// ── Build features with REAL book data ───────────────────────────

console.log("  ⚙️  Building features with real order book data...");
const startBuild = Date.now();

// Merge books and trades by timestamp
type Event = { ts: number; type: "book"; data: BookSnapshot } | { ts: number; type: "trade"; data: RawTrade };

const allEvents: Event[] = [
  ...books.map((b) => ({ ts: b.ts, type: "book" as const, data: b })),
  ...trades.map((t) => ({ ts: t.ts, type: "trade" as const, data: t })),
].sort((a, b) => a.ts - b.ts);

// Current state
let currentBook: BookSnapshot | null = null;
const recentTrades: RawTrade[] = [];
const priceHistory: number[] = [];
const returnHistory: number[] = [];
const features: FeatureVector[] = [];
let lastFeatureTs = 0;
const featureIntervalMs = 1000; // 1 feature per second

for (const event of allEvents) {
  if (event.type === "book") {
    currentBook = event.data;
  } else {
    const trade = event.data;
    recentTrades.push(trade);
    const price = Number(trade.p);
    priceHistory.push(price);

    if (priceHistory.length >= 2) {
      const prev = priceHistory[priceHistory.length - 2];
      if (prev > 0) returnHistory.push(Math.log(price / prev));
    }

    // Trim old data
    const cutoff = event.ts - 10_000; // 10s window
    while (recentTrades.length > 0 && recentTrades[0].ts < cutoff) recentTrades.shift();
    if (priceHistory.length > 10000) priceHistory.splice(0, 5000);
    if (returnHistory.length > 10000) returnHistory.splice(0, 5000);
  }

  // Emit feature every second
  if (event.ts - lastFeatureTs < featureIntervalMs) continue;
  if (!currentBook || recentTrades.length < 3) continue;
  lastFeatureTs = event.ts;

  // ── Compute REAL features ──────────────────────────────────
  const bids = currentBook.bids.map(([p, q]) => ({ price: Number(p), qty: Number(q) }));
  const asks = currentBook.asks.map(([p, q]) => ({ price: Number(p), qty: Number(q) }));

  if (bids.length === 0 || asks.length === 0) continue;

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadBps = midPrice > 0 ? (spread / midPrice) * 10000 : 0;

  // Real book imbalance from L2 data
  const bidQty5 = bids.slice(0, 5).reduce((s, l) => s + l.qty, 0);
  const askQty5 = asks.slice(0, 5).reduce((s, l) => s + l.qty, 0);
  const bidQty20 = bids.slice(0, 20).reduce((s, l) => s + l.qty, 0);
  const askQty20 = asks.slice(0, 20).reduce((s, l) => s + l.qty, 0);
  const imbalance5 = bookImbalance(bidQty5, askQty5);
  const imbalance20 = bookImbalance(bidQty20, askQty20);

  // Weighted mid price
  const wMid = weightedMidPrice(bestBid, bids[0].qty, bestAsk, asks[0].qty);

  // Book depth in quote currency
  const bidDepth = bids.slice(0, 20).reduce((s, l) => s + l.price * l.qty, 0);
  const askDepth = asks.slice(0, 20).reduce((s, l) => s + l.price * l.qty, 0);

  // Trade flow
  let buyVol = 0, sellVol = 0;
  for (const t of recentTrades) {
    const qty = Number(t.q);
    if (t.s === "buy") buyVol += qty; else sellVol += qty;
  }
  const totalVol = buyVol + sellVol;
  const tradeImbalance = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;

  // VWAP
  const vwapVal = vwap(recentTrades.map((t) => ({ price: Number(t.p), qty: Number(t.q) })));

  // Volatility
  const recentReturns = returnHistory.slice(-100);
  const realizedVol = recentReturns.length > 5 ? stddev(recentReturns) * Math.sqrt(86400) : 0;

  // Liquidity score (REAL, from book data)
  const liquidityScore = Math.min(1,
    (1 / (spreadBps + 1)) * 0.4 +
    Math.min(1, (bidDepth + askDepth) / 1_000_000) * 0.3 +
    Math.min(1, totalVol * midPrice / 100_000) * 0.3,
  );

  // Regime
  let regime: MarketRegime = "mean_reverting";
  if (realizedVol > 0.03) regime = "volatile";
  else if (realizedVol < 0.008) regime = "low_vol";
  else if (Math.abs(tradeImbalance) > 0.3) regime = tradeImbalance > 0 ? "trending_up" : "trending_down";

  features.push({
    ts: event.ts,
    symbol: "BTC-USDT",
    bidAskSpread: spread,
    midPrice,
    weightedMidPrice: wMid,
    bookImbalance: imbalance5,
    bookImbalanceTop5: imbalance5,
    bookImbalanceTop20: imbalance20,
    bookDepthBid: bidDepth,
    bookDepthAsk: askDepth,
    bidAskSlope: 0,
    tradeImbalance,
    vwap: vwapVal,
    volumeAcceleration: 0,
    largeTradeRatio: 0.05,
    buyPressure: buyVol - sellVol,
    aggTradeIntensity: recentTrades.length / 10,
    realizedVol,
    volOfVol: 0,
    returnSkew: 0,
    returnKurtosis: 0,
    parkinsonVol: 0,
    liquidityScore,
    spreadVolatility: spreadBps,
    depthResilience: 0.5,
    exchangeSpread: 0,
    leadLagScore: 0,
    regime,
    regimeConfidence: 0.6,
    fundingRate: 0,
    liquidationPressure: 0,
    openInterestDelta: 0,
  });
}

console.log(`  📊 ${features.length.toLocaleString()} features built in ${((Date.now() - startBuild) / 1000).toFixed(1)}s`);
console.log(`  📈 Book imbalance range: [${Math.min(...features.map(f => f.bookImbalanceTop5)).toFixed(3)}, ${Math.max(...features.map(f => f.bookImbalanceTop5)).toFixed(3)}]`);
console.log(`  📈 Spread range: [${Math.min(...features.map(f => f.bidAskSpread)).toFixed(4)}, ${Math.max(...features.map(f => f.bidAskSpread)).toFixed(4)}]`);
console.log(`  📈 Liquidity range: [${Math.min(...features.map(f => f.liquidityScore)).toFixed(3)}, ${Math.max(...features.map(f => f.liquidityScore)).toFixed(3)}]`);

if (features.length < 500) {
  console.error("\n  ❌ Need 500+ features. Run capture longer (at least 30 minutes).");
  process.exit(1);
}

// ── Optimize ─────────────────────────────────────────────────────

console.log(`\n  🔍 Running optimization (${trials} trials)...\n`);

const optimizer = new StrategyOptimizer();
const results = optimizer.randomSearch(features, DEFAULT_PARAM_RANGES, trials, 10000, 0.7);

// ── Results ──────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

if (results.length === 0) {
  console.log(`\n  ${RED}❌ No viable parameter sets found with real book data.${RESET}`);
  console.log(`  Possible reasons:`);
  console.log(`    - Need more data (run capture for 4+ hours)`);
  console.log(`    - Strategy parameters need wider search ranges`);
  console.log(`    - Market conditions during capture were unfavorable`);
} else {
  console.log(`${BOLD}${CYAN}  TOP 5 RESULTS (with REAL order book features)${RESET}\n`);

  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    const t = r.testResult;
    const returnColor = t.totalReturn >= 0 ? GREEN : RED;

    console.log(`  ${BOLD}#${i + 1}${RESET} score: ${r.score.toFixed(4)} | params: ${JSON.stringify(r.params)}`);
    console.log(`     ${DIM}IN-SAMPLE${RESET}    trades:${r.trainResult.totalTrades} return:${(r.trainResult.totalReturn * 100).toFixed(2)}% sharpe:${r.trainResult.sharpeRatio.toFixed(2)} win:${(r.trainResult.winRate * 100).toFixed(1)}%`);
    console.log(`     ${BOLD}OUT-OF-SAMPLE${RESET} trades:${t.totalTrades} return:${returnColor}${(t.totalReturn * 100).toFixed(2)}%${RESET} sharpe:${t.sharpeRatio.toFixed(2)} win:${(t.winRate * 100).toFixed(1)}% dd:${(t.maxDrawdown * 100).toFixed(2)}%\n`);
  }

  const best = results[0];
  const ratio = best.trainResult.sharpeRatio !== 0
    ? best.testResult.sharpeRatio / best.trainResult.sharpeRatio
    : 0;
  console.log(`  OOS/IS Ratio: ${ratio.toFixed(2)} ${ratio > 0.5 ? `${GREEN}(robust)${RESET}` : ratio > 0.3 ? "(marginal)" : `${RED}(overfit)${RESET}`}\n`);
}
