import Decimal from "decimal.js";

// ─── Exchange Identity ─────────────────────────────────────────────
export type Exchange = "binance" | "kraken" | "okx";
export type Symbol = string; // e.g. "BTC-USDT" (normalized)

// ─── Timestamps ────────────────────────────────────────────────────
/** Microsecond-precision timestamp for latency-sensitive paths */
export type MicroTs = bigint;
/** Millisecond timestamp for general use */
export type MilliTs = number;

// ─── Order Book ────────────────────────────────────────────────────
export interface PriceLevel {
  price: Decimal;
  qty: Decimal;
  /** Number of orders at this level (if exchange provides it) */
  orders?: number;
}

export interface OrderBookSnapshot {
  exchange: Exchange;
  symbol: Symbol;
  ts: MilliTs;
  localTs: MicroTs;
  bids: PriceLevel[];
  asks: PriceLevel[];
  /** Sequence number for gap detection */
  seq: number;
}

export interface OrderBookDelta {
  exchange: Exchange;
  symbol: Symbol;
  ts: MilliTs;
  localTs: MicroTs;
  bids: PriceLevel[];
  asks: PriceLevel[];
  seq: number;
}

// ─── Trades ────────────────────────────────────────────────────────
export interface Trade {
  exchange: Exchange;
  symbol: Symbol;
  id: string;
  ts: MilliTs;
  localTs: MicroTs;
  price: Decimal;
  qty: Decimal;
  side: "buy" | "sell";
  /** Was the buyer the maker? */
  isBuyerMaker: boolean;
}

// ─── Liquidations ──────────────────────────────────────────────────
export interface Liquidation {
  exchange: Exchange;
  symbol: Symbol;
  ts: MilliTs;
  side: "long" | "short";
  price: Decimal;
  qty: Decimal;
  /** Notional value in quote currency */
  notional: Decimal;
}

// ─── Funding Rate ──────────────────────────────────────────────────
export interface FundingRate {
  exchange: Exchange;
  symbol: Symbol;
  ts: MilliTs;
  rate: Decimal;
  nextFundingTs: MilliTs;
}

// ─── Kline / OHLCV ────────────────────────────────────────────────
export interface Kline {
  exchange: Exchange;
  symbol: Symbol;
  interval: string;
  openTs: MilliTs;
  closeTs: MilliTs;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  quoteVolume: Decimal;
  trades: number;
}

// ─── Normalized Market Event ───────────────────────────────────────
export type MarketEvent =
  | { type: "trade"; data: Trade }
  | { type: "book_snapshot"; data: OrderBookSnapshot }
  | { type: "book_delta"; data: OrderBookDelta }
  | { type: "liquidation"; data: Liquidation }
  | { type: "funding"; data: FundingRate }
  | { type: "kline"; data: Kline };
