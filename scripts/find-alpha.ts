#!/usr/bin/env tsx
/**
 * Alpha Discovery — find the strongest signal combinations.
 *
 * Tests every combination of features and filters to find
 * which ones produce the highest edge AFTER realistic costs.
 *
 * This is the most important script in the entire project.
 */

import { existsSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stddev, bookImbalance } from "../src/utils/math.js";

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

// ── Build snapshots ──────────────────────────────────────────────

interface Snap {
  ts: number;
  mid: number;
  imb5: number;       // book imbalance top 5
  imb20: number;      // book imbalance top 20
  tradeImb: number;   // trade flow imbalance
  bidDepth: number;   // total bid depth (quote)
  askDepth: number;   // total ask depth (quote)
  depthRatio: number; // bid/ask depth ratio
  spread: number;     // bid-ask spread
  aggIntensity: number; // trades per second
  bigTradeRatio: number; // % of volume from large trades
  buyPressure: number;  // net buy volume
  // Future returns
  ret15s?: number;
  ret30s?: number;
  ret60s?: number;
}

const allEvents = [
  ...books.map((b: any) => ({ ts: b.ts, type: "book" as const, data: b })),
  ...trades.map((t: any) => ({ ts: t.ts, type: "trade" as const, data: t })),
].sort((a, b) => a.ts - b.ts);

let currentBook: any = null;
const recentTrades: any[] = [];
const snaps: Snap[] = [];
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
  const bq20 = bids.reduce((s: number, l: any) => s + l.qty, 0);
  const aq20 = asks.reduce((s: number, l: any) => s + l.qty, 0);
  const bidDepth = bids.reduce((s: number, l: any) => s + l.price * l.qty, 0);
  const askDepth = asks.reduce((s: number, l: any) => s + l.price * l.qty, 0);

  let bv = 0, sv = 0;
  const qtys = recentTrades.map((t: any) => Number(t.q));
  const meanQty = qtys.reduce((a: number, b: number) => a + b, 0) / qtys.length;
  let bigVol = 0;
  for (const t of recentTrades) {
    const q = Number(t.q);
    if (t.s === "buy") bv += q; else sv += q;
    if (q > meanQty * 2) bigVol += q;
  }
  const tv = bv + sv;

  snaps.push({
    ts: event.ts, mid,
    imb5: bookImbalance(bq5, aq5),
    imb20: bookImbalance(bq20, aq20),
    tradeImb: tv > 0 ? (bv - sv) / tv : 0,
    bidDepth, askDepth,
    depthRatio: askDepth > 0 ? bidDepth / askDepth : 1,
    spread: asks[0].price - bids[0].price,
    aggIntensity: recentTrades.length / 5,
    bigTradeRatio: tv > 0 ? bigVol / tv : 0,
    buyPressure: bv - sv,
  });
}

// Compute future returns
for (let i = 0; i < snaps.length; i++) {
  for (let j = i + 1; j < snaps.length; j++) {
    const dt = snaps[j].ts - snaps[i].ts;
    if (dt >= 13000 && dt <= 17000 && snaps[i].ret15s === undefined)
      snaps[i].ret15s = (snaps[j].mid - snaps[i].mid) / snaps[i].mid;
    if (dt >= 28000 && dt <= 32000 && snaps[i].ret30s === undefined)
      snaps[i].ret30s = (snaps[j].mid - snaps[i].mid) / snaps[i].mid;
    if (dt >= 55000 && dt <= 65000 && snaps[i].ret60s === undefined)
      snaps[i].ret60s = (snaps[j].mid - snaps[i].mid) / snaps[i].mid;
    if (dt > 65000) break;
  }
}

const valid = snaps.filter((s) => s.ret30s !== undefined);
console.log(`\nSnapshots: ${snaps.length} | With future returns: ${valid.length}\n`);

// ── Test signal combinations ─────────────────────────────────────

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const X = "\x1b[0m";

interface SignalTest {
  name: string;
  filter: (s: Snap) => "long" | "short" | null;
  horizon: "15s" | "30s" | "60s";
}

function testSignal(test: SignalTest): void {
  const getReturn = (s: Snap) =>
    test.horizon === "15s" ? s.ret15s! :
    test.horizon === "30s" ? s.ret30s! : s.ret60s!;

  const results: { dir: "long" | "short"; ret: number }[] = [];

  for (const s of valid) {
    if (getReturn(s) === undefined) continue;
    const dir = test.filter(s);
    if (!dir) continue;
    const ret = dir === "long" ? getReturn(s) : -getReturn(s);
    results.push({ dir, ret });
  }

  if (results.length < 20) return;

  const avgRet = results.reduce((sum, r) => sum + r.ret, 0) / results.length;
  const avgBps = avgRet * 10000;
  const winRate = results.filter((r) => r.ret > 0).length / results.length;
  const sd = stddev(results.map((r) => r.ret));
  const sharpe = sd > 0 ? (avgRet / sd) * Math.sqrt(results.length) : 0;

  // Net of costs
  const costs = [2, 4, 6, 8, 12]; // different fee scenarios in bps
  const netBps = costs.map((c) => avgBps - c);

  const color = avgBps > 3 ? G : avgBps > 0 ? Y : R;
  const profitAt = costs.findIndex((c) => avgBps > c);

  console.log(
    `  ${color}${avgBps.toFixed(2).padStart(6)} bps${X}` +
    ` | win ${(winRate * 100).toFixed(0).padStart(3)}%` +
    ` | ${results.length.toString().padStart(5)} trades` +
    ` | sharpe ${sharpe.toFixed(1).padStart(5)}` +
    ` | ${test.horizon}` +
    ` | net@4bps: ${(avgBps - 4) >= 0 ? G : R}${(avgBps - 4).toFixed(1)}${X}` +
    ` | ${D}${test.name}${X}`,
  );
}

