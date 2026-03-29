import postgres from "postgres";
import { createChildLogger } from "../utils/logger.js";
import { bus } from "../utils/event-bus.js";
import type { Trade, OrderBookDelta, MarketEvent } from "../types/market.js";

const log = createChildLogger("db-store");

export interface DbStoreOptions {
  url: string;
  /** Flush interval in ms (default: 2000) */
  flushIntervalMs?: number;
  /** Max buffer size before force flush (default: 5000) */
  maxBufferSize?: number;
}

interface TradeRow {
  ts: Date;
  exchange: string;
  symbol: string;
  trade_id: string;
  price: string;
  qty: string;
  side: string;
  is_buyer_maker: boolean;
}

interface BookSnapshotRow {
  ts: Date;
  exchange: string;
  symbol: string;
  mid_price: string;
  spread_bps: string;
  bid_depth: string;
  ask_depth: string;
  imbalance_5: string;
  imbalance_20: string;
}

interface SignalRow {
  ts: Date;
  symbol: string;
  exchange: string;
  direction: string;
  confidence: string;
  expected_return: string | null;
  horizon_s: number | null;
  strategy: string;
}

interface OrderRow {
  id: string;
  ts: Date;
  symbol: string;
  exchange: string;
  side: string;
  qty: string;
  order_type: string;
  status: string;
  fill_price: string | null;
  fill_qty: string | null;
  slippage_bps: string | null;
  strategy: string | null;
}

interface PortfolioRow {
  ts: Date;
  equity: string;
  cash: string;
  unrealized_pnl: string;
  realized_pnl: string;
  position_count: number;
  drawdown_pct: string;
}

/**
 * TimescaleDB storage adapter.
 *
 * Buffers market events in memory and flushes to TimescaleDB in batches
 * using multi-row INSERT for high throughput.
 *
 * Tables (created by init-db.sql):
 * - trades: every trade from exchange WebSockets
 * - book_snapshots: periodic order book summaries
 * - signals: strategy signals with confidence
 * - orders: execution orders with fill info
 * - portfolio_snapshots: periodic equity snapshots
 */
