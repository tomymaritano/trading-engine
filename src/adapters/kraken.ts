import Decimal from "decimal.js";
import { ExchangeAdapter } from "./base-adapter.js";
import { WsManager } from "../ingestion/ws-manager.js";
import { bus } from "../utils/event-bus.js";
import type { Exchange, Symbol, MarketEvent, Trade, OrderBookDelta } from "../types/market.js";

/**
 * Kraken adapter (WebSocket API v2).
 *
 * Kraken uses a subscribe/unsubscribe model over a single WS connection.
 * Symbol format: "BTC/USDT" (slash-separated).
 */
export class KrakenAdapter extends ExchangeAdapter {
  readonly exchange: Exchange = "kraken";

  normalizeSymbol(symbol: Symbol): string {
    // BTC-USDT → BTC/USDT
    return symbol.replace("-", "/");
  }

  denormalizeSymbol(exchangeSymbol: string): Symbol {
    // BTC/USDT → BTC-USDT
    return exchangeSymbol.replace("/", "-");
  }

  buildWsUrl(_symbols: Symbol[]): string {
    return "wss://ws.kraken.com/v2";
  }

  buildSubscriptions(symbols: Symbol[]): unknown[] {
    const krakenSymbols = symbols.map((s) => this.normalizeSymbol(s));
    return [
      {
        method: "subscribe",
        params: { channel: "trade", symbol: krakenSymbols },
      },
      {
        method: "subscribe",
        params: { channel: "book", symbol: krakenSymbols, depth: 25 },
      },
    ];
  }

  parseMessage(data: unknown): MarketEvent[] {
    const msg = data as Record<string, unknown>;

    // Kraken v2: { channel: "trade", type: "update", data: [...] }
    if (msg.channel === "trade" && msg.type === "update") {
      return this.parseTrades(msg.data as Record<string, unknown>[]);
    }
    if (msg.channel === "book" && (msg.type === "update" || msg.type === "snapshot")) {
      return this.parseBook(msg.data as Record<string, unknown>[]);
    }
    return [];
  }

  private parseTrades(trades: Record<string, unknown>[]): MarketEvent[] {
    return trades.map((t) => {
      const trade: Trade = {
        exchange: "kraken",
        symbol: this.denormalizeSymbol(t.symbol as string),
        id: String(t.trade_id ?? t.timestamp),
        ts: new Date(t.timestamp as string).getTime(),
        localTs: process.hrtime.bigint(),
        price: new Decimal(String(t.price)),
        qty: new Decimal(String(t.qty)),
        side: (t.side as string) === "buy" ? "buy" : "sell",
        isBuyerMaker: (t.side as string) === "sell",
      };
      return { type: "trade" as const, data: trade };
    });
  }

  private parseBook(entries: Record<string, unknown>[]): MarketEvent[] {
    return entries.map((entry) => {
      const parseLevels = (levels: unknown[][] | undefined) =>
        (levels ?? []).map(([price, qty]) => ({
          price: new Decimal(String(price)),
          qty: new Decimal(String(qty)),
        }));

      const delta: OrderBookDelta = {
        exchange: "kraken",
        symbol: this.denormalizeSymbol(entry.symbol as string),
        ts: Date.now(),
        localTs: process.hrtime.bigint(),
        bids: parseLevels(entry.bids as unknown[][] | undefined),
        asks: parseLevels(entry.asks as unknown[][] | undefined),
        seq: (entry.checksum as number) ?? 0,
      };
      return { type: "book_delta" as const, data: delta };
    });
  }

  createWsManager(
    symbols: Symbol[],
    onEvent: (event: MarketEvent) => void,
  ): WsManager {
    return new WsManager({
      exchange: "kraken",
      url: this.buildWsUrl(symbols),
      subscriptions: () => this.buildSubscriptions(symbols),
      onMessage: (data) => {
        const events = this.parseMessage(data);
        for (const event of events) {
          onEvent(event);
          bus.emit(`market:${event.type}` as any, event.data as any);
          bus.emit("market:event", event);
        }
      },
    });
  }
}
