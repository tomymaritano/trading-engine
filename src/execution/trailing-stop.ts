import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";
import type { Trade, Exchange, Symbol } from "../types/market.js";

const log = createChildLogger("trailing-stop");

interface TrackedPosition {
  exchange: Exchange;
  symbol: Symbol;
  side: "long" | "short";
  entryPrice: number;
  highWaterMark: number;   // best price since entry (for longs)
  lowWaterMark: number;    // best price since entry (for shorts)
  trailingPct: number;     // trailing distance in %
  activationPct: number;   // min profit before trailing activates (0 = immediate)
  activated: boolean;
  stopPrice: number;
}

/**
 * Trailing Stop Manager (pattern: Freqtrade)
 *
 * A trailing stop follows the price when it moves in your favor,
 * then triggers when it reverses by a set percentage.
 *
 * Example (long position, 1% trailing, 0.5% activation):
 *   Entry: $100
 *   Price goes to $101 → activation threshold met (0.5% profit)
 *   Trail activates, stop at $101 * 0.99 = $99.99
 *   Price goes to $103 → stop moves up to $103 * 0.99 = $101.97
 *   Price drops to $101.97 → STOP TRIGGERED, lock in ~2% profit
 *
 * Without trailing: a fixed stop at $99 would have let the trade
 * run to $103 and back to $99, losing all profit.
 *
 * Configurable per position:
 * - trailingPct: how far back the stop trails (e.g., 1%)
 * - activationPct: min profit before trailing activates (e.g., 0.5%)
 */
export class TrailingStopManager {
  private positions = new Map<string, TrackedPosition>();

  constructor(
    private defaultTrailingPct = 0.01,    // 1% trailing distance
    private defaultActivationPct = 0.005, // 0.5% profit to activate
  ) {}

  start(): void {
    bus.on("market:trade", (trade) => this.onTrade(trade));

    bus.on("order:filled", (fill) => {
      if (fill.symbol && fill.direction) {
        this.trackPosition(
          fill.exchange as Exchange,
          fill.symbol,
          fill.direction as "long" | "short",
          fill.fillPrice,
        );
      }
    });

    // Broadcast trailing stop state to dashboard every 2s
    setInterval(() => {
      const stops = [...this.positions.values()].map((p) => ({
        symbol: p.symbol,
        side: p.side,
        activated: p.activated,
        stopPrice: p.stopPrice,
        entryPrice: p.entryPrice,
        highWaterMark: p.highWaterMark,
        lowWaterMark: p.lowWaterMark,
        trailingPct: p.trailingPct,
      }));
      bus.emit("trailing:update", stops);
    }, 2000);

    log.info(
      { trailingPct: this.defaultTrailingPct, activationPct: this.defaultActivationPct },
      "Trailing stop manager started",
    );
  }

  /** Start tracking a new position for trailing stop */
  trackPosition(
    exchange: Exchange,
    symbol: Symbol,
    side: "long" | "short",
    entryPrice: number,
    trailingPct?: number,
    activationPct?: number,
  ): void {
    const key = `${exchange}:${symbol}`;
    this.positions.set(key, {
      exchange,
      symbol,
      side,
      entryPrice,
      highWaterMark: entryPrice,
      lowWaterMark: entryPrice,
      trailingPct: trailingPct ?? this.defaultTrailingPct,
      activationPct: activationPct ?? this.defaultActivationPct,
      activated: false,
      stopPrice: 0,
    });
  }

  /** Remove tracking (position closed) */
  removePosition(exchange: Exchange, symbol: Symbol): void {
    this.positions.delete(`${exchange}:${symbol}`);
  }

  /** Get current stop price for a position */
  getStopPrice(exchange: Exchange, symbol: Symbol): number | null {
    const pos = this.positions.get(`${exchange}:${symbol}`);
    if (!pos || !pos.activated) return null;
    return pos.stopPrice;
  }

