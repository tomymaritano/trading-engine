import Decimal from "decimal.js";
import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";
import type { Exchange, Symbol } from "../types/market.js";

const log = createChildLogger("portfolio");

export interface Position {
  exchange: Exchange;
  symbol: Symbol;
  side: "long" | "short";
  qty: Decimal;
  entryPrice: Decimal;
  currentPrice: Decimal;
  unrealizedPnl: Decimal;
  realizedPnl: Decimal;
  entryTs: number;
  lastUpdateTs: number;
}

export interface PortfolioSnapshot {
  ts: number;
  equity: Decimal;
  cash: Decimal;
  positions: Position[];
  totalUnrealizedPnl: Decimal;
  totalRealizedPnl: Decimal;
  exposure: Decimal;          // sum of abs(position value)
  netExposure: Decimal;       // sum of signed position value
  positionCount: number;
}

/**
 * Portfolio Manager — tracks positions, PnL, and portfolio state.
 *
 * Responsibilities:
 * 1. Track all open positions across exchanges
 * 2. Mark-to-market using live prices
 * 3. Compute portfolio-level metrics (exposure, PnL, drawdown)
 * 4. Provide correlation-adjusted position limits
 * 5. Emit portfolio snapshots for monitoring
 *
 * Position lifecycle:
 *   order:filled → open/increase position
 *   order:filled (opposite side) → reduce/close position
 *   mark-to-market on every price update
 */
export class PortfolioManager {
  private positions = new Map<string, Position>();
  private cash: Decimal;
  private totalRealizedPnl = new Decimal(0);
  private tradeHistory: Array<{
    ts: number;
    symbol: string;
    side: string;
    qty: Decimal;
    price: Decimal;
    pnl: Decimal;
  }> = [];

  constructor(initialCash: number) {
    this.cash = new Decimal(initialCash);
  }

  start(): void {
    // Listen for fills to update positions
    bus.on("order:filled", (fill) => {
      this.onFill(fill);
    });

    // Mark-to-market on trade updates
    bus.on("market:trade", (trade) => {
      const key = `${trade.exchange}:${trade.symbol}`;
      const pos = this.positions.get(key);
      if (pos) {
        pos.currentPrice = trade.price;
        pos.lastUpdateTs = trade.ts;
        pos.unrealizedPnl = this.computeUnrealizedPnl(pos);
      }
    });

    log.info({ initialCash: this.cash.toString() }, "Portfolio manager started");
  }

  /** Get current portfolio snapshot */
  snapshot(): PortfolioSnapshot {
    const positions = [...this.positions.values()];
    let totalUnrealizedPnl = new Decimal(0);
    let exposure = new Decimal(0);
    let netExposure = new Decimal(0);

    for (const pos of positions) {
      totalUnrealizedPnl = totalUnrealizedPnl.add(pos.unrealizedPnl);
      const posValue = pos.currentPrice.mul(pos.qty);
      exposure = exposure.add(posValue.abs());
      netExposure = netExposure.add(
        pos.side === "long" ? posValue : posValue.neg(),
      );
    }

    const equity = this.cash.add(totalUnrealizedPnl).add(this.totalRealizedPnl);

    return {
      ts: Date.now(),
      equity,
      cash: this.cash,
      positions,
      totalUnrealizedPnl,
      totalRealizedPnl: this.totalRealizedPnl,
      exposure,
      netExposure,
      positionCount: positions.length,
    };
  }

  /** Get a specific position */
  getPosition(exchange: Exchange, symbol: Symbol): Position | undefined {
    return this.positions.get(`${exchange}:${symbol}`);
  }

  /** Check if we can take a new position (correlation check) */
  canOpenPosition(exchange: Exchange, symbol: Symbol, side: "long" | "short"): boolean {
    const existing = this.positions.get(`${exchange}:${symbol}`);
    // Can always close or flip
    if (existing && existing.side !== side) return true;
    // Can't add to existing position in same direction (simplification)
    if (existing) return false;
    return true;
  }

  /** Get portfolio equity as number (for risk engine) */
  equityValue(): number {
    return this.snapshot().equity.toNumber();
  }

