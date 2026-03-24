import Decimal from "decimal.js";
import { ExchangeAdapter } from "./base-adapter.js";
import { WsManager } from "../ingestion/ws-manager.js";
import { bus } from "../utils/event-bus.js";
import type {
  Exchange, Symbol, MarketEvent, Trade, OrderBookDelta, Liquidation, FundingRate,
} from "../types/market.js";

/**
 * Binance USD-M Futures adapter.
 *
 * Why futures instead of spot:
 * - Maker fee: 0.02% (vs 0.10% spot) = 5x cheaper
 * - Liquidation data available (needed for cascade strategy)
 * - Funding rate data (sentiment signal)
 * - Can short without borrowing
 * - Higher volume = better fills
 *
 * Streams:
 * - <symbol>@aggTrade       — aggregated trades
 * - <symbol>@depth@100ms    — order book deltas
 * - <symbol>@forceOrder     — liquidations
 * - <symbol>@markPrice@1s   — mark price + funding rate
 *
 * Base URL: wss://fstream.binance.com/stream
 * REST: https://fapi.binance.com
 */
export class BinanceFuturesAdapter extends ExchangeAdapter {
  readonly exchange: Exchange = "binance";

  normalizeSymbol(symbol: Symbol): string {
    return symbol.replace("-", "").toLowerCase();
  }

  denormalizeSymbol(exchangeSymbol: string): Symbol {
    const upper = exchangeSymbol.toUpperCase();
    for (const quote of ["USDT", "USDC", "BUSD"]) {
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
        `${sym}@aggTrade`,
        `${sym}@depth@100ms`,
        `${sym}@forceOrder`,
        `${sym}@markPrice@1s`,
      ];
    });
    return `wss://fstream.binance.com/stream?streams=${streams.join("/")}`;
  }

  buildSubscriptions(_symbols: Symbol[]): unknown[] {
    return []; // Combined stream URL — no subscription messages needed
  }

  parseMessage(data: unknown): MarketEvent[] {
    const msg = data as Record<string, unknown>;
    if (msg.stream && msg.data) {
      return this.parseStreamMessage(msg.stream as string, msg.data as Record<string, unknown>);
    }
    return [];
  }

  private parseStreamMessage(stream: string, data: Record<string, unknown>): MarketEvent[] {
    if (stream.endsWith("@aggTrade")) return [this.parseTrade(data)];
    if (stream.includes("@depth")) return [this.parseBookDelta(data)];
    if (stream.includes("@forceOrder")) return [this.parseLiquidation(data)];
    if (stream.includes("@markPrice")) return this.parseFunding(data);
    return [];
  }

  private parseTrade(d: Record<string, unknown>): MarketEvent {
    const trade: Trade = {
      exchange: "binance",
      symbol: this.denormalizeSymbol(d.s as string),
      id: String(d.a), // aggTrade ID
      ts: d.T as number,
      localTs: process.hrtime.bigint(),
      price: new Decimal(d.p as string),
      qty: new Decimal(d.q as string),
      side: (d.m as boolean) ? "sell" : "buy",
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
      side: (o.S as string) === "SELL" ? "long" : "short",
      price,
      qty,
      notional: price.mul(qty),
    };
    return { type: "liquidation", data: liq };
  }

  private parseFunding(d: Record<string, unknown>): MarketEvent[] {
    const events: MarketEvent[] = [];

    // Mark price + funding rate
    const rate = d.r as string | undefined;
    if (rate) {
      const funding: FundingRate = {
        exchange: "binance",
        symbol: this.denormalizeSymbol(d.s as string),
        ts: d.E as number,
        rate: new Decimal(rate),
        nextFundingTs: d.T as number,
      };
      events.push({ type: "funding", data: funding });
    }

    return events;
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
