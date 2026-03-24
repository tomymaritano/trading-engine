import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("roi-table");

interface RoiEntry {
  /** Minutes since trade entry */
  minutes: number;
  /** Minimum profit % to take (e.g., 0.005 = 0.5%) */
  profitPct: number;
}

/**
 * ROI Table — Time-Based Profit Targets (pattern: Freqtrade)
 *
 * As a trade ages, the profit target decreases. This captures
 * the insight that if a trade hasn't moved much after a while,
 * it's better to take what you have than wait for the full target.
 *
 * Example table:
 *   { minutes: 0,  profitPct: 0.01  }  → immediately: need 1%
 *   { minutes: 10, profitPct: 0.005 }  → after 10 min: take 0.5%
 *   { minutes: 30, profitPct: 0.002 }  → after 30 min: take 0.2%
 *   { minutes: 60, profitPct: 0     }  → after 60 min: close at breakeven
 *
 * Trade entered at $100:
 *   t=0:   close if price > $101 (1% profit)
 *   t=10m: close if price > $100.50 (0.5%)
 *   t=30m: close if price > $100.20 (0.2%)
 *   t=60m: close at any profit
 */
export class RoiTable {
  private entries: RoiEntry[];

  constructor(entries?: RoiEntry[]) {
    // Default: aggressive profit taking for short-horizon trades
    this.entries = (entries ?? [
      { minutes: 0, profitPct: 0.008 },    // 0.8% immediately
      { minutes: 5, profitPct: 0.005 },    // 0.5% after 5 min
      { minutes: 15, profitPct: 0.003 },   // 0.3% after 15 min
      { minutes: 30, profitPct: 0.001 },   // 0.1% after 30 min
      { minutes: 60, profitPct: 0 },       // breakeven after 60 min
    ]).sort((a, b) => a.minutes - b.minutes);
  }

  /**
   * Check if a position should be closed based on ROI table.
   *
   * @param entryPrice - Position entry price
   * @param currentPrice - Current market price
   * @param side - "long" or "short"
   * @param elapsedMs - Time since entry in milliseconds
   * @returns true if position should be closed for profit
   */
  shouldTakeProfit(
    entryPrice: number,
    currentPrice: number,
    side: "long" | "short",
    elapsedMs: number,
  ): boolean {
    const elapsedMin = elapsedMs / 60_000;

    // Find the applicable ROI entry (latest one that's <= elapsed time)
    let applicableEntry: RoiEntry | null = null;
    for (const entry of this.entries) {
      if (elapsedMin >= entry.minutes) {
        applicableEntry = entry;
      } else {
        break;
      }
    }

    if (!applicableEntry) return false;

    // Compute current profit
    const profitPct = side === "long"
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;

    return profitPct >= applicableEntry.profitPct;
  }

  /**
   * Get the current profit target for a given elapsed time.
   */
  getCurrentTarget(elapsedMs: number): number {
    const elapsedMin = elapsedMs / 60_000;
    let target = this.entries[0]?.profitPct ?? 0.01;

    for (const entry of this.entries) {
      if (elapsedMin >= entry.minutes) {
        target = entry.profitPct;
      } else {
        break;
      }
    }
    return target;
  }
}

/** Predefined ROI tables for different trading styles */
export const ROI_TABLES = {
  /** Scalping: tight targets, fast exits */
  scalping: new RoiTable([
    { minutes: 0, profitPct: 0.005 },
    { minutes: 2, profitPct: 0.003 },
    { minutes: 5, profitPct: 0.001 },
    { minutes: 10, profitPct: 0 },
  ]),

  /** Default: moderate targets */
  moderate: new RoiTable([
    { minutes: 0, profitPct: 0.008 },
    { minutes: 5, profitPct: 0.005 },
    { minutes: 15, profitPct: 0.003 },
    { minutes: 30, profitPct: 0.001 },
    { minutes: 60, profitPct: 0 },
  ]),

  /** Patient: wider targets, longer holds */
  patient: new RoiTable([
    { minutes: 0, profitPct: 0.015 },
    { minutes: 15, profitPct: 0.010 },
    { minutes: 60, profitPct: 0.005 },
    { minutes: 120, profitPct: 0.002 },
    { minutes: 240, profitPct: 0 },
  ]),
};
