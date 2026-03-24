#!/usr/bin/env tsx
/**
 * Live Paper Trading Mode
 *
 * Connects to exchange WebSockets (public, no API key needed),
 * computes features in real time, generates signals, and executes
 * paper trades. Runs indefinitely until Ctrl+C.
 *
 * Usage:
 *   npm run live
 *   npm run live -- --exchanges binance,okx --symbols BTC-USDT,ETH-USDT,SOL-USDT
 *   npm run live -- --no-dashboard
 *   npm run live -- --metrics-port 9090
 *
 * What happens:
 *   1. WebSocket connections to exchanges (public streams, no auth)
 *   2. Order book maintained locally from delta updates
 *   3. Feature engine computes 30+ features every second
 *   4. Strategies evaluate features and emit signals
 *   5. Risk engine gates signals → position sizing
 *   6. Execution engine simulates fills (paper mode)
 *   7. All market events persisted to data/ticks/ for future backtesting
 *   8. Terminal dashboard shows real-time state
 *   9. Prometheus metrics on :9090
 *
 * This is the "always running" mode. Leave it on and it:
 *   - Builds up historical data automatically
 *   - Tests strategies against live data
 *   - Trains your intuition about signal quality
 *   - Validates that the engine handles reconnections, gaps, etc.
 */

import { loadConfig } from "./config/index.js";
import { bus } from "./utils/event-bus.js";
import { createChildLogger } from "./utils/logger.js";
import { BinanceAdapter } from "./adapters/binance.js";
import { BinanceFuturesAdapter } from "./adapters/binance-futures.js";
import { KrakenAdapter } from "./adapters/kraken.js";
import { OkxAdapter } from "./adapters/okx.js";
import { orderBookManager } from "./stream/order-book-manager.js";
import { FeatureEngine } from "./features/feature-engine.js";
import { SentimentEngine } from "./features/sentiment.js";
import { CrossExchangeEngine } from "./features/cross-exchange.js";
import { WhaleDetector } from "./features/whale-detector.js";
import { StrategyOrchestrator } from "./models/strategy-orchestrator.js";
import { MLBridge } from "./models/ml-bridge.js";
import { RiskEngine } from "./risk/risk-engine.js";
import { ExecutionEngine } from "./execution/execution-engine.js";
import { PortfolioManager } from "./portfolio/portfolio-manager.js";
import { TickStore } from "./storage/tick-store.js";
import { TerminalDashboard } from "./dashboard/terminal.js";
import { startMetricsCollection, startMetricsServer } from "./utils/metrics.js";
import { startDashboardServer } from "./api/ws-server.js";
import { startControlApi } from "./api/control-api.js";
import { TrailingStopManager } from "./execution/trailing-stop.js";
import { TradeJournal } from "./audit/trade-journal.js";
import { TelegramAlerts } from "./alerts/telegram.js";
import type { WsManager } from "./ingestion/ws-manager.js";
import type { Exchange, MarketEvent } from "./types/market.js";

const log = createChildLogger("live");

// ── Parse CLI args ────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const exchangeList = getArg("exchanges", "binance").split(",") as Exchange[];
const symbolList = getArg("symbols", "BTC-USDT,ETH-USDT").split(",");
const showDashboard = !args.includes("--no-dashboard");
const useFutures = args.includes("--futures");
const metricsPort = Number(getArg("metrics-port", "9090"));
const initialEquity = Number(getArg("equity", "10000"));
const mlUrl = getArg("ml-url", "http://localhost:8000");

