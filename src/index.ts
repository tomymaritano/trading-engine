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
import { DbStore } from "./storage/db-store.js";
import { RedisState } from "./storage/redis-state.js";
import { TerminalDashboard } from "./dashboard/terminal.js";
import { discoverSymbols } from "./ingestion/symbol-discovery.js";
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
  private dbStore: DbStore | null = null;
  private redisState: RedisState | null = null;
  private dashboard!: TerminalDashboard;

  constructor(private configOverrides?: Record<string, unknown>) {}

  async start(): Promise<void> {
    const config = loadConfig(this.configOverrides);
    const startTs = Date.now();

    // ── Discover symbols dynamically ─────────────────────────
    if (config.symbols.length === 0 || process.env.DISCOVER_SYMBOLS === "true") {
      const minVol = Number(process.env.MIN_VOLUME_24H) || 10_000_000;
      const maxSymbols = Number(process.env.MAX_SYMBOLS) || 50;
      const discovered = await discoverSymbols({
        minVolume24h: minVol,
        maxSymbols,
        ...(config.symbols.length > 0 && { alwaysInclude: config.symbols }),
      });
      (config as any).symbols = discovered;
    }

    log.info({ env: config.env, symbolCount: config.symbols.length, symbols: config.symbols }, "Starting Trading Intelligence Engine");

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
        const onEvent = (_event: MarketEvent) => {
          // Events are already emitted to the bus by the adapter
        };

        // Binance supports multi-connection splitting for many symbols
        const managers = "createWsManagers" in adapter
          ? (adapter as BinanceAdapter).createWsManagers(config.symbols, onEvent)
          : [adapter.createWsManager(config.symbols, onEvent)];

        for (const ws of managers) {
          this.wsManagers.push(ws);
          ws.start();
        }
        log.info({ exchange, connections: managers.length }, "WebSocket manager(s) started");
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

    // ── Tick Store (file-based, always on as fallback) ─────────
    this.tickStore = new TickStore("data/ticks");
    this.tickStore.start();
    bus.on("market:event", (event) => this.tickStore.append(event));

    // ── TimescaleDB (persistent storage) ─────────────────────
    const dbUrl = process.env.DB_URL ?? config.db.url;
    this.dbStore = new DbStore({ url: dbUrl });
    await this.dbStore.start();

    // ── Redis (real-time state) ──────────────────────────────
    const redisUrl = process.env.REDIS_URL ?? config.redis.url;
    this.redisState = new RedisState({ url: redisUrl });
    await this.redisState.start();

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
    await this.dbStore?.stop();
    await this.redisState?.stop();

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
        db: this.dbStore?.stats,
        redis: this.redisState?.stats,
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
  // Empty = discover all USDT pairs above MIN_VOLUME_24H from Binance API
  // Set DISCOVER_SYMBOLS=true to force discovery even with symbols listed
  symbols: [],
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
