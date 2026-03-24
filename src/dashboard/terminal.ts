import { bus } from "../utils/event-bus.js";
import type { Trade } from "../types/market.js";
import type { FeatureVector, TradingSignal } from "../types/signals.js";

/**
 * Terminal Dashboard — real-time monitoring in the console.
 *
 * Renders a compact view of system state using ANSI escape codes.
 * Refreshes every 500ms. Shows:
 * - Price tickers with change indicators
 * - Order book imbalance bars
 * - Active signals
 * - Risk status
 * - Event throughput
 *
 * For production, replace with Grafana dashboards connected
 * via Prometheus metrics. This is for development ergonomics.
 */

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;
const WHITE = `${ESC}[37m`;
const BG_DARK = `${ESC}[40m`;

interface TickerState {
  symbol: string;
  lastPrice: number;
  prevPrice: number;
  volume24h: number;
  tradeCount: number;
  lastTradeTs: number;
}

interface DashboardState {
  tickers: Map<string, TickerState>;
  lastFeatures: Map<string, FeatureVector>;
  recentSignals: TradingSignal[];
  riskStatus: {
    equity: number;
    drawdown: number;
    dailyPnl: number;
    circuitBreaker: boolean;
    killSwitch: boolean;
  };
  wsConnections: Map<string, boolean>;
  startTs: number;
}

export class TerminalDashboard {
  private state: DashboardState;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly refreshMs = 500;

  constructor() {
    this.state = {
      tickers: new Map(),
      lastFeatures: new Map(),
      recentSignals: [],
      riskStatus: {
        equity: 10_000,
        drawdown: 0,
        dailyPnl: 0,
        circuitBreaker: false,
        killSwitch: false,
      },
      wsConnections: new Map(),
      startTs: Date.now(),
    };
  }

  start(): void {
    // Subscribe to events
    bus.on("market:trade", (trade) => this.onTrade(trade));
    bus.on("feature:vector", (f) => this.state.lastFeatures.set(f.symbol, f));
    bus.on("signal:new", (s) => {
      this.state.recentSignals.unshift(s);
      if (this.state.recentSignals.length > 10) this.state.recentSignals.pop();
    });
    bus.on("ws:connected", ({ exchange }) => this.state.wsConnections.set(exchange, true));
    bus.on("ws:disconnected", ({ exchange }) => this.state.wsConnections.set(exchange, false));
    bus.on("risk:circuit_breaker", () => { this.state.riskStatus.circuitBreaker = true; });
    bus.on("risk:kill_switch", () => { this.state.riskStatus.killSwitch = true; });

    // Start render loop
    this.interval = setInterval(() => this.render(), this.refreshMs);

    // Hide cursor
    process.stdout.write(`${ESC}[?25l`);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    // Show cursor, clear screen
    process.stdout.write(`${ESC}[?25h`);
  }

  private onTrade(trade: Trade): void {
    const key = `${trade.exchange}:${trade.symbol}`;
    const existing = this.state.tickers.get(key);
    const price = trade.price.toNumber();

    if (existing) {
      existing.prevPrice = existing.lastPrice;
      existing.lastPrice = price;
      existing.tradeCount++;
      existing.lastTradeTs = trade.ts;
    } else {
      this.state.tickers.set(key, {
        symbol: `${trade.exchange}:${trade.symbol}`,
        lastPrice: price,
        prevPrice: price,
        volume24h: 0,
        tradeCount: 1,
        lastTradeTs: trade.ts,
      });
    }
  }

