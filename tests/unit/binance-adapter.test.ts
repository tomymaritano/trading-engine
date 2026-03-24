import { describe, it, expect } from "vitest";
import { BinanceAdapter } from "../../src/adapters/binance.js";

describe("BinanceAdapter", () => {
  const adapter = new BinanceAdapter();

  describe("symbol normalization", () => {
    it("converts BTC-USDT to btcusdt", () => {
      expect(adapter.normalizeSymbol("BTC-USDT")).toBe("btcusdt");
    });

    it("converts btcusdt back to BTC-USDT", () => {
      expect(adapter.denormalizeSymbol("btcusdt")).toBe("BTC-USDT");
    });

    it("handles ETH-USDC", () => {
      expect(adapter.normalizeSymbol("ETH-USDC")).toBe("ethusdc");
      expect(adapter.denormalizeSymbol("ethusdc")).toBe("ETH-USDC");
    });
  });

  describe("WebSocket URL", () => {
    it("builds combined stream URL", () => {
      const url = adapter.buildWsUrl(["BTC-USDT", "ETH-USDT"]);
      expect(url).toContain("stream.binance.com");
      expect(url).toContain("btcusdt@trade");
      expect(url).toContain("ethusdt@depth@100ms");
    });
  });

  describe("message parsing", () => {
    it("parses trade messages", () => {
      const raw = {
        stream: "btcusdt@trade",
        data: {
          e: "trade",
          s: "BTCUSDT",
          t: 123456,
          T: 1700000000000,
          p: "42000.50",
          q: "0.001",
          m: false, // buyer is NOT maker → it's a buy
        },
      };

      const events = adapter.parseMessage(raw);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("trade");

      const trade = events[0].data;
      expect(trade).toMatchObject({
        exchange: "binance",
        symbol: "BTC-USDT",
        side: "buy",
      });
      expect(trade.price.toString()).toBe("42000.5");
    });

    it("parses depth delta messages", () => {
      const raw = {
        stream: "btcusdt@depth@100ms",
        data: {
          e: "depthUpdate",
          s: "BTCUSDT",
          E: 1700000000000,
          b: [["42000.00", "1.5"], ["41999.00", "2.0"]],
          a: [["42001.00", "0.8"]],
          u: 999,
        },
      };

      const events = adapter.parseMessage(raw);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("book_delta");

      const delta = events[0].data;
      expect(delta.bids).toHaveLength(2);
      expect(delta.asks).toHaveLength(1);
      expect(delta.seq).toBe(999);
    });

    it("returns empty for unknown streams", () => {
      const events = adapter.parseMessage({ unknown: true });
      expect(events).toHaveLength(0);
    });
  });
});
