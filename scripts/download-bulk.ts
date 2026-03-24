#!/usr/bin/env tsx
/**
 * Bulk Historical Data Downloader — Binance Data Vision
 *
 * Downloads pre-built trade/kline archives from Binance's public
 * data repository. No API key needed. No rate limits.
 *
 * Source: https://data.binance.vision
 *
 * A month of BTC-USDT trades (~50M rows) downloads in ~2 minutes
 * vs ~2 hours through the REST API.
 *
 * Usage:
 *   npx tsx scripts/download-bulk.ts --symbol BTCUSDT --days 30
 *   npx tsx scripts/download-bulk.ts --symbol ETHUSDT --days 7 --type klines --interval 1m
 *   npx tsx scripts/download-bulk.ts --symbol BTCUSDT --start 2024-01-01 --end 2024-01-31
 *   npx tsx scripts/download-bulk.ts --symbol BTCUSDT --days 90 --futures
 */

import { createWriteStream, existsSync, mkdirSync, createReadStream, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";

const execFileAsync = promisify(execFile);

// ── CLI ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name: string, def = ""): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const symbol = arg("symbol", "BTCUSDT");
const days = Number(arg("days", "7"));
const dataType = arg("type", "trades"); // trades | klines | aggTrades
const interval = arg("interval", "1m"); // for klines
const startArg = arg("start", "");
const endArg = arg("end", "");
const futures = args.includes("--futures");

const endDate = endArg ? new Date(endArg) : new Date();
const startDate = startArg ? new Date(startArg) : new Date(endDate.getTime() - days * 86_400_000);

const SPOT_BASE = "https://data.binance.vision/data/spot/daily";
const FUTURES_BASE = "https://data.binance.vision/data/futures/um/daily";
const BASE_URL = futures ? FUTURES_BASE : SPOT_BASE;

const outDir = join(process.cwd(), "data", futures ? "futures" : "spot", symbol);
mkdirSync(outDir, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function dateRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  const current = new Date(start);
  current.setUTCHours(0, 0, 0, 0);
  const endNorm = new Date(end);
  endNorm.setUTCHours(0, 0, 0, 0);

  while (current <= endNorm) {
    dates.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function buildUrl(date: Date): string {
  const dateStr = formatDate(date);
  if (dataType === "klines") {
    return `${BASE_URL}/klines/${symbol}/${interval}/${symbol}-${interval}-${dateStr}.zip`;
  }
  if (dataType === "aggTrades") {
    return `${BASE_URL}/aggTrades/${symbol}/${symbol}-aggTrades-${dateStr}.zip`;
  }
  return `${BASE_URL}/trades/${symbol}/${symbol}-trades-${dateStr}.zip`;
}

async function downloadAndExtract(url: string, dateStr: string): Promise<{ rows: number; bytes: number } | null> {
  const csvFile = join(outDir, `${dateStr}.csv`);

  if (existsSync(csvFile)) return null;

  const zipFile = join(outDir, `${dateStr}.zip`);

  try {
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      process.stdout.write(`\n  ⚠ ${dateStr}: HTTP ${res.status}`);
      return null;
    }

    // Save ZIP
    const fileStream = createWriteStream(zipFile);
    // @ts-expect-error ReadableStream to NodeStream
    await pipeline(Readable.fromWeb(res.body!), fileStream);

    // Extract ZIP using execFile (safe, no shell injection)
    try {
      await execFileAsync("unzip", ["-o", "-q", zipFile, "-d", outDir]);
    } catch {
      process.stdout.write(`\n  ⚠ ${dateStr}: unzip failed`);
      if (existsSync(zipFile)) unlinkSync(zipFile);
      return null;
    }

    if (existsSync(zipFile)) unlinkSync(zipFile);

    // Find the extracted CSV (Binance names files like BTCUSDT-trades-2024-01-15.csv)
    const { readdirSync } = await import("node:fs");
    const extractedCsv = readdirSync(outDir).find(
      (f) => f.includes(dateStr) && f.endsWith(".csv"),
    );

    const actualCsv = extractedCsv ? join(outDir, extractedCsv) : csvFile;
    if (!existsSync(actualCsv)) return null;

    const { statSync } = await import("node:fs");
    const stat = statSync(actualCsv);
    const estimatedRows = Math.floor(stat.size / 60);

    return { rows: estimatedRows, bytes: stat.size };
  } catch (err) {
    process.stdout.write(`\n  ❌ ${dateStr}: ${(err as Error).message}`);
    if (existsSync(zipFile)) unlinkSync(zipFile);
    return null;
  }
}

/**
 * Convert Binance CSV to our NDJSON format for the backtest runner.
 *
 * Trade CSV columns: id, price, qty, quoteQty, time, isBuyerMaker, isBestMatch
 * AggTrade CSV: agg_trade_id, price, quantity, first_trade_id, last_trade_id, transact_time, is_buyer_maker
 */
async function csvToNdjson(csvFile: string, ndjsonFile: string): Promise<number> {
  const { createInterface } = await import("node:readline");

  const rl = createInterface({
    input: createReadStream(csvFile),
    crlfDelay: Infinity,
  });

  const out = createWriteStream(ndjsonFile);
  let count = 0;
  let isFirst = true;

  for await (const line of rl) {
    if (isFirst) {
      isFirst = false;
      if (line.startsWith("id") || line.startsWith("agg")) continue;
    }

    const parts = line.split(",");
    if (parts.length < 6) continue;

    if (dataType === "aggTrades") {
      out.write(JSON.stringify({
        id: parts[0],
        ts: Number(parts[5]),
        p: parts[1],
        q: parts[2],
        s: parts[6]?.trim() === "True" ? "sell" : "buy",
        m: parts[6]?.trim() === "True",
      }) + "\n");
    } else {
      out.write(JSON.stringify({
        id: parts[0],
        ts: Number(parts[4]),
        p: parts[1],
        q: parts[2],
        s: parts[5]?.trim() === "True" ? "sell" : "buy",
        m: parts[5]?.trim() === "True",
      }) + "\n");
    }
    count++;
  }

  out.end();
  return count;
}

// ── Main ──────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════╗
║         Binance Data Vision — Bulk Downloader        ║
╠══════════════════════════════════════════════════════╣
║  Symbol:   ${symbol.padEnd(41)}║
║  Type:     ${dataType.padEnd(41)}║
║  Range:    ${formatDate(startDate)} → ${formatDate(endDate).padEnd(27)}║
║  Source:   data.binance.vision${" ".repeat(21)}║
╚══════════════════════════════════════════════════════╝
`);

const dates = dateRange(startDate, endDate);
let totalBytes = 0;
let downloaded = 0;
let skipped = 0;
const startTime = Date.now();

console.log(`  📥 Downloading ${dates.length} day(s)...\n`);

// Download in parallel batches of 5
const BATCH_SIZE = 5;

for (let i = 0; i < dates.length; i += BATCH_SIZE) {
  const batch = dates.slice(i, i + BATCH_SIZE);

  await Promise.all(
    batch.map(async (date) => {
      const dateStr = formatDate(date);
      const url = buildUrl(date);
      const result = await downloadAndExtract(url, dateStr);

      if (result === null) {
        const possibleCsv = [
          join(outDir, `${dateStr}.csv`),
          join(outDir, `${symbol}-trades-${dateStr}.csv`),
          join(outDir, `${symbol}-aggTrades-${dateStr}.csv`),
        ];
        if (possibleCsv.some((f) => existsSync(f))) {
          process.stdout.write(`  ⏭ ${dateStr} (cached)\n`);
          skipped++;
        }
        return;
      }

      process.stdout.write(`  ✅ ${dateStr} — ${(result.bytes / 1_000_000).toFixed(1)} MB\n`);
      totalBytes += result.bytes;
      downloaded++;
    }),
  );
}

// ── Convert to NDJSON ─────────────────────────────────────────────

console.log(`\n  🔄 Converting to NDJSON...\n`);

// Derive normalized symbol: BTCUSDT → BTC-USDT
const normalized = symbol.replace(/USDT$/, "-USDT").replace(/USDC$/, "-USDC").replace(/BTC$/, "-BTC");
const ndjsonDir = join(process.cwd(), "data", "trades", normalized);
mkdirSync(ndjsonDir, { recursive: true });

let convertedRows = 0;
const { readdirSync } = await import("node:fs");

for (const date of dates) {
  const dateStr = formatDate(date);
  const ndjsonFile = join(ndjsonDir, `${dateStr}.ndjson`);
  if (existsSync(ndjsonFile)) {
    process.stdout.write(`  ⏭ ${dateStr}.ndjson (cached)\n`);
    continue;
  }

  // Find the CSV for this date
  const csvFiles = readdirSync(outDir).filter(
    (f) => f.includes(dateStr) && f.endsWith(".csv"),
  );

  if (csvFiles.length === 0) continue;

  const csvPath = join(outDir, csvFiles[0]);
  const rows = await csvToNdjson(csvPath, ndjsonFile);
  convertedRows += rows;
  process.stdout.write(`  📝 ${dateStr} → ${rows.toLocaleString()} rows\n`);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

console.log(`
╔══════════════════════════════════════════════════════╗
║  ✅ Complete                                         ║
╠══════════════════════════════════════════════════════╣
║  Downloaded:  ${String(downloaded).padEnd(38)}║
║  Cached:      ${String(skipped).padEnd(38)}║
║  Size:        ${(totalBytes / 1_000_000).toFixed(1).padEnd(35)}MB ║
║  Converted:   ${convertedRows.toLocaleString().padEnd(35)}rows║
║  Time:        ${elapsed.padEnd(36)}s  ║
╚══════════════════════════════════════════════════════╝

  Run backtest:
    npm run backtest -- --symbol ${normalized}
`);
