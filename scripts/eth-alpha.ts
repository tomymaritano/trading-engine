#!/usr/bin/env tsx
import { existsSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { bookImbalance } from "../src/utils/math.js";

const captureDir = join(process.cwd(), "data", "capture");
const dates = readdirSync(captureDir).filter((d) => !d.startsWith(".")).sort();
const books: any[] = [];
const trades: any[] = [];

for (const date of dates) {
  const bf = join(captureDir, date, "book.ndjson");
  const tf = join(captureDir, date, "trades.ndjson");
  if (existsSync(bf)) {
    const rl = createInterface({ input: createReadStream(bf), crlfDelay: Infinity });
    for await (const l of rl) { if (l.trim()) try { const d = JSON.parse(l); if (d.bids && d.symbol === "ETH-USDT") books.push(d); } catch {} }
  }
  if (existsSync(tf)) {
    const rl = createInterface({ input: createReadStream(tf), crlfDelay: Infinity });
    for await (const l of rl) { if (l.trim()) try { const d = JSON.parse(l); if (d.type === "trade" && d.symbol === "ETH-USDT") trades.push(d); } catch {} }
  }
}

console.log(`ETH Books: ${books.length} | Trades: ${trades.length}`);

const events = [
  ...books.map((b: any) => ({ ts: b.ts, type: "book" as const, data: b })),
  ...trades.map((t: any) => ({ ts: t.ts, type: "trade" as const, data: t })),
].sort((a, b) => a.ts - b.ts);

let cb: any = null;
const rt: any[] = [];
const snaps: any[] = [];
let lt = 0;

for (const e of events) {
  if (e.type === "book") { cb = e.data; continue; }
  rt.push(e.data);
  while (rt.length > 0 && rt[0].ts < e.ts - 5000) rt.shift();
  if (e.ts - lt < 1000 || !cb || rt.length < 2) continue;
  lt = e.ts;

  const bids = cb.bids.map(([p, q]: string[]) => ({ price: Number(p), qty: Number(q) }));
  const asks = cb.asks.map(([p, q]: string[]) => ({ price: Number(p), qty: Number(q) }));
  if (!bids.length || !asks.length) continue;

  const mid = (bids[0].price + asks[0].price) / 2;
  const bq5 = bids.slice(0, 5).reduce((s: number, l: any) => s + l.qty, 0);
  const aq5 = asks.slice(0, 5).reduce((s: number, l: any) => s + l.qty, 0);
  let bv = 0, sv = 0;
  for (const t of rt) { const q = Number(t.q); if (t.s === "buy") bv += q; else sv += q; }
  const tv = bv + sv;

  snaps.push({ ts: e.ts, mid, imb5: bookImbalance(bq5, aq5), tradeImb: tv > 0 ? (bv - sv) / tv : 0 });
}

// Future returns
for (let i = 0; i < snaps.length; i++) {
  for (let j = i + 1; j < snaps.length; j++) {
    const dt = snaps[j].ts - snaps[i].ts;
    if (dt >= 13000 && dt <= 17000 && snaps[i].ret15s === undefined) {
      snaps[i].ret15s = (snaps[j].mid - snaps[i].mid) / snaps[i].mid;
    }
    if (dt >= 28000 && dt <= 32000 && snaps[i].ret30s === undefined) {
      snaps[i].ret30s = (snaps[j].mid - snaps[i].mid) / snaps[i].mid;
    }
    if (dt > 35000) break;
  }
}

const valid = snaps.filter((s: any) => s.ret15s !== undefined);
console.log(`ETH valid snaps: ${valid.length}\n`);

console.log("  Gross bps | Win%  | Trades | Horizon | net@2bps | net@4bps | Filter");
console.log("  ──────────┼───────┼────────┼─────────┼──────────┼──────────┼────────");

for (const thresh of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  for (const horizon of ["15s", "30s"] as const) {
    const getRet = (s: any) => horizon === "15s" ? s.ret15s : s.ret30s;
    const results: { ret: number }[] = [];

    for (const s of valid) {
      if (getRet(s) === undefined) continue;
      if (s.imb5 > thresh) results.push({ ret: getRet(s) });
      else if (s.imb5 < -thresh) results.push({ ret: -getRet(s) });
    }

    if (results.length < 10) continue;

    const avgBps = results.reduce((s, r) => s + r.ret, 0) / results.length * 10000;
    const winRate = results.filter((r) => r.ret > 0).length / results.length;
    const net2 = avgBps - 2;
    const net4 = avgBps - 4;
    const G = "\x1b[32m";
    const R = "\x1b[31m";
    const Y = "\x1b[33m";
    const X = "\x1b[0m";

    const color = avgBps > 4 ? G : avgBps > 2 ? Y : R;

    console.log(
      `  ${color}${avgBps.toFixed(2).padStart(6)} bps${X}` +
      ` | ${(winRate * 100).toFixed(0).padStart(4)}%` +
      ` | ${String(results.length).padStart(6)}` +
      ` |   ${horizon}` +
      `   | ${(net2 >= 0 ? G : R)}${net2.toFixed(1).padStart(5)}${X}` +
      `    | ${(net4 >= 0 ? G : R)}${net4.toFixed(1).padStart(5)}${X}` +
      `    | ETH imb>${thresh}`,
    );
  }
}

// Also test with trade flow confirmation
console.log("\n  With trade flow confirmation (imb + flow agree):");
console.log("  ──────────┼───────┼────────┼─────────┼──────────┼──────────┼────────");

for (const imbThresh of [0.6, 0.7, 0.8, 0.9]) {
  for (const flowThresh of [0.1, 0.2]) {
    const results: { ret: number }[] = [];
    for (const s of valid) {
      if (s.ret15s === undefined) continue;
      if (s.imb5 > imbThresh && s.tradeImb > flowThresh) results.push({ ret: s.ret15s });
      else if (s.imb5 < -imbThresh && s.tradeImb < -flowThresh) results.push({ ret: -s.ret15s });
    }
    if (results.length < 10) continue;

    const avgBps = results.reduce((s, r) => s + r.ret, 0) / results.length * 10000;
    const winRate = results.filter((r) => r.ret > 0).length / results.length;
    const net2 = avgBps - 2;
    const net4 = avgBps - 4;
    const G = "\x1b[32m"; const R = "\x1b[31m"; const Y = "\x1b[33m"; const X = "\x1b[0m";
    const color = avgBps > 4 ? G : avgBps > 2 ? Y : R;

    console.log(
      `  ${color}${avgBps.toFixed(2).padStart(6)} bps${X}` +
      ` | ${(winRate * 100).toFixed(0).padStart(4)}%` +
      ` | ${String(results.length).padStart(6)}` +
      ` |   15s` +
      `   | ${(net2 >= 0 ? G : R)}${net2.toFixed(1).padStart(5)}${X}` +
      `    | ${(net4 >= 0 ? G : R)}${net4.toFixed(1).padStart(5)}${X}` +
      `    | ETH imb>${imbThresh} flow>${flowThresh}`,
    );
  }
}