export class DbStore {
  private sql: postgres.Sql;
  private tradeBuffer: TradeRow[] = [];
  private bookBuffer: BookSnapshotRow[] = [];
  private signalBuffer: SignalRow[] = [];
  private orderBuffer: OrderRow[] = [];
  private portfolioBuffer: PortfolioRow[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushIntervalMs: number;
  private maxBufferSize: number;
  private writeCount = 0;
  private errorCount = 0;
  private connected = false;

  constructor(opts: DbStoreOptions) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.maxBufferSize = opts.maxBufferSize ?? 5000;
    this.sql = postgres(opts.url, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      types: {
        bigint: postgres.BigInt,
      },
    });
  }

  async start(): Promise<void> {
    // Verify connection
    try {
      await this.sql`SELECT 1`;
      this.connected = true;
      log.info("Connected to TimescaleDB");
    } catch (err) {
      log.error({ err }, "Failed to connect to TimescaleDB — writes will be buffered");
      // Retry connection in background
      this.retryConnection();
      return;
    }

    this.flushTimer = setInterval(() => this.flushAll(), this.flushIntervalMs);
    this.subscribeToEvents();
    log.info({ flushIntervalMs: this.flushIntervalMs }, "DB store started");
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flushAll();
    await this.sql.end();
    log.info({ totalWrites: this.writeCount, errors: this.errorCount }, "DB store stopped");
  }

  /** Append a market event to the appropriate buffer */
  appendMarketEvent(event: MarketEvent): void {
    switch (event.type) {
      case "trade":
        this.appendTrade(event.data);
        break;
      case "book_delta":
        // We store periodic snapshots, not every delta
        break;
    }
  }

  appendTrade(trade: Trade): void {
    this.tradeBuffer.push({
      ts: new Date(trade.ts),
      exchange: trade.exchange,
      symbol: trade.symbol,
      trade_id: trade.id,
      price: trade.price.toString(),
      qty: trade.qty.toString(),
      side: trade.side,
      is_buyer_maker: trade.isBuyerMaker,
    });
    if (this.tradeBuffer.length >= this.maxBufferSize) {
      this.flushTrades();
    }
  }

  appendBookSnapshot(snapshot: {
    exchange: string;
    symbol: string;
    midPrice: number;
    spreadBps: number;
    bidDepth: number;
    askDepth: number;
    imbalance5: number;
    imbalance20: number;
  }): void {
    this.bookBuffer.push({
      ts: new Date(),
      exchange: snapshot.exchange,
      symbol: snapshot.symbol,
      mid_price: snapshot.midPrice.toFixed(8),
      spread_bps: snapshot.spreadBps.toFixed(4),
      bid_depth: snapshot.bidDepth.toFixed(2),
      ask_depth: snapshot.askDepth.toFixed(2),
      imbalance_5: snapshot.imbalance5.toFixed(6),
      imbalance_20: snapshot.imbalance20.toFixed(6),
    });
  }

  appendSignal(signal: {
    ts: number;
    symbol: string;
    exchange: string;
    direction: string;
    confidence: number;
    expectedReturn?: number;
    horizon?: number;
    strategy: string;
  }): void {
    this.signalBuffer.push({
      ts: new Date(signal.ts),
      symbol: signal.symbol,
      exchange: signal.exchange,
      direction: signal.direction,
      confidence: signal.confidence.toFixed(4),
      expected_return: signal.expectedReturn?.toFixed(6) ?? null,
      horizon_s: signal.horizon ?? null,
      strategy: signal.strategy,
    });
  }

  appendOrder(order: {
    id: string;
    ts: number;
    symbol: string;
    exchange: string;
    side: string;
    qty: number;
    orderType: string;
    status: string;
    fillPrice?: number;
    fillQty?: number;
    slippageBps?: number;
    strategy?: string;
  }): void {
    this.orderBuffer.push({
      id: order.id,
      ts: new Date(order.ts),
      symbol: order.symbol,
      exchange: order.exchange,
      side: order.side,
      qty: order.qty.toFixed(8),
      order_type: order.orderType,
      status: order.status,
      fill_price: order.fillPrice?.toFixed(8) ?? null,
      fill_qty: order.fillQty?.toFixed(8) ?? null,
      slippage_bps: order.slippageBps?.toFixed(4) ?? null,
      strategy: order.strategy ?? null,
    });
  }

  appendPortfolioSnapshot(snapshot: {
    equity: number;
    cash: number;
    unrealizedPnl: number;
    realizedPnl: number;
    positionCount: number;
    drawdownPct: number;
  }): void {
    this.portfolioBuffer.push({
      ts: new Date(),
      equity: snapshot.equity.toFixed(2),
      cash: snapshot.cash.toFixed(2),
      unrealized_pnl: snapshot.unrealizedPnl.toFixed(2),
      realized_pnl: snapshot.realizedPnl.toFixed(2),
      position_count: snapshot.positionCount,
      drawdown_pct: snapshot.drawdownPct.toFixed(4),
    });
  }

  async query(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected) return [];
    switch (name) {
      case "portfolio-history": {
        const hours = Number(params.hours ?? 24);
        return this.sql`
          SELECT ts, equity::float, cash::float, unrealized_pnl::float, realized_pnl::float,
                 position_count, drawdown_pct::float
          FROM portfolio_snapshots
          WHERE ts > now() - ${hours + ' hours'}::interval
          ORDER BY ts ASC
        `;
      }
      case "strategy-stats": {
        const hours = Number(params.hours ?? 24);
        return this.sql`
          SELECT strategy, direction,
                 count(*)::int as total,
                 avg(confidence::float)::float as avg_confidence,
                 count(*) FILTER (WHERE confidence::float > 0.6)::int as high_confidence
          FROM signals
          WHERE ts > now() - ${hours + ' hours'}::interval
            AND strategy IS NOT NULL
          GROUP BY strategy, direction
          ORDER BY total DESC
        `;
      }
      case "order-history": {
        const limit = Number(params.limit ?? 100);
        return this.sql`
          SELECT id, ts, symbol, side, qty::float, order_type, status,
                 fill_price::float, fill_qty::float, slippage_bps::float, strategy
          FROM orders
          WHERE status = 'filled'
          ORDER BY ts DESC
          LIMIT ${limit}
        `;
      }
      default:
        return [];
    }
  }

  get stats() {
    return {
      connected: this.connected,
      writeCount: this.writeCount,
      errorCount: this.errorCount,
      buffered: {
        trades: this.tradeBuffer.length,
        books: this.bookBuffer.length,
        signals: this.signalBuffer.length,
        orders: this.orderBuffer.length,
        portfolio: this.portfolioBuffer.length,
      },
    };
  }

  // ── Flush logic ─────────────────────────────────────────────

  private async flushAll(): Promise<void> {
    if (!this.connected) return;
    await Promise.all([
      this.flushTrades(),
      this.flushBooks(),
      this.flushSignals(),
      this.flushOrders(),
      this.flushPortfolio(),
    ]);
  }

  private async flushTrades(): Promise<void> {
    if (this.tradeBuffer.length === 0) return;
    const batch = this.tradeBuffer.splice(0);
    try {
      await this.sql`
        INSERT INTO trades ${this.sql(batch, "ts", "exchange", "symbol", "trade_id", "price", "qty", "side", "is_buyer_maker")}
      `;
      this.writeCount += batch.length;
    } catch (err) {
      this.errorCount++;
      log.error({ err, count: batch.length }, "Failed to flush trades");
      // Re-add to buffer for retry (cap to prevent OOM)
      if (this.tradeBuffer.length < this.maxBufferSize * 3) {
        this.tradeBuffer.unshift(...batch);
      }
    }
  }

  private async flushBooks(): Promise<void> {
    if (this.bookBuffer.length === 0) return;
    const batch = this.bookBuffer.splice(0);
    try {
      await this.sql`
        INSERT INTO book_snapshots ${this.sql(batch, "ts", "exchange", "symbol", "mid_price", "spread_bps", "bid_depth", "ask_depth", "imbalance_5", "imbalance_20")}
      `;
      this.writeCount += batch.length;
    } catch (err) {
      this.errorCount++;
      log.error({ err, count: batch.length }, "Failed to flush book snapshots");
    }
  }

  private async flushSignals(): Promise<void> {
    if (this.signalBuffer.length === 0) return;
    const batch = this.signalBuffer.splice(0);
    try {
      await this.sql`
        INSERT INTO signals ${this.sql(batch, "ts", "symbol", "exchange", "direction", "confidence", "expected_return", "horizon_s", "strategy")}
      `;
      this.writeCount += batch.length;
    } catch (err) {
      this.errorCount++;
      log.error({ err, count: batch.length }, "Failed to flush signals");
    }
  }

  private async flushOrders(): Promise<void> {
    if (this.orderBuffer.length === 0) return;
    const batch = this.orderBuffer.splice(0);
    try {
      await this.sql`
        INSERT INTO orders ${this.sql(batch, "id", "ts", "symbol", "exchange", "side", "qty", "order_type", "status", "fill_price", "fill_qty", "slippage_bps", "strategy")}
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          fill_price = EXCLUDED.fill_price,
          fill_qty = EXCLUDED.fill_qty,
          slippage_bps = EXCLUDED.slippage_bps
      `;
      this.writeCount += batch.length;
    } catch (err) {
      this.errorCount++;
      log.error({ err, count: batch.length }, "Failed to flush orders");
    }
  }

  private async flushPortfolio(): Promise<void> {
    if (this.portfolioBuffer.length === 0) return;
    const batch = this.portfolioBuffer.splice(0);
    try {
      await this.sql`
        INSERT INTO portfolio_snapshots ${this.sql(batch, "ts", "equity", "cash", "unrealized_pnl", "realized_pnl", "position_count", "drawdown_pct")}
      `;
      this.writeCount += batch.length;
    } catch (err) {
      this.errorCount++;
      log.error({ err, count: batch.length }, "Failed to flush portfolio");
    }
  }

  // ── Event subscriptions ─────────────────────────────────────

  private subscribeToEvents(): void {
    bus.on("market:event", (event) => this.appendMarketEvent(event));

    bus.on("signal:new", (signal) => {
      this.appendSignal({
        ts: signal.ts,
        symbol: signal.symbol,
        exchange: signal.exchange ?? "binance",
        direction: signal.direction,
        confidence: signal.confidence,
        expectedReturn: signal.expectedReturn,
        horizon: signal.horizon,
        strategy: signal.strategy,
      });
    });

    bus.on("order:filled", (fill) => {
      this.appendOrder({
        id: fill.id ?? `fill-${Date.now()}`,
        ts: Date.now(),
        symbol: fill.symbol ?? "",
        exchange: fill.exchange ?? "binance",
        side: fill.direction ?? fill.side ?? "",
        qty: fill.fillQty ?? 0,
        orderType: "market",
        status: "filled",
        fillPrice: fill.fillPrice,
        fillQty: fill.fillQty,
        slippageBps: fill.slippageBps,
      });
    });
  }

  // ── Retry logic ─────────────────────────────────────────────

  private retryConnection(): void {
    const retry = async () => {
      try {
        await this.sql`SELECT 1`;
        this.connected = true;
        log.info("TimescaleDB connection established (retry)");
        this.flushTimer = setInterval(() => this.flushAll(), this.flushIntervalMs);
        this.subscribeToEvents();
      } catch {
        setTimeout(retry, 5000);
      }
    };
    setTimeout(retry, 5000);
  }
}
