#!/usr/bin/env tsx
/**
 * Historical data downloader.
 *
 * Usage:
 *   npx tsx scripts/download-data.ts --symbol BTC-USDT --days 30
 *   npx tsx scripts/download-data.ts --symbol ETH-USDT --days 7 --interval 1m
 *   npx tsx scripts/download-data.ts --symbol BTC-USDT --start 2024-01-01 --end 2024-01-31
 *
 * Downloads aggregated trades and/or klines from Binance
 * and stores them as compressed NDJSON in data/ticks/
 */

import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";
import { createWriteStream } from "node:fs";
import { BinanceRestClient } from "../src/adapters/rest/binance-rest.js";

// ── Parse CLI args ────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, defaultValue?: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue ?? "";
  return args[idx + 1] ?? defaultValue ?? "";
}

const symbol = getArg("symbol", "BTC-USDT");
const days = Number(getArg("days", "7"));
const interval = getArg("interval", ""); // empty = download trades
const startArg = getArg("start", "");
const endArg = getArg("end", "");
const futures = args.includes("--futures");
const dataType = interval ? "klines" : "trades";

const endTs = endArg ? new Date(endArg).getTime() : Date.now();
const startTs = startArg ? new Date(startArg).getTime() : endTs - days * 86_400_000;

console.log(`
╔══════════════════════════════════════════════╗
║          Historical Data Downloader          ║
╠══════════════════════════════════════════════╣
║  Symbol:   ${symbol.padEnd(33)}║
║  Type:     ${dataType.padEnd(33)}║
║  Range:    ${new Date(startTs).toISOString().split("T")[0]} → ${new Date(endTs).toISOString().split("T")[0]}  ║
║  Days:     ${String(Math.ceil((endTs - startTs) / 86_400_000)).padEnd(33)}║
║  Futures:  ${String(futures).padEnd(33)}║
╚══════════════════════════════════════════════╝
`);

// ── Download ──────────────────────────────────────────────────────

const client = new BinanceRestClient();
const baseDir = join(process.cwd(), "data");

async function downloadTrades(): Promise<void> {
  const outDir = join(baseDir, "trades", symbol.replace("/", "-"));
  mkdirSync(outDir, { recursive: true });

  let totalTrades = 0;
  let currentDay = "";
  let currentFile: ReturnType<typeof createWriteStream> | null = null;

  for await (const batch of client.fetchAggTrades(symbol, startTs, endTs, futures)) {
    for (const trade of batch) {
      const day = new Date(trade.ts).toISOString().split("T")[0];

      if (day !== currentDay) {
        currentFile?.end();
        currentDay = day;
        const filePath = join(outDir, `${day}.ndjson`);
        currentFile = createWriteStream(filePath, { flags: "a" });
        process.stdout.write(`\n  📅 ${day} `);
      }

      const line = JSON.stringify({
        id: trade.id,
        ts: trade.ts,
        p: trade.price.toString(),
        q: trade.qty.toString(),
        s: trade.side,
        m: trade.isBuyerMaker,
      });
      currentFile!.write(line + "\n");
      totalTrades++;
    }

    // Progress indicator
    process.stdout.write(".");
  }

  currentFile?.end();
  console.log(`\n\n  ✅ Downloaded ${totalTrades.toLocaleString()} trades`);
  console.log(`  📁 Saved to ${outDir}\n`);
}

async function downloadKlines(): Promise<void> {
  const outDir = join(baseDir, "klines", symbol.replace("/", "-"));
  mkdirSync(outDir, { recursive: true });

  const filePath = join(outDir, `${interval}_${new Date(startTs).toISOString().split("T")[0]}_${new Date(endTs).toISOString().split("T")[0]}.ndjson`);
  const file = createWriteStream(filePath);

  let totalKlines = 0;

  for await (const batch of client.fetchKlines(symbol, interval, startTs, endTs, futures)) {
    for (const kline of batch) {
      const line = JSON.stringify({
        t: kline.openTs,
        o: kline.open.toString(),
        h: kline.high.toString(),
        l: kline.low.toString(),
        c: kline.close.toString(),
        v: kline.volume.toString(),
        qv: kline.quoteVolume.toString(),
        n: kline.trades,
      });
      file.write(line + "\n");
      totalKlines++;
    }
    process.stdout.write(".");
  }

  file.end();
  console.log(`\n\n  ✅ Downloaded ${totalKlines.toLocaleString()} klines (${interval})`);
  console.log(`  📁 Saved to ${filePath}\n`);
}

// ── Run ────────────────────────────────────────────────────────

const startTime = Date.now();

if (dataType === "trades") {
  await downloadTrades();
} else {
  await downloadKlines();
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`  ⏱  Completed in ${elapsed}s\n`);
