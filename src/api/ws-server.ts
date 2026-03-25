import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";
import { metrics } from "../utils/metrics.js";
import { addEquityPoint } from "../storage/state-history.js";
import type { Trade } from "../types/market.js";
import type { FeatureVector, TradingSignal } from "../types/signals.js";

const log = createChildLogger("ws-server");

interface DashboardState {
  tickers: Record<string, { price: number; change: number; volume: number; trades: number }>;
  features: Record<string, Partial<FeatureVector>>;
  signals: TradingSignal[];
  risk: { equity: number; drawdown: number; dailyPnl: number; circuitBreaker: boolean; killSwitch: boolean };
  positions: Array<{ symbol: string; side: string; qty: number; pnl: number }>;
  connections: Record<string, boolean>;
  whaleEvents: Array<{ ts: number; symbol: string; type: string; side: string; notional: number }>;
  throughput: { trades: number; features: number; signals: number };
  uptime: number;
}

/**
 * WebSocket API server for the dashboard frontend.
 *
 * Broadcasts engine state to all connected clients every 500ms.
 * Also pushes individual events (trades, signals, whale alerts)
 * as they happen for real-time updates.
 *
 * Protocol:
 *   Server → Client: { type: "state", data: DashboardState }
 *   Server → Client: { type: "trade", data: Trade }
 *   Server → Client: { type: "signal", data: TradingSignal }
 *   Server → Client: { type: "whale", data: WhaleEvent }
 *   Client → Server: { type: "kill_switch" }  (emergency stop)
 */
