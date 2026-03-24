import type { Exchange, Symbol, MarketEvent } from "../types/market.js";
import type { WsManager } from "../ingestion/ws-manager.js";

/**
 * Base class for exchange adapters.
 *
 * Each adapter is responsible for:
 * 1. Constructing WebSocket subscription payloads for its exchange
 * 2. Parsing raw WS messages into normalized MarketEvent types
 * 3. Handling exchange-specific quirks (symbol format, seq numbers, etc.)
 *
 * The adapter does NOT manage the WS lifecycle — that's WsManager's job.
 */
export abstract class ExchangeAdapter {
  abstract readonly exchange: Exchange;

  /** Convert our normalized symbol (BTC-USDT) to exchange format */
  abstract normalizeSymbol(symbol: Symbol): string;

  /** Convert exchange symbol back to normalized format */
  abstract denormalizeSymbol(exchangeSymbol: string): Symbol;

  /** Build the WebSocket URL for the given symbols and streams */
  abstract buildWsUrl(symbols: Symbol[]): string;

  /** Build subscription payloads sent after WS connects */
  abstract buildSubscriptions(symbols: Symbol[]): unknown[];

  /** Parse a raw WebSocket message into zero or more MarketEvents */
  abstract parseMessage(data: unknown): MarketEvent[];

  /** Create a configured WsManager for this adapter */
  abstract createWsManager(
    symbols: Symbol[],
    onEvent: (event: MarketEvent) => void,
  ): WsManager;
}
