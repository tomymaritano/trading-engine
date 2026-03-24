import { createWriteStream, mkdirSync, WriteStream } from "node:fs";
import { join } from "node:path";
import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("trade-journal");

interface JournalEntry {
  ts: number;
  type: string;
  data: unknown;
}

/**
 * Trade Journal — Immutable Audit Trail (pattern: StockSharp)
 *
 * Records every decision and event as an append-only log.
 * Each entry is a JSON line with timestamp, type, and data.
 *
 * Why?
 * 1. Post-mortem: understand exactly why a trade was taken or rejected
 * 2. Replay: feed the journal back through the engine to reproduce behavior
 * 3. Compliance: prove to yourself (or an investor) what happened
 * 4. Debugging: when the engine does something unexpected, the journal explains
 *
 * Events recorded:
 * - Signals generated (with all features and confidence)
 * - Risk decisions (with CriterionX explanation)
 * - Orders submitted, filled, cancelled, rejected
 * - Position opens/closes with PnL
 * - Risk events (circuit breaker, kill switch)
 * - Whale detections
 * - Regime changes
 *
 * Output: data/journal/{date}.ndjson
 */
export class TradeJournal {
  private stream: WriteStream | null = null;
  private currentDate = "";
  private entryCount = 0;
  private baseDir: string;

  constructor(baseDir = "data/journal") {
    this.baseDir = baseDir;
  }

  start(): void {
    mkdirSync(this.baseDir, { recursive: true });
    this.rotateFile();

    // Record all significant events
    bus.on("signal:new", (signal) => {
      this.write("signal", {
        symbol: signal.symbol,
        direction: signal.direction,
        confidence: signal.confidence,
        strategy: signal.strategy,
        expectedReturn: signal.expectedReturn,
        horizon: signal.horizon,
        features: signal.features,
        metadata: signal.metadata,
      });
    });

    bus.on("order:intent", (intent) => {
      this.write("order_intent", {
        symbol: intent.symbol,
        exchange: intent.exchange,
        side: intent.side,
        qty: intent.qty.toString(),
        orderType: intent.orderType,
        maxSlippageBps: intent.maxSlippageBps,
        confidence: intent.signal.confidence,
        strategy: intent.signal.strategy,
      });
    });

    bus.on("order:filled", (fill) => {
      this.write("order_filled", fill);
    });

    bus.on("order:cancelled", (data) => {
      this.write("order_cancelled", data);
    });

    bus.on("order:rejected", (data) => {
      this.write("order_rejected", data);
    });

    bus.on("risk:circuit_breaker", (data) => {
      this.write("circuit_breaker", data);
    });

    bus.on("risk:kill_switch", (data) => {
      this.write("kill_switch", data);
    });

    bus.on("risk:warning", (data) => {
      this.write("risk_warning", data);
    });

    bus.on("feature:regime_change", (data) => {
      this.write("regime_change", data);
    });

    bus.on("feature:anomaly", (data) => {
      if (data.severity > 0.5) {
        this.write("anomaly", data);
      }
    });

    bus.on("ws:connected", (data) => {
      this.write("ws_connected", data);
    });

    bus.on("ws:disconnected", (data) => {
      this.write("ws_disconnected", data);
    });

    log.info({ baseDir: this.baseDir }, "Trade journal started");
  }

  stop(): void {
    this.stream?.end();
    log.info({ entries: this.entryCount }, "Trade journal stopped");
  }

  private write(type: string, data: unknown): void {
    this.rotateFile();

    const entry: JournalEntry = {
      ts: Date.now(),
      type,
      data,
    };

    this.stream?.write(JSON.stringify(entry) + "\n");
    this.entryCount++;
  }

  /** Rotate to a new file each day */
  private rotateFile(): void {
    const date = new Date().toISOString().split("T")[0];
    if (date === this.currentDate && this.stream) return;

    this.stream?.end();
    this.currentDate = date;
    const filePath = join(this.baseDir, `${date}.ndjson`);
    this.stream = createWriteStream(filePath, { flags: "a" });
  }

  get stats() {
    return { entries: this.entryCount, date: this.currentDate };
  }
}
