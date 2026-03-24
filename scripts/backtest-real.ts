#!/usr/bin/env tsx
/**
 * Backtest with REAL order book data — tuned for actual alpha.
 *
 * Uses the finding that book imbalance has IC=0.12 at 30s horizon.
 * Only trades when imbalance is in the extreme quintiles.
 */

import { existsSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stddev, bookImbalance, vwap } from "../src/utils/math.js";

const captureDir = join(process.cwd(), "data", "capture");
const dates = readdirSync(captureDir).filter((d) => !d.startsWith(".")).sort();

// ── Load data ────────────────────────────────────────────────────

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

console.log(`\nLoaded ${books.length} book snapshots + ${trades.length.toLocaleString()} trades\n`);

// ── Build snapshots ──────────────────────────────────────────────

interface Snapshot {
  ts: number;
  midPrice: number;
  bookImbalance5: number;
  tradeImbalance: number;
  bidDepth: number;
  askDepth: number;
  spread: number;
}

const allEvents = [
  ...books.map((b: any) => ({ ts: b.ts, type: "book" as const, data: b })),
  ...trades.map((t: any) => ({ ts: t.ts, type: "trade" as const, data: t })),
].sort((a, b) => a.ts - b.ts);

let currentBook: any = null;
const recentTrades: any[] = [];
const snapshots: Snapshot[] = [];
let lastTs = 0;

for (const event of allEvents) {
  if (event.type === "book") { currentBook = event.data; continue; }
  recentTrades.push(event.data);
  while (recentTrades.length > 0 && recentTrades[0].ts < event.ts - 5000) recentTrades.shift();

  if (event.ts - lastTs < 1000 || !currentBook || recentTrades.length < 2) continue;
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
    bidDepth: bids.slice(0, 20).reduce((s: number, l: any) => s + l.price * l.qty, 0),
    askDepth: asks.slice(0, 20).reduce((s: number, l: any) => s + l.price * l.qty, 0),
    spread: asks[0].price - bids[0].price,
  });
}

console.log(`Snapshots: ${snapshots.length}\n`);

// ── Backtest ─────────────────────────────────────────────────────

interface BacktestConfig {
  name: string;
  imbalanceThreshold: number;    // min abs(imbalance) to enter
  tradeImbalanceConfirm: number; // trade flow must agree with this min
  holdSeconds: number;           // fixed hold time (simple exit)
  feeBps: number;                // round-trip fees
  slippageBps: number;           // round-trip slippage
  positionPct: number;           // % of equity per trade
}