  /** Recent trade history for reporting */
  recentTrades(limit = 50): typeof this.tradeHistory {
    return this.tradeHistory.slice(-limit);
  }

  private onFill(fill: { id: string; fillPrice: number; fillQty: number; slippageBps: number; symbol?: string; exchange?: string; side?: string; direction?: string }): void {
    if (!fill.symbol || !fill.exchange || !fill.direction) {
      log.warn({ id: fill.id }, "Fill missing symbol/exchange/direction, skipping");
      return;
    }

    const side = fill.direction as "long" | "short";
    const exchange = fill.exchange as Exchange;

    log.info(
      { id: fill.id, symbol: fill.symbol, side, price: fill.fillPrice, qty: fill.fillQty },
      "Processing fill in portfolio",
    );

    this.applyFill(
      exchange,
      fill.symbol,
      side,
      new Decimal(fill.fillQty),
      new Decimal(fill.fillPrice),
    );
  }

  /** Open or update a position from an execution fill */
  applyFill(
    exchange: Exchange,
    symbol: Symbol,
    side: "long" | "short",
    qty: Decimal,
    price: Decimal,
  ): void {
    const key = `${exchange}:${symbol}`;
    const existing = this.positions.get(key);

    if (!existing) {
      // New position
      const notional = price.mul(qty);
      this.cash = this.cash.sub(notional);

      this.positions.set(key, {
        exchange,
        symbol,
        side,
        qty,
        entryPrice: price,
        currentPrice: price,
        unrealizedPnl: new Decimal(0),
        realizedPnl: new Decimal(0),
        entryTs: Date.now(),
        lastUpdateTs: Date.now(),
      });

      log.info({ exchange, symbol, side, qty: qty.toString(), price: price.toString() }, "Position opened");
      return;
    }

    if (existing.side === side) {
      // Increase position (average in)
      const totalQty = existing.qty.add(qty);
      const totalCost = existing.entryPrice.mul(existing.qty).add(price.mul(qty));
      existing.entryPrice = totalCost.div(totalQty);
      existing.qty = totalQty;
      this.cash = this.cash.sub(price.mul(qty));

      log.info({ exchange, symbol, qty: totalQty.toString() }, "Position increased");
    } else {
      // Reduce or flip position
      if (qty.gte(existing.qty)) {
        // Close position
        const pnl = this.computeClosePnl(existing, price, existing.qty);
        this.totalRealizedPnl = this.totalRealizedPnl.add(pnl);
        this.cash = this.cash.add(price.mul(existing.qty));

        this.tradeHistory.push({
          ts: Date.now(),
          symbol,
          side: existing.side,
          qty: existing.qty,
          price,
          pnl,
        });

        const remainingQty = qty.sub(existing.qty);
        this.positions.delete(key);

        log.info({ exchange, symbol, pnl: pnl.toString() }, "Position closed");

        // If there's remaining qty, open in opposite direction
        if (remainingQty.gt(0)) {
          this.applyFill(exchange, symbol, side, remainingQty, price);
        }
      } else {
        // Partial close
        const pnl = this.computeClosePnl(existing, price, qty);
        this.totalRealizedPnl = this.totalRealizedPnl.add(pnl);
        existing.qty = existing.qty.sub(qty);
        existing.realizedPnl = existing.realizedPnl.add(pnl);
        this.cash = this.cash.add(price.mul(qty));

        this.tradeHistory.push({
          ts: Date.now(),
          symbol,
          side: existing.side,
          qty,
          price,
          pnl,
        });

        log.info({ exchange, symbol, remainingQty: existing.qty.toString(), pnl: pnl.toString() }, "Position partially closed");
      }
    }
  }

  private computeUnrealizedPnl(pos: Position): Decimal {
    const priceDiff = pos.currentPrice.sub(pos.entryPrice);
    return pos.side === "long"
      ? priceDiff.mul(pos.qty)
      : priceDiff.neg().mul(pos.qty);
  }

  private computeClosePnl(pos: Position, closePrice: Decimal, qty: Decimal): Decimal {
    const priceDiff = closePrice.sub(pos.entryPrice);
    return pos.side === "long"
      ? priceDiff.mul(qty)
      : priceDiff.neg().mul(qty);
  }
}
