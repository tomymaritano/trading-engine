import Decimal from "decimal.js";
import { ExchangeAdapter } from "./base-adapter.js";
import { WsManager } from "../ingestion/ws-manager.js";
import { bus } from "../utils/event-bus.js";
import type {
  Exchange, Symbol, MarketEvent, Trade, OrderBookDelta, Liquidation,
} from "../types/market.js";

/**
 * Binance adapter.
 *
 * Streams used:
 * - <symbol>@trade          — individual trades
 * - <symbol>@depth@100ms    — order book diff (100ms updates)
 * - <symbol>@forceOrder     — liquidations (futures)
 * - <symbol>@markPrice      — funding rate
 *
 * Binance combined stream URL allows subscribing to multiple streams
 * in a single WebSocket connection.
 */
export class BinanceAdapter extends ExchangeAdapter {
  readonly exchange: Exchange = "binance";

  normalizeSymbol(symbol: Symbol): string {
    // BTC-USDT → btcusdt
    return symbol.replace("-", "").toLowerCase();
  }

  denormalizeSymbol(exchangeSymbol: string): Symbol {
    // btcusdt → BTC-USDT (heuristic: assume USDT quote)
    const upper = exchangeSymbol.toUpperCase();
    for (const quote of ["USDT", "USDC", "BTC", "ETH", "BUSD"]) {
      if (upper.endsWith(quote)) {
        return `${upper.slice(0, -quote.length)}-${quote}`;
      }
    }
    return upper;
  }

  buildWsUrl(symbols: Symbol[]): string {
    const streams = symbols.flatMap((s) => {
      const sym = this.normalizeSymbol(s);
      return [
        `${sym}@trade`,
        `${sym}@depth@100ms`,
      ];
    });
    return `wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`;
  }

  buildSubscriptions(_symbols: Symbol[]): unknown[] {
    // Combined streams don't need subscription messages — streams are in the URL
    return [];
  }

  parseMessage(data: unknown): MarketEvent[] {
    const msg = data as Record<string, unknown>;

    // Combined stream wrapper: { stream: "btcusdt@trade", data: {...} }
    if (msg.stream && msg.data) {
      return this.parseStreamMessage(
        msg.stream as string,
        msg.data as Record<string, unknown>,
      );
    }
    return [];
  }

  private parseStreamMessage(stream: string, data: Record<string, unknown>): MarketEvent[] {
    if (stream.endsWith("@trade")) {
      return [this.parseTrade(data)];
    }
    if (stream.includes("@depth")) {
      return [this.parseBookDelta(data)];
    }
    if (stream.includes("@forceOrder")) {
      return [this.parseLiquidation(data)];
    }
    return [];
  }

  private parseTrade(d: Record<string, unknown>): MarketEvent {
    const trade: Trade = {
      exchange: "binance",
      symbol: this.denormalizeSymbol(d.s as string),
      id: String(d.t),
      ts: d.T as number,
      localTs: process.hrtime.bigint(),
      price: new Decimal(d.p as string),
      qty: new Decimal(d.q as string),
      side: (d.m as boolean) ? "sell" : "buy", // m=true means buyer is maker → trade is a sell
      isBuyerMaker: d.m as boolean,
    };
    return { type: "trade", data: trade };
  }

  private parseBookDelta(d: Record<string, unknown>): MarketEvent {
    const parseLevels = (levels: unknown[][]) =>
      levels.map(([price, qty]) => ({
        price: new Decimal(price as string),
        qty: new Decimal(qty as string),
      }));

    const delta: OrderBookDelta = {
      exchange: "binance",
      symbol: this.denormalizeSymbol(d.s as string),
      ts: d.E as number,
      localTs: process.hrtime.bigint(),
      bids: parseLevels((d.b as unknown[][]) ?? []),
      asks: parseLevels((d.a as unknown[][]) ?? []),
      seq: (d.u as number) ?? 0,
    };
    return { type: "book_delta", data: delta };
  }

  private parseLiquidation(d: Record<string, unknown>): MarketEvent {
    const o = d.o as Record<string, unknown>;
    const price = new Decimal(o.p as string);
    const qty = new Decimal(o.q as string);
    const liq: Liquidation = {
      exchange: "binance",
      symbol: this.denormalizeSymbol(o.s as string),
      ts: o.T as number,
      side: (o.S as string) === "SELL" ? "long" : "short", // SELL liquidation = long position liquidated
      price,
      qty,
      notional: price.mul(qty),
    };
    return { type: "liquidation", data: liq };
  }

  createWsManager(
    symbols: Symbol[],
    onEvent: (event: MarketEvent) => void,
  ): WsManager {
    return new WsManager({
      exchange: "binance",
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
