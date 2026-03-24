#!/usr/bin/env tsx
import { Backtester } from "../src/backtest/backtester.js";
import { BookImbalanceStrategy } from "../src/models/strategies/book-imbalance.js";
import { CompositeAlphaStrategy } from "../src/models/strategies/composite-alpha.js";
import { existsSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stddev, bookImbalance, vwap } from "../src/utils/math.js";
import type { FeatureVector, MarketRegime } from "../src/types/signals.js";

const captureDir = join(process.cwd(), "data", "capture");
const dates = readdirSync(captureDir).filter((d) => !d.startsWith(".")).sort();

const books: any[] = [];
const trades: any[] = [];

for (const date of dates) {
  const bf = join(captureDir, date, "book.ndjson");
  const tf = join(captureDir, date, "trades.ndjson");
  if (existsSync(bf)) {
    const rl = createInterface({ input: createReadStream(bf), crlfDelay: Infinity });
    for await (const line of rl) { if (line.trim()) try { const d = JSON.parse(line); if (d.bids) books.push(d); } catch {} }
  }
  if (existsSync(tf)) {
    const rl = createInterface({ input: createReadStream(tf), crlfDelay: Infinity });
    for await (const line of rl) { if (line.trim()) try { const d = JSON.parse(line); if (d.type === "trade") trades.push(d); } catch {} }
  }
}

console.log(`Books: ${books.length} | Trades: ${trades.length}`);

// Build features
const allEvents = [
  ...books.map((b) => ({ ts: b.ts, type: "book" as const, data: b })),
  ...trades.map((t) => ({ ts: t.ts, type: "trade" as const, data: t })),
].sort((a, b) => a.ts - b.ts);

let currentBook: any = null;
const recentTrades: any[] = [];
const priceHistory: number[] = [];
const returnHistory: number[] = [];
const features: FeatureVector[] = [];
let lastTs = 0;

for (const event of allEvents) {
  if (event.type === "book") { currentBook = event.data; continue; }
  const trade = event.data;
  recentTrades.push(trade);
  const price = Number(trade.p);
  priceHistory.push(price);
  if (priceHistory.length >= 2) {
    const prev = priceHistory[priceHistory.length - 2];
    if (prev > 0) returnHistory.push(Math.log(price / prev));
  }
  while (recentTrades.length > 0 && recentTrades[0].ts < event.ts - 10000) recentTrades.shift();
  if (priceHistory.length > 10000) priceHistory.splice(0, 5000);
  if (returnHistory.length > 10000) returnHistory.splice(0, 5000);

  if (event.ts - lastTs < 1000 || !currentBook || recentTrades.length < 3) continue;
  lastTs = event.ts;

  const bids = currentBook.bids.map(([p, q]: string[]) => ({ price: Number(p), qty: Number(q) }));
  const asks = currentBook.asks.map(([p, q]: string[]) => ({ price: Number(p), qty: Number(q) }));
  if (bids.length === 0 || asks.length === 0) continue;

  const mid = (bids[0].price + asks[0].price) / 2;
  const spread = asks[0].price - bids[0].price;
  const bq5 = bids.slice(0, 5).reduce((s: number, l: any) => s + l.qty, 0);
  const aq5 = asks.slice(0, 5).reduce((s: number, l: any) => s + l.qty, 0);
  let bv = 0, sv = 0;
  for (const t of recentTrades) { const q = Number(t.q); if (t.s === "buy") bv += q; else sv += q; }
  const tv = bv + sv;
  const ti = tv > 0 ? (bv - sv) / tv : 0;
  const rv = returnHistory.length > 5 ? stddev(returnHistory.slice(-100)) * Math.sqrt(86400) : 0;
  let regime: MarketRegime = "mean_reverting";
  if (rv > 0.03) regime = "volatile";
  else if (rv < 0.008) regime = "low_vol";

  features.push({
    ts: event.ts, symbol: "BTC-USDT",
    bidAskSpread: spread, midPrice: mid, weightedMidPrice: mid,
    bookImbalance: bookImbalance(bq5, aq5), bookImbalanceTop5: bookImbalance(bq5, aq5),
    bookImbalanceTop20: bookImbalance(bq5, aq5),
    bookDepthBid: bids.slice(0, 20).reduce((s: number, l: any) => s + l.price * l.qty, 0),
    bookDepthAsk: asks.slice(0, 20).reduce((s: number, l: any) => s + l.price * l.qty, 0),
    bidAskSlope: 0, tradeImbalance: ti,
    vwap: vwap(recentTrades.map((t: any) => ({ price: Number(t.p), qty: Number(t.q) }))),
    volumeAcceleration: 0, largeTradeRatio: 0.05, buyPressure: bv - sv,
    aggTradeIntensity: recentTrades.length / 10,
    realizedVol: rv, volOfVol: 0, returnSkew: 0, returnKurtosis: 0, parkinsonVol: 0,
    liquidityScore: 0.7, spreadVolatility: 1, depthResilience: 0.5,
    exchangeSpread: 0, leadLagScore: 0, regime, regimeConfidence: 0.6,
    fundingRate: 0, liquidationPressure: 0, openInterestDelta: 0,
  });
}

console.log(`Features: ${features.length}`);

// Backtest
const bt = new Backtester();
const cfg = { name: "", enabled: true, symbols: ["BTC-USDT"], timeframe: 30, minConfidence: 0.3, maxPositions: 3, params: { signalCooldownMs: 5000, minLiquidity: 0.2 } };

const strategies = [
  new BookImbalanceStrategy({ ...cfg, name: "book_imbalance" }),
  new CompositeAlphaStrategy({ ...cfg, name: "composite_alpha" }),
];

for (const strat of strategies) {
  const result = bt.run(strat, features, 10000);
  console.log(`\n=== ${strat.name} ===`);
  console.log(`Trades: ${result.totalTrades}`);
  console.log(`Win Rate: ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`Return: ${(result.totalReturn * 100).toFixed(3)}%`);
  console.log(`Sharpe: ${result.sharpeRatio.toFixed(2)}`);
  console.log(`Max DD: ${(result.maxDrawdown * 100).toFixed(3)}%`);
  console.log(`PF: ${result.profitFactor.toFixed(2)}`);
  console.log(`Avg Hold: ${(result.avgHoldingPeriodMs / 1000).toFixed(0)}s`);
}
