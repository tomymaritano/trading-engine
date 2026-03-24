import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";
import Decimal from "decimal.js";
import type { OrderIntent } from "../types/signals.js";

const log = createChildLogger("twap");

interface TwapOrder {
  id: string;
  intent: OrderIntent;
  totalQty: Decimal;
  filledQty: Decimal;
  slices: number;
  sliceIntervalMs: number;
  currentSlice: number;
  active: boolean;
  startTs: number;
}

/**
 * TWAP Execution Algorithm (pattern: StockSharp)
 *
 * Time-Weighted Average Price: splits a large order into equal
 * chunks executed at regular intervals over a time window.
 *
 * Why? A single large market order moves the price against you.
 * TWAP distributes the impact across time, achieving a better
 * average fill price.
 *
 * Example:
 *   Buy 0.1 BTC over 5 minutes, 10 slices
 *   → Slice 1: buy 0.01 BTC at t=0
 *   → Slice 2: buy 0.01 BTC at t=30s
 *   → ...
 *   → Slice 10: buy 0.01 BTC at t=4m30s
 *
 * Each slice is a small market order that barely moves the book.
 * The average fill price will be close to the TWAP of the market
 * over those 5 minutes.
 *
 * When to use:
 * - Order size > 1% of visible book depth
 * - Low-confidence signals where you want to average in
 * - Closing large positions without moving the market
 */
export class TwapExecutor {
  private activeOrders = new Map<string, TwapOrder>();
  private orderCounter = 0;

  /**
   * Execute an order via TWAP.
   *
   * @param intent - The original order intent
   * @param slices - Number of sub-orders (default 10)
   * @param durationMs - Total execution window in ms (default 5 min)
   */
  async execute(
    intent: OrderIntent,
    slices = 10,
    durationMs = 5 * 60_000,
  ): Promise<{ id: string; avgPrice: number; totalFilled: number }> {
    const id = `twap_${++this.orderCounter}_${Date.now()}`;
    const sliceQty = intent.qty.div(slices);
    const sliceIntervalMs = durationMs / slices;

    const order: TwapOrder = {
      id,
      intent,
      totalQty: intent.qty,
      filledQty: new Decimal(0),
      slices,
      sliceIntervalMs,
      currentSlice: 0,
      active: true,
      startTs: Date.now(),
    };

    this.activeOrders.set(id, order);

    log.info({
      id,
      symbol: intent.symbol,
      side: intent.side,
      totalQty: intent.qty.toString(),
      slices,
      sliceQty: sliceQty.toString(),
      intervalMs: sliceIntervalMs,
      durationMs,
    }, "TWAP execution started");

    let totalNotional = 0;
    let totalFilled = 0;

    for (let i = 0; i < slices && order.active; i++) {
      order.currentSlice = i + 1;

      // Emit a market order for this slice
      const sliceIntent: OrderIntent = {
        ...intent,
        qty: sliceQty,
        orderType: "market",
        ttlMs: sliceIntervalMs * 0.8, // 80% of interval as TTL
      };

      bus.emit("order:intent", sliceIntent);

      // Wait for interval (except last slice)
      if (i < slices - 1) {
        await sleep(sliceIntervalMs);
      }
    }

    this.activeOrders.delete(id);

    log.info({
      id,
      symbol: intent.symbol,
      slicesExecuted: order.currentSlice,
    }, "TWAP execution complete");

    return {
      id,
      avgPrice: totalFilled > 0 ? totalNotional / totalFilled : 0,
      totalFilled,
    };
  }

  /** Cancel an active TWAP order */
  cancel(id: string): void {
    const order = this.activeOrders.get(id);
    if (order) {
      order.active = false;
      log.info({ id, slicesCompleted: order.currentSlice, totalSlices: order.slices }, "TWAP cancelled");
    }
  }

  /** Check if an order should use TWAP based on size vs liquidity */
  shouldUseTwap(orderQty: Decimal, bookDepth: number, midPrice: number): boolean {
    const orderNotional = orderQty.toNumber() * midPrice;
    // Use TWAP if order is > 5% of visible book depth
    return orderNotional > bookDepth * 0.05;
  }

  get stats() {
    return {
      active: this.activeOrders.size,
      orders: [...this.activeOrders.values()].map((o) => ({
        id: o.id,
        symbol: o.intent.symbol,
        progress: `${o.currentSlice}/${o.slices}`,
      })),
    };
  }
}