function runBacktest(config: BacktestConfig): void {
  let equity = 10000;
  let peakEquity = 10000;
  let maxDrawdown = 0;
  const trades: { pnl: number; returnPct: number; holdMs: number }[] = [];
  let lastEntryTs = 0;
  const cooldownMs = 5000; // 5s between trades

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];

    // Cooldown
    if (snap.ts - lastEntryTs < cooldownMs) continue;

    // Entry conditions
    const absImb = Math.abs(snap.bookImbalance5);
    if (absImb < config.imbalanceThreshold) continue;

    // Trade flow confirmation
    const flowAgrees =
      (snap.bookImbalance5 > 0 && snap.tradeImbalance > config.tradeImbalanceConfirm) ||
      (snap.bookImbalance5 < 0 && snap.tradeImbalance < -config.tradeImbalanceConfirm);
    if (!flowAgrees) continue;

    const direction = snap.bookImbalance5 > 0 ? "long" : "short";
    const entryPrice = snap.midPrice;
    lastEntryTs = snap.ts;

    // Find exit: fixed hold time
    const targetTs = snap.ts + config.holdSeconds * 1000;
    let exitSnap: Snapshot | null = null;

    for (let j = i + 1; j < snapshots.length; j++) {
      if (snapshots[j].ts >= targetTs) {
        exitSnap = snapshots[j];
        break;
      }
    }

    if (!exitSnap) continue;

    const exitPrice = exitSnap.midPrice;
    const grossReturn = direction === "long"
      ? (exitPrice - entryPrice) / entryPrice
      : (entryPrice - exitPrice) / entryPrice;

    const costs = (config.feeBps + config.slippageBps) / 10000;
    const netReturn = grossReturn - costs;
    const positionValue = equity * config.positionPct;
    const pnl = positionValue * netReturn;

    equity += pnl;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);

    trades.push({
      pnl,
      returnPct: netReturn,
      holdMs: exitSnap.ts - snap.ts,
    });
  }

  // Results
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const totalReturn = (equity - 10000) / 10000;
  const avgReturn = trades.length > 0 ? trades.reduce((s, t) => s + t.returnPct, 0) / trades.length : 0;
  const avgReturnBps = avgReturn * 10000;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const returns = trades.map((t) => t.returnPct);
  const sd = returns.length > 1 ? stddev(returns) : 0;
  const sharpe = sd > 0 ? (avgReturn / sd) * Math.sqrt(trades.length) : 0;

  const returnColor = totalReturn >= 0 ? "\x1b[32m" : "\x1b[31m";
  const R = "\x1b[0m";
  const B = "\x1b[1m";
  const C = "\x1b[36m";
  const D = "\x1b[2m";

  console.log(`${B}${C}  ── ${config.name} ──${R}`);
  console.log(`  Imb threshold: ${config.imbalanceThreshold} | Flow confirm: ${config.tradeImbalanceConfirm} | Hold: ${config.holdSeconds}s | Fees: ${config.feeBps}bps`);
  console.log(`  Trades:    ${trades.length}`);
  console.log(`  Win Rate:  ${(winRate * 100).toFixed(1)}%`);
  console.log(`  Return:    ${returnColor}${(totalReturn * 100).toFixed(3)}%${R} ($${(equity - 10000).toFixed(2)})`);
  console.log(`  Avg/Trade: ${returnColor}${avgReturnBps.toFixed(2)} bps${R}`);
  console.log(`  Sharpe:    ${sharpe.toFixed(2)}`);
  console.log(`  Max DD:    ${(maxDrawdown * 100).toFixed(3)}%`);
  console.log(`  PF:        ${pf.toFixed(2)}`);
  console.log(`  Equity:    $${equity.toFixed(2)}\n`);
}

// ── Run multiple configs ─────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════╗");
console.log("║     Backtest with Real Order Book Features           ║");
console.log("║     Using confirmed alpha: IC=0.12 at 30s            ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

// Config 1: Strong imbalance only, 30s hold
runBacktest({
  name: "Strong Imbalance (30s)",
  imbalanceThreshold: 0.6,
  tradeImbalanceConfirm: 0.1,
  holdSeconds: 30,
  feeBps: 8,       // 4bps each way
  slippageBps: 4,  // 2bps each way
  positionPct: 0.02,
});

// Config 2: Very strong imbalance, 15s hold (tighter)
runBacktest({
  name: "Very Strong Imbalance (15s)",
  imbalanceThreshold: 0.8,
  tradeImbalanceConfirm: 0.15,
  holdSeconds: 15,
  feeBps: 8,
  slippageBps: 4,
  positionPct: 0.02,
});

// Config 3: Moderate imbalance, 60s hold
runBacktest({
  name: "Moderate Imbalance (60s)",
  imbalanceThreshold: 0.4,
  tradeImbalanceConfirm: 0.05,
  holdSeconds: 60,
  feeBps: 8,
  slippageBps: 4,
  positionPct: 0.02,
});

// Config 4: Strong + larger position
runBacktest({
  name: "Strong Imbalance (30s, 5% pos)",
  imbalanceThreshold: 0.6,
  tradeImbalanceConfirm: 0.1,
  holdSeconds: 30,
  feeBps: 8,
  slippageBps: 4,
  positionPct: 0.05,
});

// Config 5: No trade flow confirmation (just book)
runBacktest({
  name: "Book Only, No Flow Confirm (30s)",
  imbalanceThreshold: 0.7,
  tradeImbalanceConfirm: 0,
  holdSeconds: 30,
  feeBps: 8,
  slippageBps: 4,
  positionPct: 0.02,
});

// Config 6: With maker fees (limit orders)
runBacktest({
  name: "Strong Imbalance (30s, maker fees)",
  imbalanceThreshold: 0.6,
  tradeImbalanceConfirm: 0.1,
  holdSeconds: 30,
  feeBps: 4,       // maker: 2bps each way
  slippageBps: 2,  // limit orders: less slippage
  positionPct: 0.02,
});