// ── Boot ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTs = Date.now();

  if (!showDashboard) {
    console.log(`
╔══════════════════════════════════════════════════════╗
║          Live Paper Trading                          ║
╠══════════════════════════════════════════════════════╣
║  Exchanges:  ${exchangeList.join(", ").padEnd(39)}║
║  Symbols:    ${symbolList.join(", ").padEnd(39)}║
║  Mode:       ${(useFutures ? "FUTURES" : "SPOT").padEnd(39)}║
║  Equity:     $${initialEquity.toLocaleString().padEnd(38)}║
║  Metrics:    :${String(metricsPort).padEnd(38)}║
╚══════════════════════════════════════════════════════╝
`);
  }

  const config = loadConfig({
    env: "development",
    symbols: symbolList,
    exchanges: {
      binance: { enabled: exchangeList.includes("binance") },
      kraken: { enabled: exchangeList.includes("kraken") },
      okx: { enabled: exchangeList.includes("okx") },
    },
  } as any);

  // ── WebSocket adapters ──────────────────────────────────────────
  const adapters = {
    binance: useFutures ? new BinanceFuturesAdapter() : new BinanceAdapter(),
    kraken: new KrakenAdapter(),
    okx: new OkxAdapter(),
  };

  if (useFutures) {
    log.info("Using Binance USD-M Futures (lower fees, liquidation data, funding rates)");
  }

  const wsManagers: WsManager[] = [];

  for (const exchange of exchangeList) {
    const adapter = adapters[exchange];
    if (!adapter) {
      log.warn({ exchange }, "Unknown exchange, skipping");
      continue;
    }

    const ws = adapter.createWsManager(symbolList, (_event: MarketEvent) => {
      // Events already emitted to bus by adapter
    });

    wsManagers.push(ws);
    ws.start();
    log.info({ exchange, symbols: symbolList }, "WebSocket started");
  }

  // ── Tick Store (persist everything for future backtesting) ──────
  const tickStore = new TickStore("data/ticks");
  tickStore.start();

  let tickCount = 0;
  bus.on("market:event", (event) => {
    tickStore.append(event);
    tickCount++;
  });

  // ── Feature Engine ──────────────────────────────────────────────
  const featureEngine = new FeatureEngine(config, symbolList, exchangeList);
  featureEngine.start();

  // ── Sentiment Engine ────────────────────────────────────────────
  const sentimentEngine = new SentimentEngine(symbolList);
  sentimentEngine.start();

  // ── Cross-Exchange Analysis ──────────────────────────────────────
  const crossExchange = new CrossExchangeEngine(symbolList, exchangeList);
  crossExchange.start();

  // ── Whale Detector ─────────────────────────────────────────────
  const whaleDetector = new WhaleDetector(symbolList);
  whaleDetector.start();

  // ── ML Bridge (optional — connects if service is running) ──────
  const mlBridge = new MLBridge(mlUrl);
  await mlBridge.start();
  if (mlBridge.isAvailable) {
    log.info("ML prediction service connected");
  } else {
    log.info("ML service not available — running without ML predictions");
  }

  // ── Strategy Orchestrator ───────────────────────────────────────
  const strategyOrchestrator = new StrategyOrchestrator(config);
  strategyOrchestrator.start();

  // ── Risk Engine ─────────────────────────────────────────────────
  const riskEngine = new RiskEngine(config, initialEquity);
  riskEngine.start();

  // ── Execution Engine (paper mode) ──────────────────────────────
  const executionEngine = new ExecutionEngine(config);
  executionEngine.start();

  // ── Portfolio Manager ───────────────────────────────────────────
  const portfolioManager = new PortfolioManager(initialEquity);
  portfolioManager.start();

  // ── Trailing Stops ─────────────────────────────────────────────
  const trailingStopManager = new TrailingStopManager(0.01, 0.005); // 1% trail, 0.5% activation
  trailingStopManager.start();

  // ── Telegram Alerts ────────────────────────────────────────────
  const telegramAlerts = new TelegramAlerts();
  telegramAlerts.start();

  // ── Trade Journal (audit trail) ───────────────────────────────
  const tradeJournal = new TradeJournal("data/journal");
  tradeJournal.start();

  // ── Metrics (Prometheus) ────────────────────────────────────────
  startMetricsCollection();
  startMetricsServer(metricsPort);

  // ── Dashboard WebSocket Server ──────────────────────────────────
  startDashboardServer(3001);

  // ── Control API (REST for dashboard) ──────────────────────────
  let activeRiskProfile = "moderate";
  let activeSignalProfile = "balanced";

  startControlApi(3002, {
    getStatus: () => ({
      uptime: Date.now() - startTs,
      ticks: tickCount,
      equity: portfolioManager.equityValue(),
      positions: portfolioManager.snapshot().positionCount,
      signals: strategyOrchestrator.stats.signalCount,
      trades: executionEngine.stats.filled,
      riskProfile: activeRiskProfile,
      signalProfile: activeSignalProfile,
      connections: Object.fromEntries(wsManagers.map((ws) => [ws.stats.exchange, ws.stats.connected])),
    }),
    setRiskProfile: (name) => { activeRiskProfile = name; },
    setSignalProfile: (name) => { activeSignalProfile = name; },
    toggleStrategy: (name, enabled) => strategyOrchestrator.toggleStrategy(name, enabled),
    getStrategies: () => strategyOrchestrator.getStrategies(),
    getJournal: (limit) => tradeJournal.getRecent?.(limit) ?? [],
    getActiveSymbols: () => symbolList,
  });

  // ── Terminal Dashboard ──────────────────────────────────────────
  let dashboard: TerminalDashboard | null = null;
  if (showDashboard && process.stdout.isTTY) {
    dashboard = new TerminalDashboard();
    dashboard.start();
  }

  // ── Periodic stats (when dashboard is off) ──────────────────────
  if (!showDashboard) {
    setInterval(() => {
      const snap = portfolioManager.snapshot();
      log.info({
        ticks: tickCount,
        equity: snap.equity.toNumber(),
        positions: snap.positionCount,
        signals: strategyOrchestrator.stats.signalCount,
        trades: executionEngine.stats.filled,
        ws: wsManagers.map((ws) => ws.stats),
      }, "Status");
    }, 30_000);
  }

  // ── Lifecycle ───────────────────────────────────────────────────
  bus.on("risk:kill_switch", ({ reason }) => {
    log.error({ reason }, "Kill switch — shutting down");
    shutdown();
  });

  bus.emit("system:ready");
  log.info({ startupMs: Date.now() - startTs }, "Live engine ready");

  // ── Graceful shutdown ───────────────────────────────────────────
  async function shutdown(): Promise<void> {
    log.info("Shutting down...");
    dashboard?.stop();
    tradeJournal.stop();
    executionEngine.stop();
    featureEngine.stop();
    sentimentEngine.stop();
    mlBridge.stop();
    await tickStore.stop();
    for (const ws of wsManagers) await ws.stop();
    log.info({ totalTicks: tickCount }, "Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error");
  process.exit(1);
});
