#!/usr/bin/env tsx
/**
 * Order Book Capture — records L2 snapshots from Binance REST API.
 *
 * Polls order book every second (free, no API key) and simultaneously
 * captures trades via WebSocket. Saves everything to NDJSON files.
 *
 * 4-6 hours = ~15k book snapshots + ~200k trades = enough for a real backtest.
 *
 * Usage:
 *   npx tsx scripts/capture-book.ts
 *   npx tsx scripts/capture-book.ts --symbols BTC-USDT,ETH-USDT --duration 4h
 *   npx tsx scripts/capture-book.ts --symbols BTC-USDT --duration 30m   # quick test
 *
 * Output:
 *   data/capture/{date}/trades.ndjson
 *   data/capture/{date}/book.ndjson
 *
 * Leave it running in a terminal or via PM2. Ctrl+C to stop cleanly.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

// ── CLI ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name: string, def = ""): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const symbols = arg("symbols", "BTC-USDT").split(",");
const durationStr = arg("duration", "6h");

function parseDuration(s: string): number {
  const num = parseFloat(s);
  if (s.endsWith("h")) return num * 3600_000;
  if (s.endsWith("m")) return num * 60_000;
  if (s.endsWith("s")) return num * 1000;
  return num * 3600_000; // default hours
}

const durationMs = parseDuration(durationStr);

// ── Setup ────────────────────────────────────────────────────────

const date = new Date().toISOString().split("T")[0];
const outDir = join(process.cwd(), "data", "capture", date);
mkdirSync(outDir, { recursive: true });

const bookFile = createWriteStream(join(outDir, "book.ndjson"), { flags: "a" });
const tradeFile = createWriteStream(join(outDir, "trades.ndjson"), { flags: "a" });

let bookSnapshots = 0;
let tradeCount = 0;
let running = true;

const startTime = Date.now();
const endTime = startTime + durationMs;

console.log(`
╔══════════════════════════════════════════════════════╗
║         Order Book Capture (Binance Free)            ║
╠══════════════════════════════════════════════════════╣
║  Symbols:   ${symbols.join(", ").padEnd(40)}║
║  Duration:  ${durationStr.padEnd(40)}║
║  Output:    data/capture/${date.padEnd(30)}║
║  Method:    REST polling (1/s) + WS trades           ║
╚══════════════════════════════════════════════════════╝

  Recording... (Ctrl+C to stop early)
`);

// ── Book polling (REST) ──────────────────────────────────────────

async function pollBook(sym: string): Promise<void> {
  const binanceSym = sym.replace("-", "").toUpperCase();

  while (running && Date.now() < endTime) {
    try {
      const res = await fetch(
        `https://api.binance.com/api/v3/depth?symbol=${binanceSym}&limit=20`,
      );

      if (res.ok) {
        const data = await res.json() as {
          lastUpdateId: number;
          bids: string[][];
          asks: string[][];
        };

        const snapshot = {
          type: "book_snapshot",
          ts: Date.now(),
          symbol: sym,
          seq: data.lastUpdateId,
          bids: data.bids.map(([p, q]) => [p, q]),
          asks: data.asks.map(([p, q]) => [p, q]),
        };

        bookFile.write(JSON.stringify(snapshot) + "\n");
        bookSnapshots++;
      }
    } catch {
      // Skip failed polls silently
    }

    // Wait 1 second between polls
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ── Trade streaming (WebSocket) ──────────────────────────────────

function startTradeStream(): WebSocket {
  const streams = symbols.map((s) => `${s.replace("-", "").toLowerCase()}@trade`);
  const url = `wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`;

  const ws = new WebSocket(url);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.stream && msg.data) {
        const d = msg.data;
        const trade = {
          type: "trade",
          ts: d.T,
          symbol: symbols.find((s) => s.replace("-", "").toLowerCase() === (d.s as string).toLowerCase()) ?? d.s,
          id: String(d.t),
          p: d.p,
          q: d.q,
          s: d.m ? "sell" : "buy",
          m: d.m,
        };
        tradeFile.write(JSON.stringify(trade) + "\n");
        tradeCount++;
      }
    } catch {}
  });

  ws.on("close", () => {
    if (running && Date.now() < endTime) {
      // Reconnect after 3s
      setTimeout(() => startTradeStream(), 3000);
    }
  });

  ws.on("error", () => {});

  return ws;
}

// ── Progress display ─────────────────────────────────────────────

const progressInterval = setInterval(() => {
  const elapsed = Date.now() - startTime;
  const remaining = Math.max(0, endTime - Date.now());
  const elapsedMin = (elapsed / 60000).toFixed(0);
  const remainingMin = (remaining / 60000).toFixed(0);

  process.stdout.write(
    `\r  📊 Book: ${bookSnapshots.toLocaleString()} snapshots | ` +
    `Trades: ${tradeCount.toLocaleString()} | ` +
    `${elapsedMin}m elapsed | ${remainingMin}m remaining   `,
  );
}, 5000);

// ── Start ────────────────────────────────────────────────────────

const ws = startTradeStream();

// Start polling for each symbol
const pollPromises = symbols.map((sym) => pollBook(sym));

// ── Shutdown ─────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  running = false;
  clearInterval(progressInterval);
  ws.close();
  bookFile.end();
  tradeFile.end();

  console.log(`\n
╔══════════════════════════════════════════════════════╗
║  ✅ Capture Complete                                 ║
╠══════════════════════════════════════════════════════╣
║  Book snapshots: ${bookSnapshots.toLocaleString().padEnd(34)}║
║  Trades:         ${tradeCount.toLocaleString().padEnd(34)}║
║  Duration:       ${((Date.now() - startTime) / 60000).toFixed(0).padEnd(31)}min ║
║  Output:         data/capture/${date.padEnd(21)}║
╚══════════════════════════════════════════════════════╝

  Next steps:
    npm run backtest:capture -- --date ${date}
`);

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Wait for duration or manual stop
await Promise.race([
  Promise.all(pollPromises),
  new Promise((r) => setTimeout(r, durationMs)),
]);

await shutdown();
