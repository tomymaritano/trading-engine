#!/usr/bin/env tsx
/**
 * Order Book Data Downloader — Tardis.dev
 *
 * Tardis.dev provides free historical L2 order book data.
 * Their HTTP API streams normalized market data as NDJSON.
 *
 * No API key needed for recent data (last 3 days free).
 * For older data, create a free account at tardis.dev.
 *
 * Usage:
 *   npx tsx scripts/download-orderbook.ts --symbol BTC-USDT --days 2
 *   npx tsx scripts/download-orderbook.ts --symbol ETH-USDT --date 2026-03-22
 *   TARDIS_API_KEY=xxx npx tsx scripts/download-orderbook.ts --symbol BTC-USDT --days 7
 *
 * Downloads:
 *   - book_snapshot_25 (top 25 levels, every 1s)
 *   - book_change (every delta)
 *   - trade
 *   - liquidation
 *
 * Output: data/orderbook/{symbol}/{date}.ndjson
 * Each line is a normalized market event with book depth.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

// ── CLI ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name: string, def = ""): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const symbol = arg("symbol", "BTC-USDT");
const days = Number(arg("days", "2"));
const dateArg = arg("date", "");
const apiKey = process.env.TARDIS_API_KEY ?? "";

// Tardis uses exchange-specific symbol formats
const tardisExchange = "binance";
const tardisSymbol = symbol.replace("-", "").toLowerCase(); // btcusdt

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function dateRange(startDate: Date, endDate: Date): string[] {
  const dates: string[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(formatDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

const endDate = new Date();
endDate.setUTCDate(endDate.getUTCDate() - 1); // yesterday (today's data may be incomplete)
const startDate = dateArg
  ? new Date(dateArg)
  : new Date(endDate.getTime() - (days - 1) * 86_400_000);

const dates = dateRange(startDate, endDate);

const outDir = join(process.cwd(), "data", "orderbook", symbol);
mkdirSync(outDir, { recursive: true });

console.log(`
╔══════════════════════════════════════════════════════╗
║      Order Book Data Downloader (Tardis.dev)         ║
╠══════════════════════════════════════════════════════╣
║  Symbol:    ${symbol.padEnd(40)}║
║  Exchange:  ${tardisExchange.padEnd(40)}║
║  Range:     ${formatDate(startDate)} → ${formatDate(endDate).padEnd(26)}║
║  Days:      ${String(dates.length).padEnd(40)}║
║  API Key:   ${apiKey ? "✅ set".padEnd(40) : "❌ not set (free tier: last 3d)".padEnd(40)}║
║  Output:    data/orderbook/${symbol.padEnd(28)}║
╚══════════════════════════════════════════════════════╝
`);

// ── Download ──────────────────────────────────────────────────────

/**
 * Tardis.dev Replay API
 *
 * GET https://api.tardis.dev/v1/data-feeds/{exchange}
 *   ?from={ISO date}
 *   &to={ISO date}
 *   &filters=[{"channel":"trade","symbols":["btcusdt"]}]
 *
 * Returns NDJSON stream of normalized events.
 * Free for last 3 days. API key for older data.
 */
async function downloadDay(date: string): Promise<{ events: number; bytes: number }> {
  const outFile = join(outDir, `${date}.ndjson`);

  if (existsSync(outFile)) {
    process.stdout.write(`  ⏭ ${date} (cached)\n`);
    return { events: 0, bytes: 0 };
  }

  const from = `${date}T00:00:00.000Z`;
  const to = `${date}T23:59:59.999Z`;

  const filters = JSON.stringify([
    { channel: "trade", symbols: [tardisSymbol] },
    { channel: "depthSnapshot", symbols: [tardisSymbol] },
  ]);

  const url = `https://api.tardis.dev/v1/data-feeds/${tardisExchange}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&filters=${encodeURIComponent(filters)}`;

  const headers: Record<string, string> = {
    Accept: "application/x-ndjson",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(url, { headers });

    if (res.status === 401) {
      console.error(`  ❌ ${date}: API key required for this date range.`);
      console.error(`     Get a free key at https://tardis.dev/signup`);
      console.error(`     Then: TARDIS_API_KEY=xxx npm run download:orderbook`);
      return { events: 0, bytes: 0 };
    }

    if (res.status === 429) {
      console.error(`  ⚠ ${date}: Rate limited. Wait a minute and retry.`);
      return { events: 0, bytes: 0 };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`  ❌ ${date}: HTTP ${res.status} — ${body.slice(0, 200)}`);
      return { events: 0, bytes: 0 };
    }

    // Stream response to file and convert to our format
    const writer = createWriteStream(outFile);
    let eventCount = 0;
    let totalBytes = 0;

    const reader = res.body?.getReader();
    if (!reader) {
      console.error(`  ❌ ${date}: No response body`);
      return { events: 0, bytes: 0 };
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);
          // Convert Tardis format to our format
          const normalized = normalizeTardisEvent(event, date);
          if (normalized) {
            const out = JSON.stringify(normalized) + "\n";
            writer.write(out);
            totalBytes += out.length;
            eventCount++;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    writer.end();
    process.stdout.write(`  ✅ ${date} — ${eventCount.toLocaleString()} events, ${(totalBytes / 1_000_000).toFixed(1)} MB\n`);
    return { events: eventCount, bytes: totalBytes };
  } catch (err) {
    console.error(`  ❌ ${date}: ${(err as Error).message}`);
    return { events: 0, bytes: 0 };
  }
}