console.log(`${B}${C}╔══════════════════════════════════════════════════════════════════════════╗${X}`);
console.log(`${B}${C}║     Alpha Discovery — Testing Signal Combinations                       ║${X}`);
console.log(`${B}${C}║     Profitable if avg bps > cost (4 bps for futures maker)               ║${X}`);
console.log(`${B}${C}╚══════════════════════════════════════════════════════════════════════════╝${X}\n`);

// ── Single features ──────────────────────────────────────────────
console.log(`${B}  Single Features:${X}`);

for (const horizon of ["15s", "30s", "60s"] as const) {
  for (const thresh of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    testSignal({
      name: `book_imb > ${thresh} (${horizon})`,
      horizon,
      filter: (s) => s.imb5 > thresh ? "long" : s.imb5 < -thresh ? "short" : null,
    });
  }
}

// ── Combined features ────────────────────────────────────────────
console.log(`\n${B}  Book Imbalance + Trade Flow (both must agree):${X}`);

for (const horizon of ["15s", "30s"] as const) {
  for (const imbThresh of [0.4, 0.5, 0.6, 0.7]) {
    for (const flowThresh of [0.1, 0.2, 0.3]) {
      testSignal({
        name: `imb>${imbThresh} + flow>${flowThresh}`,
        horizon,
        filter: (s) => {
          if (s.imb5 > imbThresh && s.tradeImb > flowThresh) return "long";
          if (s.imb5 < -imbThresh && s.tradeImb < -flowThresh) return "short";
          return null;
        },
      });
    }
  }
}

// ── Book + Depth ratio ───────────────────────────────────────────
console.log(`\n${B}  Book Imbalance + Depth Ratio (book + depth agree):${X}`);

for (const horizon of ["15s", "30s"] as const) {
  for (const imbThresh of [0.5, 0.6, 0.7]) {
    for (const depthThresh of [1.2, 1.5, 2.0]) {
      testSignal({
        name: `imb>${imbThresh} + depthRatio>${depthThresh}`,
        horizon,
        filter: (s) => {
          if (s.imb5 > imbThresh && s.depthRatio > depthThresh) return "long";
          if (s.imb5 < -imbThresh && s.depthRatio < 1 / depthThresh) return "short";
          return null;
        },
      });
    }
  }
}

// ── Triple confirmation ──────────────────────────────────────────
console.log(`\n${B}  Triple: Book + Trade Flow + Depth Ratio:${X}`);

for (const horizon of ["15s", "30s"] as const) {
  for (const imbThresh of [0.4, 0.5, 0.6]) {
    testSignal({
      name: `imb>${imbThresh} + flow>0.1 + depth>1.3`,
      horizon,
      filter: (s) => {
        if (s.imb5 > imbThresh && s.tradeImb > 0.1 && s.depthRatio > 1.3) return "long";
        if (s.imb5 < -imbThresh && s.tradeImb < -0.1 && s.depthRatio < 1 / 1.3) return "short";
        return null;
      },
    });
  }
}

// ── Big trades as filter ─────────────────────────────────────────
console.log(`\n${B}  Book Imbalance + Large Trade Activity:${X}`);

for (const horizon of ["15s", "30s"] as const) {
  for (const imbThresh of [0.5, 0.6, 0.7]) {
    testSignal({
      name: `imb>${imbThresh} + bigTradeRatio>0.2`,
      horizon,
      filter: (s) => {
        if (s.bigTradeRatio < 0.2) return null; // need institutional activity
        if (s.imb5 > imbThresh) return "long";
        if (s.imb5 < -imbThresh) return "short";
        return null;
      },
    });
  }
}

// ── Spread filter (only trade when spread is tight) ──────────────
console.log(`\n${B}  Book Imbalance + Tight Spread:${X}`);

for (const horizon of ["15s", "30s"] as const) {
  const medianSpread = [...valid].sort((a, b) => a.spread - b.spread)[Math.floor(valid.length / 2)].spread;
  for (const imbThresh of [0.5, 0.6, 0.7]) {
    testSignal({
      name: `imb>${imbThresh} + spread<median(${medianSpread.toFixed(2)})`,
      horizon,
      filter: (s) => {
        if (s.spread > medianSpread) return null;
        if (s.imb5 > imbThresh) return "long";
        if (s.imb5 < -imbThresh) return "short";
        return null;
      },
    });
  }
}

// ── Aggressive intensity as momentum signal ──────────────────────
console.log(`\n${B}  Book Imbalance + High Trade Intensity:${X}`);

for (const horizon of ["15s", "30s"] as const) {
  for (const imbThresh of [0.5, 0.6]) {
    for (const intThresh of [5, 10, 15]) {
      testSignal({
        name: `imb>${imbThresh} + intensity>${intThresh}`,
        horizon,
        filter: (s) => {
          if (s.aggIntensity < intThresh) return null;
          if (s.imb5 > imbThresh) return "long";
          if (s.imb5 < -imbThresh) return "short";
          return null;
        },
      });
    }
  }
}

console.log(`\n${D}  Legend: avg bps = gross return per trade | net@4bps = return after futures maker fees${X}\n`);
