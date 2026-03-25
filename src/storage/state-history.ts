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
const MAX_TRADE_HISTORY = 500;
const MAX_SIGNAL_HISTORY = 200;

let state: HistoricalState = {
  equityHistory: [],
  tradeHistory: [],
  signalHistory: [],
  sessionStart: Date.now(),
  totalTrades: 0,
  totalSignals: 0,
};

export function startStateHistory(): void {
  state.sessionStart = Date.now();

  // Track equity every 2 seconds
  setInterval(() => {
    // The WS server maintains equity — we read from the bus events
  }, 2000);

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
