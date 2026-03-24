import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { PortfolioManager } from "../../src/portfolio/portfolio-manager.js";

describe("PortfolioManager", () => {
  let pm: PortfolioManager;

  beforeEach(() => {
    pm = new PortfolioManager(10_000);
  });

  it("starts with initial cash", () => {
    const snap = pm.snapshot();
    expect(snap.equity.toNumber()).toBe(10_000);
    expect(snap.cash.toNumber()).toBe(10_000);
    expect(snap.positionCount).toBe(0);
  });

  it("opens a long position correctly", () => {
    pm.applyFill("binance", "BTC-USDT", "long", new Decimal(0.1), new Decimal(40_000));

    const snap = pm.snapshot();
    expect(snap.positionCount).toBe(1);
    expect(snap.cash.toNumber()).toBe(10_000 - 4_000); // 0.1 * 40000

    const pos = pm.getPosition("binance", "BTC-USDT");
    expect(pos).toBeDefined();
    expect(pos!.side).toBe("long");
    expect(pos!.qty.toNumber()).toBe(0.1);
    expect(pos!.entryPrice.toNumber()).toBe(40_000);
  });

  it("closes a long position with profit", () => {
    pm.applyFill("binance", "BTC-USDT", "long", new Decimal(0.1), new Decimal(40_000));

    // Close by selling
    pm.applyFill("binance", "BTC-USDT", "short", new Decimal(0.1), new Decimal(42_000));

    const snap = pm.snapshot();
    expect(snap.positionCount).toBe(0);
    // PnL: (42000 - 40000) * 0.1 = 200
    expect(snap.totalRealizedPnl.toNumber()).toBe(200);
  });

  it("closes a short position with profit", () => {
    pm.applyFill("binance", "BTC-USDT", "short", new Decimal(0.1), new Decimal(40_000));

    // Close by buying
    pm.applyFill("binance", "BTC-USDT", "long", new Decimal(0.1), new Decimal(38_000));

    const snap = pm.snapshot();
    expect(snap.positionCount).toBe(0);
    // PnL: (40000 - 38000) * 0.1 = 200
    expect(snap.totalRealizedPnl.toNumber()).toBe(200);
  });

  it("handles partial close", () => {
    pm.applyFill("binance", "BTC-USDT", "long", new Decimal(1), new Decimal(40_000));

    // Partial close: sell 0.5
    pm.applyFill("binance", "BTC-USDT", "short", new Decimal(0.5), new Decimal(41_000));

    const pos = pm.getPosition("binance", "BTC-USDT");
    expect(pos).toBeDefined();
    expect(pos!.qty.toNumber()).toBe(0.5);

    const snap = pm.snapshot();
    // PnL: (41000 - 40000) * 0.5 = 500
    expect(snap.totalRealizedPnl.toNumber()).toBe(500);
  });

  it("averages in on position increase", () => {
    pm.applyFill("binance", "BTC-USDT", "long", new Decimal(0.5), new Decimal(40_000));
    pm.applyFill("binance", "BTC-USDT", "long", new Decimal(0.5), new Decimal(42_000));

    const pos = pm.getPosition("binance", "BTC-USDT");
    expect(pos).toBeDefined();
    expect(pos!.qty.toNumber()).toBe(1);
    // Avg price: (40000*0.5 + 42000*0.5) / 1 = 41000
    expect(pos!.entryPrice.toNumber()).toBe(41_000);
  });

  it("flips position when closing more than open", () => {
    pm.applyFill("binance", "BTC-USDT", "long", new Decimal(0.5), new Decimal(40_000));

    // Sell 0.8 — closes 0.5 long, opens 0.3 short
    pm.applyFill("binance", "BTC-USDT", "short", new Decimal(0.8), new Decimal(41_000));

    const pos = pm.getPosition("binance", "BTC-USDT");
    expect(pos).toBeDefined();
    expect(pos!.side).toBe("short");
    expect(pos!.qty.toNumber()).toBe(0.3);
  });

  it("tracks multiple positions across exchanges", () => {
    pm.applyFill("binance", "BTC-USDT", "long", new Decimal(0.1), new Decimal(40_000));
    pm.applyFill("binance", "ETH-USDT", "short", new Decimal(1), new Decimal(2_500));

    const snap = pm.snapshot();
    expect(snap.positionCount).toBe(2);
    expect(pm.getPosition("binance", "BTC-USDT")!.side).toBe("long");
    expect(pm.getPosition("binance", "ETH-USDT")!.side).toBe("short");
  });

  it("records trade history", () => {
    pm.applyFill("binance", "BTC-USDT", "long", new Decimal(0.1), new Decimal(40_000));
    pm.applyFill("binance", "BTC-USDT", "short", new Decimal(0.1), new Decimal(41_000));

    const trades = pm.recentTrades();
    expect(trades.length).toBe(1);
    expect(trades[0].pnl.toNumber()).toBe(100);
  });
});