  private onTrade(trade: Trade): void {
    const key = `${trade.exchange}:${trade.symbol}`;
    const pos = this.positions.get(key);
    if (!pos) return;

    const price = trade.price.toNumber();

    if (pos.side === "long") {
      this.updateLong(pos, price);
    } else {
      this.updateShort(pos, price);
    }
  }

  private updateLong(pos: TrackedPosition, price: number): void {
    // Update high water mark
    if (price > pos.highWaterMark) {
      pos.highWaterMark = price;
    }

    // Check activation
    const profitPct = (pos.highWaterMark - pos.entryPrice) / pos.entryPrice;
    if (!pos.activated && profitPct >= pos.activationPct) {
      pos.activated = true;
      pos.stopPrice = pos.highWaterMark * (1 - pos.trailingPct);
      log.info({
        symbol: pos.symbol,
        side: "long",
        activatedAt: pos.highWaterMark,
        stopPrice: pos.stopPrice.toFixed(2),
      }, "Trailing stop activated");
    }

    // Update stop price (only moves up, never down)
    if (pos.activated) {
      const newStop = pos.highWaterMark * (1 - pos.trailingPct);
      if (newStop > pos.stopPrice) {
        pos.stopPrice = newStop;
      }

      // Check if stop hit
      if (price <= pos.stopPrice) {
        log.info({
          symbol: pos.symbol,
          side: "long",
          entryPrice: pos.entryPrice,
          highWaterMark: pos.highWaterMark,
          stopPrice: pos.stopPrice,
          exitPrice: price,
          profitPct: ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2),
        }, "Trailing stop triggered");

        bus.emit("risk:warning", {
          type: "trailing_stop",
          message: `Trailing stop hit for LONG ${pos.symbol} at $${price.toFixed(2)} (entry: $${pos.entryPrice.toFixed(2)}, high: $${pos.highWaterMark.toFixed(2)})`,
        });

        this.positions.delete(`${pos.exchange}:${pos.symbol}`);
      }
    }
  }

  private updateShort(pos: TrackedPosition, price: number): void {
    // Update low water mark
    if (price < pos.lowWaterMark) {
      pos.lowWaterMark = price;
    }

    // Check activation
    const profitPct = (pos.entryPrice - pos.lowWaterMark) / pos.entryPrice;
    if (!pos.activated && profitPct >= pos.activationPct) {
      pos.activated = true;
      pos.stopPrice = pos.lowWaterMark * (1 + pos.trailingPct);
      log.info({
        symbol: pos.symbol,
        side: "short",
        activatedAt: pos.lowWaterMark,
        stopPrice: pos.stopPrice.toFixed(2),
      }, "Trailing stop activated");
    }

    // Update stop price (only moves down, never up)
    if (pos.activated) {
      const newStop = pos.lowWaterMark * (1 + pos.trailingPct);
      if (newStop < pos.stopPrice) {
        pos.stopPrice = newStop;
      }

      // Check if stop hit
      if (price >= pos.stopPrice) {
        log.info({
          symbol: pos.symbol,
          side: "short",
          entryPrice: pos.entryPrice,
          lowWaterMark: pos.lowWaterMark,
          stopPrice: pos.stopPrice,
          exitPrice: price,
          profitPct: ((pos.entryPrice - price) / pos.entryPrice * 100).toFixed(2),
        }, "Trailing stop triggered");

        bus.emit("risk:warning", {
          type: "trailing_stop",
          message: `Trailing stop hit for SHORT ${pos.symbol} at $${price.toFixed(2)} (entry: $${pos.entryPrice.toFixed(2)}, low: $${pos.lowWaterMark.toFixed(2)})`,
        });

        this.positions.delete(`${pos.exchange}:${pos.symbol}`);
      }
    }
  }

  get stats() {
    return {
      tracked: this.positions.size,
      activated: [...this.positions.values()].filter((p) => p.activated).length,
    };
  }
}