/**
 * Normalize Tardis event format to our internal format.
 *
 * Tardis format:
 * { type: "trade", symbol: "btcusdt", exchange: "binance",
 *   price: 42000.5, amount: 0.1, side: "buy", timestamp: "2024-..." }
 *
 * { type: "book_snapshot_25_100ms", symbol: "btcusdt",
 *   bids: [[price, qty], ...], asks: [[price, qty], ...] }
 */
/**
 * Normalize Tardis raw replay events.
 *
 * Tardis replays the exchange's native WebSocket messages.
 * For Binance:
 * - trade: { "stream": "btcusdt@trade", "data": { "e":"trade", "p":"42000", "q":"0.1", "m":true, ... } }
 * - depthSnapshot: { "stream": "btcusdt@depthSnapshot", "data": { "bids":[...], "asks":[...] } }
 *
 * The raw format includes a localTimestamp and message fields.
 */
function normalizeTardisEvent(event: Record<string, unknown>, _date: string): Record<string, unknown> | null {
  // Tardis wraps events: { localTimestamp, message: { stream, data } }
  const message = (event.message ?? event) as Record<string, unknown>;
  const stream = (message.stream ?? "") as string;
  const data = (message.data ?? message) as Record<string, unknown>;
  const localTs = event.localTimestamp as string | undefined;
  const ts = localTs ? new Date(localTs).getTime() : Date.now();

  // Trade event
  if (stream.includes("@trade") || data.e === "trade") {
    return {
      type: "trade",
      ts: (data.T as number) ?? ts,
      id: String(data.t ?? ts),
      p: String(data.p ?? data.price ?? "0"),
      q: String(data.q ?? data.amount ?? "0"),
      s: data.m ? "sell" : "buy",
      m: data.m ?? false,
    };
  }

  // Depth snapshot
  if (stream.includes("@depth") || data.bids) {
    const bids = data.bids as unknown[][] | undefined;
    const asks = data.asks as unknown[][] | undefined;
    if (!bids || !asks) return null;

    return {
      type: "book_snapshot",
      ts,
      bids: bids.slice(0, 25).map(([p, q]) => [String(p), String(q)]),
      asks: asks.slice(0, 25).map(([p, q]) => [String(p), String(q)]),
    };
  }

  return null;
}

// ── Main ──────────────────────────────────────────────────────────

let totalEvents = 0;
let totalBytes = 0;
const startTime = Date.now();

console.log(`  📥 Downloading ${dates.length} day(s)...\n`);

for (const date of dates) {
  const result = await downloadDay(date);
  totalEvents += result.events;
  totalBytes += result.bytes;
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

console.log(`
╔══════════════════════════════════════════════════════╗
║  ✅ Complete                                         ║
╠══════════════════════════════════════════════════════╣
║  Events:    ${totalEvents.toLocaleString().padEnd(40)}║
║  Size:      ${(totalBytes / 1_000_000).toFixed(1).padEnd(37)}MB ║
║  Time:      ${elapsed.padEnd(38)}s  ║
║  Output:    ${outDir.slice(-40).padEnd(40)}║
╚══════════════════════════════════════════════════════╝

  Next: update the backtester to use this L2 data:
    npm run backtest -- --symbol ${symbol} --orderbook
`);
