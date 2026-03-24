#!/usr/bin/env tsx
/**
 * Per-Symbol Feature Analysis — compares alpha across BTC, SOL, ETH.
 */

import { existsSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stddev, bookImbalance } from "../src/utils/math.js";

const captureDir = join(process.cwd(), "data", "capture");
const dates = readdirSync(captureDir).filter((d) => !d.startsWith(".")).sort();

// Load all data
const allBooks: any[] = [];
const allTrades: any[] = [];

for (const date of dates) {
  const bf = join(captureDir, date, "book.ndjson");
  const tf = join(captureDir, date, "trades.ndjson");
  if (existsSync(bf)) {
    const rl = createInterface({ input: createReadStream(bf), crlfDelay: Infinity });
    for await (const line of rl) { if (line.trim()) try { allBooks.push(JSON.parse(line)); } catch {} }
  }
  if (existsSync(tf)) {
    const rl = createInterface({ input: createReadStream(tf), crlfDelay: Infinity });
    for await (const line of rl) { if (line.trim()) try { allTrades.push(JSON.parse(line)); } catch {} }
  }
}

// Analyze each symbol separately
const symbols = ["BTC-USDT", "SOL-USDT", "ETH-USDT"];

console.log("╔═══════════════════════════════════════════════════════════════╗");
console.log("║     Per-Symbol Alpha Analysis                                ║");
console.log("║     Comparing edge across BTC, SOL, ETH                      ║");
console.log("╚═══════════════════════════════════════════════════════════════╝\n");

for (const sym of symbols) {
  const books = allBooks.filter((b) => b.symbol === sym);
  const trades = allTrades.filter((t) => t.symbol === sym);

  if (books.length < 50 || trades.length < 100) {
    console.log(`  ${sym}: Not enough data (${books.length} books, ${trades.length} trades)\n`);
    continue;
  }

  // Build snapshots for this symbol only
  const events = [
    ...books.map((b: any) => ({ ts: b.ts, type: "book" as const, data: b })),
    ...trades.map((t: any) => ({ ts: t.ts, type: "trade" as const, data: t })),
  ].sort((a, b) => a.ts - b.ts);

  let currentBook: any = null;
  const recentTrades: any[] = [];
  const snaps: { ts: number; mid: number; imb5: number; tradeImb: number }[] = [];
  let lastTs = 0;

  for (const event of events) {
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

    snaps.push({
      ts: event.ts,
      mid,
      imb5: bookImbalance(bq5, aq5),
      tradeImb: tv > 0 ? (bv - sv) / tv : 0,
    });
  }

  // Compute future returns
  for (let i = 0; i < snaps.length; i++) {
    for (let j = i + 1; j < snaps.length; j++) {
      const dt = snaps[j].ts - snaps[i].ts;
      if (dt >= 28000 && dt <= 32000) {
        (snaps[i] as any).ret30s = (snaps[j].mid - snaps[i].mid) / snaps[i].mid;
        break;
      }
      if (dt > 35000) break;
    }
  }

  const valid = snaps.filter((s) => (s as any).ret30s !== undefined);

  if (valid.length < 20) {
    console.log(`  ${sym}: Not enough future returns (${valid.length} valid snapshots)\n`);
    continue;
  }

  // Quintile analysis
  const sorted = [...valid].sort((a, b) => a.imb5 - b.imb5);
  const binSize = Math.floor(sorted.length / 5);

  const G = "\x1b[32m";
  const R = "\x1b[31m";
  const Y = "\x1b[33m";
  const C = "\x1b[36m";
  const B = "\x1b[1m";
  const D = "\x1b[2m";
  const X = "\x1b[0m";

  console.log(`${B}${C}  ── ${sym} ──${X}`);
  console.log(`  ${D}Books: ${books.length} | Trades: ${trades.length} | Snapshots: ${valid.length}${X}`);
  console.log(`  ${D}Price: $${snaps[0]?.mid.toFixed(2)} | Spread: ${sym === "BTC-USDT" ? "~$0.01" : "varies"}${X}\n`);
  console.log(`  ${"Quintile".padEnd(12)} ${"Avg Imb".padEnd(10)} ${"Avg Return".padEnd(14)} ${"Win Rate".padEnd(10)} Count`);

  const quintileReturns: number[] = [];

  for (let q = 0; q < 5; q++) {
    const start = q * binSize;
    const end = q === 4 ? sorted.length : (q + 1) * binSize;
    const bin = sorted.slice(start, end);

    const avgImb = bin.reduce((s, d) => s + d.imb5, 0) / bin.length;
    const avgRet = bin.reduce((s, d) => s + (d as any).ret30s, 0) / bin.length;
    const winRate = bin.filter((d) => (d as any).ret30s > 0).length / bin.length;

    quintileReturns.push(avgRet);

    const retBps = avgRet * 10000;
    const retColor = retBps >= 0 ? G : R;

    console.log(
      `  Q${q + 1}${q === 0 ? " (bear)" : q === 4 ? " (bull)" : "       "}` +
      `${avgImb.toFixed(3).padStart(8)}  ` +
      `${retColor}${retBps.toFixed(2).padStart(8)} bps${X}   ` +
      `${(winRate * 100).toFixed(1).padStart(5)}%     ${bin.length}`,
    );
  }

  const spread = (quintileReturns[4] - quintileReturns[0]) * 10000;

  // IC
  const features = valid.map((s) => s.imb5);
  const returns = valid.map((s) => (s as any).ret30s as number);
  const fRanks = rankArray(features);
  const rRanks = rankArray(returns);
  let sumD2 = 0;
  for (let i = 0; i < valid.length; i++) sumD2 += (fRanks[i] - rRanks[i]) ** 2;
  const ic = 1 - (6 * sumD2) / (valid.length * (valid.length * valid.length - 1));

  const profitable4bps = spread > 4;
  const profitable8bps = spread > 8;

  console.log(`  ───────────────────────────────────────────────────`);
  console.log(`  Q5-Q1 spread: ${B}${spread.toFixed(2)} bps${X} | IC: ${B}${ic.toFixed(4)}${X} ${Math.abs(ic) > 0.02 ? `${G}★ predictive${X}` : `${Y}○ weak${X}`}`);
  console.log(`  Profitable after 4 bps fees: ${profitable4bps ? `${G}YES${X}` : `${R}NO${X}`}`);
  console.log(`  Profitable after 8 bps fees: ${profitable8bps ? `${G}YES${X}` : `${R}NO${X}`}`);
  console.log("");
}

function rankArray(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < indexed.length; i++) ranks[indexed[i].i] = i + 1;
  return ranks;
}
