import Decimal from "decimal.js";
import { ExchangeAdapter } from "./base-adapter.js";
import { WsManager } from "../ingestion/ws-manager.js";
import { bus } from "../utils/event-bus.js";
import type { Exchange, Symbol, MarketEvent, Trade, OrderBookSnapshot } from "../types/market.js";

/**
 * dYdX v4 Adapter (Cosmos-based, decentralized)
 *
 * Why dYdX?
 * - 0% maker fee (our edge of 1.37 bps becomes pure profit)
 * - 0.05% taker fee (still low)
 * - Decentralized — no KYC for small amounts
 * - Deep liquidity on ETH-USD, BTC-USD
 *
 * dYdX v4 WebSocket API:
 * - wss://indexer.dydx.trade/v4/ws
 * - Channels: trades, orderbook, markets
 *
 * Symbol format: "ETH-USD" (not USDT)
 */
export class DydxAdapter extends ExchangeAdapter {
  readonly exchange: Exchange = "binance"; // TODO: add "dydx" to Exchange type

  normalizeSymbol(symbol: Symbol): string {
    // BTC-USDT → BTC-USD (dYdX uses USD, not USDT)
    return symbol.replace("-USDT", "-USD").replace("-USDC", "-USD");
  }

  denormalizeSymbol(exchangeSymbol: string): Symbol {
    // BTC-USD → BTC-USDT (convert back to our format)
    return exchangeSymbol.replace("-USD", "-USDT");
  }

  buildWsUrl(_symbols: Symbol[]): string {
    return "wss://indexer.dydx.trade/v4/ws";
  }

  buildSubscriptions(symbols: Symbol[]): unknown[] {
    const subs: unknown[] = [];

    for (const sym of symbols) {
      const dydxSym = this.normalizeSymbol(sym);

      // Subscribe to trades
      subs.push({
        type: "subscribe",
        channel: "v4_trades",
        id: dydxSym,
      });

      // Subscribe to order book
      subs.push({
        type: "subscribe",
        channel: "v4_orderbook",
        id: dydxSym,
      });
    }

    return subs;
  }

  parseMessage(data: unknown): MarketEvent[] {
    const msg = data as Record<string, unknown>;
    const channel = msg.channel as string | undefined;
    const type = msg.type as string | undefined;

    if (!channel || type === "connected" || type === "subscribed") return [];

    if (channel === "v4_trades") return this.parseTrades(msg);
    if (channel === "v4_orderbook") return this.parseOrderBook(msg);

    return [];
  }

  private parseTrades(msg: Record<string, unknown>): MarketEvent[] {
    const contents = msg.contents as Record<string, unknown> | undefined;
    if (!contents) return [];

    const trades = (contents.trades ?? []) as Array<{
      id: string;
      side: string;
      size: string;
      price: string;
      createdAt: string;
    }>;

    const symbol = this.denormalizeSymbol(msg.id as string);

    return trades.map((t) => {
      const trade: Trade = {
        exchange: this.exchange,
        symbol,
        id: t.id,
        ts: new Date(t.createdAt).getTime(),
        localTs: process.hrtime.bigint(),
        price: new Decimal(t.price),
        qty: new Decimal(t.size),
        side: t.side === "BUY" ? "buy" : "sell",
        isBuyerMaker: t.side === "SELL",
      };
      return { type: "trade" as const, data: trade };
    });
  }

  private parseOrderBook(msg: Record<string, unknown>): MarketEvent[] {
    const contents = msg.contents as Record<string, unknown> | undefined;
    if (!contents) return [];

    const bids = (contents.bids ?? []) as Array<{ price: string; size: string }>;
    const asks = (contents.asks ?? []) as Array<{ price: string; size: string }>;

    if (bids.length === 0 && asks.length === 0) return [];

    const symbol = this.denormalizeSymbol(msg.id as string);

    const snapshot: OrderBookSnapshot = {
      exchange: this.exchange,
      symbol,
      ts: Date.now(),
      localTs: process.hrtime.bigint(),
      bids: bids.map((b) => ({ price: new Decimal(b.price), qty: new Decimal(b.size) })),
      asks: asks.map((a) => ({ price: new Decimal(a.price), qty: new Decimal(a.size) })),
      seq: 0,
    };

    return [{ type: "book_snapshot" as const, data: snapshot }];
  }

  createWsManager(
    symbols: Symbol[],
    onEvent: (event: MarketEvent) => void,
  ): WsManager {
    return new WsManager({
      exchange: this.exchange,
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
