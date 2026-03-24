import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { bus } from "./event-bus.js";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("metrics");

/**
 * Lightweight Prometheus-compatible metrics exporter.
 *
 * Exposes /metrics endpoint in Prometheus text format.
 * No dependencies — raw HTTP server + text format.
 *
 * Collected metrics:
 * - trade_events_total (counter, by exchange+symbol)
 * - signal_events_total (counter, by strategy+direction)
 * - order_events_total (counter, by status)
 * - book_imbalance (gauge, by symbol)
 * - realized_vol (gauge, by symbol)
 * - portfolio_equity (gauge)
 * - portfolio_drawdown (gauge)
 * - ws_connected (gauge, by exchange)
 * - feature_latency_ms (histogram)
 */

interface Counter {
  value: number;
  labels: Record<string, string>;
}

interface Gauge {
  value: number;
  labels: Record<string, string>;
}

class MetricsCollector {
  private counters = new Map<string, Counter[]>();
  private gauges = new Map<string, Gauge[]>();

  incCounter(name: string, labels: Record<string, string> = {}, delta = 1): void {
    const key = this.labelKey(labels);
    let arr = this.counters.get(name);
    if (!arr) {
      arr = [];
      this.counters.set(name, arr);
    }
    const existing = arr.find((c) => this.labelKey(c.labels) === key);
    if (existing) {
      existing.value += delta;
    } else {
      arr.push({ value: delta, labels });
    }
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.labelKey(labels);
    let arr = this.gauges.get(name);
    if (!arr) {
      arr = [];
      this.gauges.set(name, arr);
    }
    const existing = arr.find((g) => this.labelKey(g.labels) === key);
    if (existing) {
      existing.value = value;
    } else {
      arr.push({ value, labels });
    }
  }

  /** Render all metrics in Prometheus text exposition format */
  render(): string {
    const lines: string[] = [];

    for (const [name, entries] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const entry of entries) {
        lines.push(`${name}${this.formatLabels(entry.labels)} ${entry.value}`);
      }
    }

    for (const [name, entries] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const entry of entries) {
        lines.push(`${name}${this.formatLabels(entry.labels)} ${entry.value}`);
      }
    }

    return lines.join("\n") + "\n";
  }

  private labelKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
  }

  private formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return "";
    return `{${entries.map(([k, v]) => `${k}="${v}"`).join(",")}}`;
  }
}

export const metrics = new MetricsCollector();

/**
 * Wire up bus events to metrics collection.
 */
export function startMetricsCollection(): void {
  bus.on("market:trade", (trade) => {
    metrics.incCounter("trade_events_total", {
      exchange: trade.exchange,
      symbol: trade.symbol,
    });
  });

  bus.on("signal:new", (signal) => {
    metrics.incCounter("signal_events_total", {
      strategy: signal.strategy,
      direction: signal.direction,
      symbol: signal.symbol,
    });
  });

  bus.on("order:filled", () => {
    metrics.incCounter("order_events_total", { status: "filled" });
  });

  bus.on("order:rejected", () => {
    metrics.incCounter("order_events_total", { status: "rejected" });
  });

  bus.on("order:cancelled", () => {
    metrics.incCounter("order_events_total", { status: "cancelled" });
  });

  bus.on("feature:vector", (f) => {
    metrics.setGauge("book_imbalance_top5", f.bookImbalanceTop5, { symbol: f.symbol });
    metrics.setGauge("realized_vol", f.realizedVol, { symbol: f.symbol });
    metrics.setGauge("liquidity_score", f.liquidityScore, { symbol: f.symbol });
    metrics.setGauge("mid_price", f.midPrice, { symbol: f.symbol });
  });

  bus.on("ws:connected", ({ exchange }) => {
    metrics.setGauge("ws_connected", 1, { exchange });
  });

  bus.on("ws:disconnected", ({ exchange }) => {
    metrics.setGauge("ws_connected", 0, { exchange });
  });

  bus.on("risk:circuit_breaker", () => {
    metrics.incCounter("risk_events_total", { type: "circuit_breaker" });
  });

  bus.on("risk:kill_switch", () => {
    metrics.incCounter("risk_events_total", { type: "kill_switch" });
  });
}

/**
 * Start HTTP server that serves /metrics for Prometheus scraping.
 */
export function startMetricsServer(port = 9090): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(metrics.render());
    } else if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.warn({ port }, "Metrics port in use, skipping");
    } else {
      log.error({ err }, "Metrics server error");
    }
  });

  server.listen(port, () => {
    log.info({ port }, "Metrics server started on /metrics");
  });
}