export function startDashboardServer(port = 3001): void {
  const server = createServer((req, res) => {
    // CORS headers for Next.js dev server
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", clients: wss.clients.size }));
    } else if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(metrics.render());
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const wss = new WebSocketServer({ server });

  // ── State accumulator ──────────────────────────────────────────
  const state: DashboardState & { ai: Record<string, unknown> } = {
    tickers: {},
    features: {},
    signals: [],
    risk: { equity: 10000, drawdown: 0, dailyPnl: 0, circuitBreaker: false, killSwitch: false },
    positions: [],
    connections: {},
    whaleEvents: [],
    throughput: { trades: 0, features: 0, signals: 0 },
    uptime: Date.now(),
    ai: {
      sentimentEnabled: false,
      debateEnabled: false,
      lastSentiment: {} as Record<string, { score: number; source: string; ts: number }>,
      debateStats: { total: 0, bullWins: 0, bearWins: 0 },
    },
  };

  // Track recent trades for ticker
  const tradeVolumes = new Map<string, { volume: number; count: number; lastPrice: number; prevPrice: number }>();
  // Track open positions for PnL
  const positionTracker = new Map<string, { symbol: string; side: string; qty: number; entryPrice: number; pnl: number }>();
  let peakEquity = state.risk.equity;

  bus.on("market:trade", (trade: Trade) => {
    const sym = trade.symbol;
    const price = trade.price.toNumber();
    const qty = trade.qty.toNumber();

    const prev = tradeVolumes.get(sym) ?? { volume: 0, count: 0, lastPrice: price, prevPrice: price };
    prev.prevPrice = prev.lastPrice;
    prev.lastPrice = price;
    prev.volume += qty * price;
    prev.count++;
    tradeVolumes.set(sym, prev);

    state.tickers[sym] = {
      price,
      change: ((price - prev.prevPrice) / prev.prevPrice) * 100 || 0,
      volume: prev.volume,
      trades: prev.count,
    };

    state.throughput.trades++;

    // Mark-to-market: update unrealized PnL for open positions
    for (const [key, pos] of positionTracker) {
      if (pos.symbol === sym) {
        pos.pnl = pos.side === "long"
          ? (price - pos.entryPrice) * pos.qty
          : (pos.entryPrice - price) * pos.qty;
      }
    }

    // Update equity = initial + realized + unrealized
    const unrealizedPnl = [...positionTracker.values()].reduce((sum, p) => sum + p.pnl, 0);
    state.risk.equity = 10000 + state.risk.dailyPnl + unrealizedPnl;
    if (state.risk.equity > peakEquity) peakEquity = state.risk.equity;
    state.risk.drawdown = peakEquity > 0 ? Math.max(0, (peakEquity - state.risk.equity) / peakEquity) : 0;

    // Update positions for dashboard
    state.positions = [...positionTracker.values()].map((p) => ({
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      pnl: p.pnl,
    }));
  });

  bus.on("feature:vector", (f: FeatureVector) => {
    state.features[f.symbol] = {
      midPrice: f.midPrice,
      bookImbalanceTop5: f.bookImbalanceTop5,
      tradeImbalance: f.tradeImbalance,
      realizedVol: f.realizedVol,
      liquidityScore: f.liquidityScore,
      regime: f.regime,
      regimeConfidence: f.regimeConfidence,
      spreadVolatility: f.spreadVolatility,
      buyPressure: f.buyPressure,
      volumeAcceleration: f.volumeAcceleration,
    };
    state.throughput.features++;
  });

  bus.on("signal:new", (signal: TradingSignal) => {
    state.signals.unshift(signal);
    if (state.signals.length > 50) state.signals.pop();
    state.throughput.signals++;

    // Push signal immediately to clients
    broadcast(wss, { type: "signal", data: signal });
  });

  // Track LLM sentiment events
  bus.on("feature:anomaly", (anomaly) => {
    if (anomaly.type === "llm_sentiment") {
      const aiState = state.ai as any;
      aiState.sentimentEnabled = true;
      if (!aiState.lastSentiment) aiState.lastSentiment = {};
      aiState.lastSentiment[anomaly.symbol] = {
        score: anomaly.severity * (anomaly.details?.includes("bullish") ? 1 : -1),
        source: "claude",
        ts: Date.now(),
      };
    }
  });

  // Track debate results from signals
  bus.on("signal:new", (signal) => {
    if (signal.metadata?.debate) {
      const aiState = state.ai as any;
      aiState.debateEnabled = true;
      const debate = signal.metadata.debate as any;
      if (!aiState.debateStats) aiState.debateStats = { total: 0, bullWins: 0, bearWins: 0 };
      aiState.debateStats.total++;
      if (debate.winner === "bull") aiState.debateStats.bullWins++;
      if (debate.winner === "bear") aiState.debateStats.bearWins++;
    }
  });

  bus.on("feature:anomaly", (anomaly) => {
    if (anomaly.type.startsWith("whale_") && anomaly.severity > 0.4) { // filter low-quality events
      const event = {
        ts: Date.now(),
        symbol: anomaly.symbol,
        type: anomaly.type.replace("whale_", ""),
        side: "",
        notional: 0,
        details: anomaly.details,
      };
      state.whaleEvents.unshift(event);
      if (state.whaleEvents.length > 30) state.whaleEvents.pop();
      broadcast(wss, { type: "whale", data: event });
    }
  });

  bus.on("ws:connected", ({ exchange }) => { state.connections[exchange] = true; });
  bus.on("ws:disconnected", ({ exchange }) => { state.connections[exchange] = false; });
  bus.on("risk:circuit_breaker", () => { state.risk.circuitBreaker = true; });
  bus.on("risk:kill_switch", () => { state.risk.killSwitch = true; });

  bus.on("order:filled", (fill) => {
    // Track positions and PnL for dashboard
    const posKey = `${fill.exchange}:${fill.symbol}`;
    const existing = positionTracker.get(posKey);

    if (!existing) {
      positionTracker.set(posKey, {
        symbol: fill.symbol,
        side: fill.direction,
        qty: fill.fillQty,
        entryPrice: fill.fillPrice,
        pnl: 0,
      });
    } else if (existing.side !== fill.direction) {
      // Closing — compute PnL
      const pnl = existing.side === "long"
        ? (fill.fillPrice - existing.entryPrice) * Math.min(existing.qty, fill.fillQty)
        : (existing.entryPrice - fill.fillPrice) * Math.min(existing.qty, fill.fillQty);
      state.risk.equity += pnl;
      state.risk.dailyPnl += pnl;
      state.risk.drawdown = state.risk.equity < 10000
        ? (10000 - state.risk.equity) / 10000
        : 0;
      positionTracker.delete(posKey);
    }

    // Update positions array for dashboard
    state.positions = [...positionTracker.values()].map((p) => ({
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      pnl: p.pnl,
    }));

    broadcast(wss, { type: "fill", data: fill });
  });

  // ── Client handling ────────────────────────────────────────────
  wss.on("connection", (ws) => {
    log.info({ clients: wss.clients.size }, "Dashboard client connected");

    // Send current state immediately
    ws.send(JSON.stringify({ type: "state", data: state }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "kill_switch") {
          log.warn("Kill switch triggered from dashboard");
          bus.emit("risk:kill_switch", { reason: "Dashboard kill switch", ts: Date.now() });
        }
      } catch {}
    });

    ws.on("close", () => {
      log.info({ clients: wss.clients.size }, "Dashboard client disconnected");
    });
  });

  // ── Broadcast state every 500ms + track equity ─────────────────
  let lastEquityTrack = 0;
  setInterval(() => {
    broadcast(wss, { type: "state", data: state });

    // Track equity every 5s for history
    if (Date.now() - lastEquityTrack > 5000) {
      addEquityPoint(state.risk.equity);
      lastEquityTrack = Date.now();
    }
  }, 500);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.warn({ port }, "Dashboard WS port in use, skipping");
    } else {
      log.error({ err }, "Dashboard server error");
    }
  });

  // Catch WSS errors too (propagated from server)
  wss.on("error", (err: Error) => {
    log.warn({ err: err.message }, "WebSocket server error (non-fatal)");
  });

  server.listen(port, () => {
    log.info({ port }, "Dashboard WebSocket server started");
  });
}

function broadcast(wss: WebSocketServer, data: unknown): void {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}
