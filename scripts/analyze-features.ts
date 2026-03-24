#!/usr/bin/env tsx
/**
 * Feature Predictive Power Analysis
 *
 * Measures if each feature actually predicts the next price move.
 * This is the fundamental question: do our features have alpha?
 */

import { existsSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stddev, bookImbalance, vwap } from "../src/utils/math.js";
import type { MarketRegime } from "../src/types/signals.js";

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

console.log(`Books: ${books.length} | Trades: ${trades.length}\n`);

// Build snapshots with current features + future return
interface Snapshot {
  ts: number;
  midPrice: number;
  bookImbalance5: number;
  tradeImbalance: number;
  spread: number;
  futureReturn30s?: number; // what happens 30s later
  futureReturn60s?: number;
}

const allEvents = [
  ...books.map((b: any) => ({ ts: b.ts, type: "book" as const, data: b })),
  ...trades.map((t: any) => ({ ts: t.ts, type: "trade" as const, data: t })),
].sort((a: any, b: any) => a.ts - b.ts);

let currentBook: any = null;
const recentTrades: any[] = [];
const snapshots: Snapshot[] = [];
let lastTs = 0;

for (const event of allEvents) {
  if (event.type === "book") { currentBook = event.data; continue; }
  recentTrades.push(event.data);
  while (recentTrades.length > 0 && recentTrades[0].ts < event.ts - 10000) recentTrades.shift();

  if (event.ts - lastTs < 1000 || !currentBook || recentTrades.length < 3) continue;
  lastTs = event.ts;

  const bids = currentBook.bids.map(([p, q]: string[]) => ({ price: Number(p), qty: Number(q) }));
  const asks = currentBook.asks.map(([p, q]: string[]) => ({ price: Number(p), qty: Number(q) }));
  if (bids.length === 0 || asks.length === 0) continue;

  const mid = (bids[0].price + asks[0].price) / 2;
  const bq5 = bids.slice(0, 5).reduce((s: number, l: any) => s + l.qty, 0);
  const aq5 = asks.slice(0, 5).reduce((s: number, l: any) => s + l.qty, 0);
  let bv = 0, sv = 0;
  for (const t of recentTrades) { const q = Number(t.q); if (t.s === "buy") bv += q; else sv += q; }
  const tv = bv + sv;

  snapshots.push({
    ts: event.ts,
    midPrice: mid,
    bookImbalance5: bookImbalance(bq5, aq5),
    tradeImbalance: tv > 0 ? (bv - sv) / tv : 0,
    spread: asks[0].price - bids[0].price,
  });
}

// Compute future returns
for (let i = 0; i < snapshots.length; i++) {
  // Find price 30s and 60s later
  for (let j = i + 1; j < snapshots.length; j++) {
    const dt = snapshots[j].ts - snapshots[i].ts;
    if (dt >= 28000 && dt <= 32000 && snapshots[i].futureReturn30s === undefined) {
      snapshots[i].futureReturn30s = (snapshots[j].midPrice - snapshots[i].midPrice) / snapshots[i].midPrice;
    }
    if (dt >= 55000 && dt <= 65000 && snapshots[i].futureReturn60s === undefined) {
      snapshots[i].futureReturn60s = (snapshots[j].midPrice - snapshots[i].midPrice) / snapshots[i].midPrice;
    }
    if (dt > 65000) break;
  }
}

const withFuture = snapshots.filter((s) => s.futureReturn30s !== undefined);
console.log(`Snapshots with future returns: ${withFuture.length}\n`);

// ── Analysis: does book imbalance predict direction? ─────────────

function analyzeFeature(name: string, getValue: (s: Snapshot) => number, horizon: "30s" | "60s") {
  const getReturn = (s: Snapshot) => horizon === "30s" ? s.futureReturn30s! : s.futureReturn60s!;

  // Bin by feature quintiles
  const sorted = [...withFuture].filter((s) => getReturn(s) !== undefined).sort((a, b) => getValue(a) - getValue(b));
  const binSize = Math.floor(sorted.length / 5);

  console.log(`\n  ${name} → ${horizon} return:`);
  console.log(`  ${"Quintile".padEnd(12)} ${"Avg Feature".padEnd(14)} ${"Avg Return".padEnd(14)} ${"Win Rate".padEnd(10)} Count`);

  const quintileReturns: number[] = [];

  for (let q = 0; q < 5; q++) {
    const start = q * binSize;
    const end = q === 4 ? sorted.length : (q + 1) * binSize;
    const bin = sorted.slice(start, end);

    const avgFeature = bin.reduce((s, d) => s + getValue(d), 0) / bin.length;
    const avgReturn = bin.reduce((s, d) => s + getReturn(d), 0) / bin.length;
    const winRate = bin.filter((d) => getReturn(d) > 0).length / bin.length;

    quintileReturns.push(avgReturn);

    const returnColor = avgReturn >= 0 ? "\x1b[32m" : "\x1b[31m";
    console.log(
      `  Q${q + 1}${q === 0 ? " (low)" : q === 4 ? " (high)" : "       "}` +
      `${avgFeature.toFixed(4).padStart(12)}  ` +
      `${returnColor}${(avgReturn * 10000).toFixed(2).padStart(8)} bps\x1b[0m    ` +
      `${(winRate * 100).toFixed(1)}%     ${bin.length}`,
    );
  }

  // Monotonicity test: is Q5 return > Q1 return?
  const spread = quintileReturns[4] - quintileReturns[0];
  const ic = computeIC(
    withFuture.map((s) => getValue(s)),
    withFuture.filter((s) => getReturn(s) !== undefined).map((s) => getReturn(s)),
  );

  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  Q5-Q1 spread: ${(spread * 10000).toFixed(2)} bps | IC: ${ic.toFixed(4)} ${Math.abs(ic) > 0.02 ? "\x1b[32m★ predictive\x1b[0m" : "\x1b[33m○ weak\x1b[0m"}`);
}

/** Information Coefficient (rank correlation between feature and future return) */
function computeIC(features: number[], returns: number[]): number {
  const n = Math.min(features.length, returns.length);
  if (n < 10) return 0;

  // Spearman rank correlation
  const fRanks = rankArray(features.slice(0, n));
  const rRanks = rankArray(returns.slice(0, n));

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    sumD2 += (fRanks[i] - rRanks[i]) ** 2;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

function rankArray(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < indexed.length; i++) {
    ranks[indexed[i].i] = i + 1;
  }
  return ranks;
}

// ── Run analysis ─────────────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════╗");
console.log("║     Feature Predictive Power Analysis            ║");
console.log("║     IC > 0.02 = predictive, IC > 0.05 = strong  ║");
console.log("╚══════════════════════════════════════════════════╝");

analyzeFeature("Book Imbalance (top 5)", (s) => s.bookImbalance5, "30s");
analyzeFeature("Book Imbalance (top 5)", (s) => s.bookImbalance5, "60s");
analyzeFeature("Trade Imbalance", (s) => s.tradeImbalance, "30s");
analyzeFeature("Trade Imbalance", (s) => s.tradeImbalance, "60s");
analyzeFeature("Spread", (s) => s.spread, "30s");

console.log("\n");