  private render(): void {
    const lines: string[] = [];
    const width = Math.min(process.stdout.columns || 80, 100);

    // Move cursor to top
    process.stdout.write(`${ESC}[H${ESC}[J`);

    // Header
    const uptime = this.formatUptime(Date.now() - this.state.startTs);
    lines.push(`${BOLD}${CYAN} ⚡ TRADING ENGINE ${RESET}${DIM} │ uptime: ${uptime} │ ${new Date().toISOString().split("T")[1].slice(0, 8)} UTC${RESET}`);
    lines.push(`${DIM}${"─".repeat(width)}${RESET}`);

    // Connections
    const connParts: string[] = [];
    for (const [exchange, connected] of this.state.wsConnections) {
      const icon = connected ? `${GREEN}●${RESET}` : `${RED}●${RESET}`;
      connParts.push(`${icon} ${exchange}`);
    }
    if (connParts.length > 0) {
      lines.push(` ${DIM}WS:${RESET} ${connParts.join("  ")}`);
    }

    // Tickers
    lines.push("");
    lines.push(`${BOLD} TICKERS${RESET}`);
    for (const [, ticker] of this.state.tickers) {
      const change = ticker.lastPrice - ticker.prevPrice;
      const changeIcon = change > 0 ? `${GREEN}▲${RESET}` : change < 0 ? `${RED}▼${RESET}` : `${DIM}─${RESET}`;
      const priceColor = change > 0 ? GREEN : change < 0 ? RED : WHITE;
      lines.push(
        ` ${DIM}${ticker.symbol.padEnd(20)}${RESET}` +
        `${priceColor}${BOLD}${ticker.lastPrice.toFixed(2).padStart(12)}${RESET} ` +
        `${changeIcon} ` +
        `${DIM}trades: ${ticker.tradeCount}${RESET}`,
      );
    }

    // Features
    lines.push("");
    lines.push(`${BOLD} MICROSTRUCTURE${RESET}`);
    for (const [symbol, f] of this.state.lastFeatures) {
      const imbalance = f.bookImbalanceTop5;
      const imbalanceBar = this.renderBar(imbalance, -1, 1, 20);
      const regimeColor = f.regime.includes("trend") ? YELLOW
        : f.regime === "volatile" ? RED
        : f.regime === "low_vol" ? DIM
        : CYAN;

      lines.push(
        ` ${DIM}${symbol.padEnd(12)}${RESET}` +
        ` imb: ${imbalanceBar} ` +
        `vol: ${(f.realizedVol * 100).toFixed(1).padStart(5)}% ` +
        `liq: ${f.liquidityScore.toFixed(2)} ` +
        `${regimeColor}${f.regime}${RESET}`,
      );
    }

    // Signals
    lines.push("");
    lines.push(`${BOLD} SIGNALS${RESET}`);
    if (this.state.recentSignals.length === 0) {
      lines.push(`  ${DIM}No signals yet${RESET}`);
    } else {
      for (const signal of this.state.recentSignals.slice(0, 5)) {
        const dirColor = signal.direction === "long" ? GREEN : signal.direction === "short" ? RED : DIM;
        const age = ((Date.now() - signal.ts) / 1000).toFixed(0);
        lines.push(
          `  ${dirColor}${signal.direction.toUpperCase().padEnd(6)}${RESET}` +
          ` ${signal.symbol.padEnd(10)}` +
          ` conf: ${(signal.confidence * 100).toFixed(0).padStart(3)}%` +
          ` ${DIM}${signal.strategy}${RESET}` +
          ` ${DIM}${age}s ago${RESET}`,
        );
      }
    }

    // Risk
    lines.push("");
    lines.push(`${BOLD} RISK${RESET}`);
    const risk = this.state.riskStatus;
    const ddColor = risk.drawdown > 0.03 ? RED : risk.drawdown > 0.01 ? YELLOW : GREEN;
    const statusIcon = risk.killSwitch ? `${RED}☠ KILL${RESET}`
      : risk.circuitBreaker ? `${YELLOW}⚠ BREAKER${RESET}`
      : `${GREEN}● OK${RESET}`;

    lines.push(
      `  equity: $${risk.equity.toLocaleString()}` +
      `  ${ddColor}dd: ${(risk.drawdown * 100).toFixed(2)}%${RESET}` +
      `  daily: ${risk.dailyPnl >= 0 ? GREEN : RED}$${risk.dailyPnl.toFixed(2)}${RESET}` +
      `  status: ${statusIcon}`,
    );

    // Event throughput
    lines.push("");
    const stats = bus.stats();
    const tradeRate = bus.throughput("market:trade");
    const featureRate = bus.throughput("feature:vector");
    const signalRate = bus.throughput("signal:new");
    lines.push(
      `${DIM} ⚡ trades/s: ${tradeRate.toFixed(0)}` +
      `  features/s: ${featureRate.toFixed(0)}` +
      `  signals/s: ${signalRate.toFixed(2)}` +
      `  total events: ${Object.values(stats).reduce((a, b) => a + b, 0).toLocaleString()}${RESET}`,
    );

    // Footer
    lines.push(`${DIM}${"─".repeat(width)}${RESET}`);
    lines.push(`${DIM} Ctrl+C to stop${RESET}`);

    process.stdout.write(lines.join("\n") + "\n");
  }

  private renderBar(value: number, min: number, max: number, width: number): string {
    const normalized = (value - min) / (max - min); // 0 to 1
    const midPoint = Math.floor(width / 2);
    const pos = Math.round(normalized * width);

    let bar = "";
    for (let i = 0; i < width; i++) {
      if (i === midPoint) {
        bar += `${DIM}│${RESET}`;
      } else if (pos > midPoint && i >= midPoint && i < pos) {
        bar += `${GREEN}█${RESET}`;
      } else if (pos < midPoint && i >= pos && i < midPoint) {
        bar += `${RED}█${RESET}`;
      } else {
        bar += `${DIM}·${RESET}`;
      }
    }
    return `[${bar}]`;
  }

  private formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ${s % 60}s`;
  }
}
