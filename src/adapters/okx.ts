import Decimal from "decimal.js";
import { ExchangeAdapter } from "./base-adapter.js";
import { WsManager } from "../ingestion/ws-manager.js";
import { bus } from "../utils/event-bus.js";
import type { Exchange, Symbol, MarketEvent, Trade, OrderBookDelta, Liquidation } from "../types/market.js";

/**
 * OKX adapter.
 *
 * OKX uses a subscribe model with { op: "subscribe", args: [...] }.
 * Symbol format: "BTC-USDT" (already matches our normalized format).
 * OKX provides liquidation data via the "liquidation-orders" channel.
 */
export class OkxAdapter extends ExchangeAdapter {
  readonly exchange: Exchange = "okx";

  normalizeSymbol(symbol: Symbol): string {
    // BTC-USDT → BTC-USDT (OKX uses our format)
    return symbol;
  }

  denormalizeSymbol(exchangeSymbol: string): Symbol {
    return exchangeSymbol;
  }

  buildWsUrl(_symbols: Symbol[]): string {
    return "wss://ws.okx.com:8443/ws/v5/public";
  }

  buildSubscriptions(symbols: Symbol[]): unknown[] {
    const tradeArgs = symbols.map((s) => ({ channel: "trades", instId: s }));
    const bookArgs = symbols.map((s) => ({ channel: "books5", instId: s })); // top 5 book
    const liqArgs = symbols.map((s) => ({ channel: "liquidation-orders", instType: "SWAP", instFamily: s.split("-")[0] + "-USDT" }));

    return [
      { op: "subscribe", args: tradeArgs },
      { op: "subscribe", args: bookArgs },
      { op: "subscribe", args: liqArgs },
    ];
  }

  parseMessage(data: unknown): MarketEvent[] {
    const msg = data as Record<string, unknown>;

    // OKX push: { arg: { channel, instId }, data: [...] }
    if (!msg.arg || !msg.data) return [];

    const arg = msg.arg as Record<string, string>;
    const channel = arg.channel;
    const payload = msg.data as Record<string, unknown>[];

    if (channel === "trades") return this.parseTrades(payload, arg.instId);
    if (channel.startsWith("books")) return this.parseBook(payload, arg.instId);
    if (channel === "liquidation-orders") return this.parseLiquidations(payload);

    return [];
  }

  private parseTrades(trades: Record<string, unknown>[], instId: string): MarketEvent[] {
    return trades.map((t) => {
      const trade: Trade = {
        exchange: "okx",
        symbol: this.denormalizeSymbol(instId),
        id: String(t.tradeId),
        ts: Number(t.ts),
        localTs: process.hrtime.bigint(),
        price: new Decimal(t.px as string),
        qty: new Decimal(t.sz as string),
        side: (t.side as string) === "buy" ? "buy" : "sell",
        isBuyerMaker: (t.side as string) === "sell",
      };
      return { type: "trade" as const, data: trade };
    });
  }

  private parseBook(entries: Record<string, unknown>[], instId: string): MarketEvent[] {
    return entries.map((entry) => {
      // OKX books5 format: [[price, qty, liquidatedOrders, numOrders], ...]
      const parseLevels = (levels: unknown[][]) =>
        levels.map(([price, qty]) => ({
          price: new Decimal(price as string),
          qty: new Decimal(qty as string),
        }));

      const delta: OrderBookDelta = {
        exchange: "okx",
        symbol: this.denormalizeSymbol(instId),
        ts: Number(entry.ts),
        localTs: process.hrtime.bigint(),
        bids: parseLevels((entry.bids as unknown[][]) ?? []),
        asks: parseLevels((entry.asks as unknown[][]) ?? []),
        seq: Number(entry.seqId ?? 0),
      };
      return { type: "book_delta" as const, data: delta };
    });
  }

  private parseLiquidations(entries: Record<string, unknown>[]): MarketEvent[] {
    return entries.flatMap((entry) => {
      const details = (entry.details as Record<string, unknown>[]) ?? [];
      return details.map((d) => {
        const price = new Decimal(d.bkPx as string);
        const qty = new Decimal(d.sz as string);
        const liq: Liquidation = {
          exchange: "okx",
          symbol: entry.instFamily as string,
          ts: Number(d.ts),
          side: (d.side as string) === "sell" ? "long" : "short",
          price,
          qty,
          notional: price.mul(qty),
        };
        return { type: "liquidation" as const, data: liq };
      });
    });
  }

  createWsManager(
    symbols: Symbol[],
    onEvent: (event: MarketEvent) => void,
  ): WsManager {
    return new WsManager({
      exchange: "okx",
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
