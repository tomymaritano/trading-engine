import { loadConfig } from "./config/index.js";
import { bus } from "./utils/event-bus.js";
import { createChildLogger } from "./utils/logger.js";
import { BinanceAdapter } from "./adapters/binance.js";
import { KrakenAdapter } from "./adapters/kraken.js";
import { OkxAdapter } from "./adapters/okx.js";
import { orderBookManager } from "./stream/order-book-manager.js";
import { FeatureEngine } from "./features/feature-engine.js";
import { StrategyOrchestrator } from "./models/strategy-orchestrator.js";
import { RiskEngine } from "./risk/risk-engine.js";
import { ExecutionEngine } from "./execution/execution-engine.js";
import { PortfolioManager } from "./portfolio/portfolio-manager.js";
import { TickStore } from "./storage/tick-store.js";
import { TerminalDashboard } from "./dashboard/terminal.js";
import type { WsManager } from "./ingestion/ws-manager.js";
import type { Exchange, MarketEvent } from "./types/market.js";

const log = createChildLogger("main");

/**
 * Trading Intelligence Engine — main orchestrator.
 *
 * Startup sequence:
 * 1. Load config
 * 2. Initialize all layers
 * 3. Connect WebSockets to exchanges
 * 4. Begin feature computation
 * 5. Activate strategies
 * 6. Risk engine gates all signals
 * 7. Execution engine processes approved orders
 *
 * Data flow:
 * Exchange WS → Adapter → EventBus → OrderBookManager → FeatureEngine
 *   → StrategyOrchestrator → RiskEngine → ExecutionEngine → Exchange API
 */
class TradingEngine {
  private wsManagers: WsManager[] = [];
  private featureEngine!: FeatureEngine;
  private strategyOrchestrator!: StrategyOrchestrator;
  private riskEngine!: RiskEngine;
  private executionEngine!: ExecutionEngine;
  private portfolioManager!: PortfolioManager;
  private tickStore!: TickStore;
  private dashboard!: TerminalDashboard;

  constructor(private configOverrides?: Record<string, unknown>) {}

  async start(): Promise<void> {
    const config = loadConfig(this.configOverrides);
    const startTs = Date.now();

    log.info({ env: config.env, symbols: config.symbols }, "Starting Trading Intelligence Engine");

    // ── Initialize layers ──────────────────────────────────────
    const exchanges: Exchange[] = [];
    const adapters = {
      binance: new BinanceAdapter(),
      kraken: new KrakenAdapter(),
      okx: new OkxAdapter(),
    };

    // ── Connect enabled exchanges ──────────────────────────────
    for (const [name, exchangeConfig] of Object.entries(config.exchanges)) {
      if (exchangeConfig.enabled) {
        const exchange = name as Exchange;
        exchanges.push(exchange);
        const adapter = adapters[exchange];

        const ws = adapter.createWsManager(config.symbols, (event: MarketEvent) => {
          // Events are already emitted to the bus by the adapter
        });

        this.wsManagers.push(ws);
        ws.start();
        log.info({ exchange }, "WebSocket manager started");
      }
    }

    if (exchanges.length === 0) {
      log.warn("No exchanges enabled — running in offline/backtest mode");
      exchanges.push("binance"); // Default for feature engine initialization
    }

    // ── Feature Engine ─────────────────────────────────────────
    this.featureEngine = new FeatureEngine(config, config.symbols, exchanges);
    this.featureEngine.start();

    // ── Strategy Orchestrator ──────────────────────────────────
    this.strategyOrchestrator = new StrategyOrchestrator(config);
    this.strategyOrchestrator.start();

    // ── Risk Engine ────────────────────────────────────────────
    const initialEquity = 10_000; // Default paper trading equity
    this.riskEngine = new RiskEngine(config, initialEquity);
    this.riskEngine.start();

    // ── Execution Engine ───────────────────────────────────────
    this.executionEngine = new ExecutionEngine(config);
    this.executionEngine.start();

    // ── Portfolio Manager ──────────────────────────────────────
    this.portfolioManager = new PortfolioManager(initialEquity);
    this.portfolioManager.start();

    // ── Tick Store (persist all market events) ─────────────────
    this.tickStore = new TickStore("data/ticks");
    this.tickStore.start();
    bus.on("market:event", (event) => this.tickStore.append(event));

    // ── Terminal Dashboard ──────────────────────────────────────
    if (process.stdout.isTTY && config.env !== "production") {
      this.dashboard = new TerminalDashboard();
      this.dashboard.start();
    }

    // ── Monitoring ──────────────────────────────────────────────
    this.startMonitoring();

    // ── Lifecycle events ───────────────────────────────────────
    bus.on("risk:kill_switch", ({ reason }) => {
      log.error({ reason }, "Kill switch triggered — initiating shutdown");
      this.stop();
    });

    bus.on("system:error", (err) => {
      log.error({ err }, "System error");
    });

    bus.emit("system:ready");
    log.info({ startupMs: Date.now() - startTs }, "Trading engine ready");
  }

  async stop(): Promise<void> {
    log.info("Shutting down...");
    bus.emit("system:shutdown", "manual");

    this.dashboard?.stop();
    this.executionEngine?.stop();
    this.featureEngine?.stop();
    await this.tickStore?.stop();

    for (const ws of this.wsManagers) {
      await ws.stop();
    }

    log.info("Shutdown complete");
  }

  private startMonitoring(): void {
    // Log stats every 30 seconds
    setInterval(() => {
      log.info({
        eventBus: bus.stats(),
        strategies: this.strategyOrchestrator?.stats,
        risk: this.riskEngine?.stats,
        execution: this.executionEngine?.stats,
        wsConnections: this.wsManagers.map((ws) => ws.stats),
      }, "Engine stats");
    }, 30_000);
  }
}

// ── Entry point ──────────────────────────────────────────────────
const engine = new TradingEngine({
  env: process.env.NODE_ENV ?? "development",
  exchanges: {
    binance: { enabled: true },
    kraken: { enabled: false },
    okx: { enabled: false },
  },
  symbols: ["BTC-USDT", "ETH-USDT"],
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await engine.stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await engine.stop();
  process.exit(0);
});

engine.start().catch((err) => {
  log.fatal({ err }, "Fatal startup error");
  process.exit(1);
});

export { TradingEngine };
