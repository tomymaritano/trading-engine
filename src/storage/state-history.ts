import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("state-history");

/**
 * State History — accumulates data for the dashboard.
 *
 * When the frontend connects (or reloads), it fetches this
 * to restore the full state without starting from zero.
 *
 * Kept in memory (not disk) — resets when engine restarts.
 * The journal on disk is the permanent record.
 */

interface HistoricalState {
  equityHistory: { ts: number; equity: number }[];
  priceHistory: Record<string, { ts: number; price: number }[]>;
  tradeHistory: Array<{
    ts: number;
    symbol: string;
    direction: string;
    fillPrice: number;
    fillQty: number;
    slippageBps: number;
  }>;
  signalHistory: Array<{
    ts: number;
    symbol: string;
    direction: string;
    confidence: number;
    strategy: string;
  }>;
  sessionStart: number;
  totalTrades: number;
  totalSignals: number;
}

const MAX_EQUITY_POINTS = 2000;
const MAX_PRICE_POINTS = 2000;
const MAX_TRADE_HISTORY = 500;
const MAX_SIGNAL_HISTORY = 200;

const STATE_FILE = "data/state-history.json";

let state: HistoricalState = {
  equityHistory: [],
  priceHistory: {},
  tradeHistory: [],
  signalHistory: [],
  sessionStart: Date.now(),
  totalTrades: 0,
  totalSignals: 0,
};

/** Load state from disk on startup */
function loadState(): void {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const saved = JSON.parse(raw) as HistoricalState;
      state.equityHistory = saved.equityHistory ?? [];
      state.priceHistory = saved.priceHistory ?? {};
      state.tradeHistory = saved.tradeHistory ?? [];
      state.signalHistory = saved.signalHistory ?? [];
      state.totalTrades = saved.totalTrades ?? 0;
      state.totalSignals = saved.totalSignals ?? 0;
      log.info({
        equityPoints: state.equityHistory.length,
        symbols: Object.keys(state.priceHistory).length,
        trades: state.tradeHistory.length,
      }, "State history restored from disk");
    }
  } catch (err) {
    log.warn({ err }, "Failed to load state history");
  }
}

/** Save state to disk */
function saveState(): void {
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

export function startStateHistory(): void {
  loadState();
  state.sessionStart = Date.now();

  // Save to disk every 30 seconds
  setInterval(saveState, 30_000);

  // Track prices from trades (every 5s per symbol)
  const lastPriceTs: Record<string, number> = {};
  bus.on("market:trade", (trade) => {
    const sym = trade.symbol;
    const now = Date.now();
    if (lastPriceTs[sym] && now - lastPriceTs[sym] < 5000) return; // throttle 5s
    lastPriceTs[sym] = now;

    if (!state.priceHistory[sym]) state.priceHistory[sym] = [];
    state.priceHistory[sym].push({ ts: now, price: trade.price.toNumber() });
    if (state.priceHistory[sym].length > MAX_PRICE_POINTS) {
      state.priceHistory[sym].shift();
    }
  });

  // Track fills
  bus.on("order:filled", (fill) => {
    state.tradeHistory.push({
      ts: Date.now(),
      symbol: fill.symbol ?? "",
      direction: fill.direction ?? "",
      fillPrice: fill.fillPrice,
      fillQty: fill.fillQty,
      slippageBps: fill.slippageBps,
    });
    state.totalTrades++;
    if (state.tradeHistory.length > MAX_TRADE_HISTORY) {
      state.tradeHistory.shift();
    }
  });

  // Track signals
  bus.on("signal:new", (signal) => {
    state.signalHistory.push({
      ts: signal.ts,
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence,
      strategy: signal.strategy,
    });
    state.totalSignals++;
    if (state.signalHistory.length > MAX_SIGNAL_HISTORY) {
      state.signalHistory.shift();
    }
  });

  log.info("State history tracking started");
}

/** Add equity point (called from WS server) */
export function addEquityPoint(equity: number): void {
  state.equityHistory.push({ ts: Date.now(), equity });
  if (state.equityHistory.length > MAX_EQUITY_POINTS) {
    state.equityHistory.shift();
  }
}

/** Get full state for dashboard restore */
export function getStateHistory(): HistoricalState {
  return { ...state };
}
