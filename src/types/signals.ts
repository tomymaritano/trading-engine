import Decimal from "decimal.js";
import type { Exchange, Symbol, MilliTs } from "./market.js";

// ─── Market Regime ─────────────────────────────────────────────────
export type MarketRegime =
  | "trending_up"
  | "trending_down"
  | "mean_reverting"
  | "volatile"
  | "low_vol"
  | "breakout";

// ─── Feature Vector ────────────────────────────────────────────────
/** Raw features computed per tick/interval for the prediction layer */
export interface FeatureVector {
  ts: MilliTs;
  symbol: Symbol;

  // Order book microstructure
  bidAskSpread: number;
  midPrice: number;
  weightedMidPrice: number;
  bookImbalance: number;        // (bidQty - askQty) / (bidQty + askQty) top N levels
  bookImbalanceTop5: number;
  bookImbalanceTop20: number;
  bookDepthBid: number;         // total bid liquidity in quote
  bookDepthAsk: number;
  bidAskSlope: number;          // slope of cumulative depth curve

  // Trade flow
  tradeImbalance: number;       // net buy volume / total volume (rolling window)
  vwap: number;
  volumeAcceleration: number;   // Δvolume / Δt
  largeTradeRatio: number;      // % of volume from trades > 2σ
  buyPressure: number;          // cumulative buy volume delta
  aggTradeIntensity: number;    // aggressive trades per second

  // Volatility
  realizedVol: number;          // rolling realized volatility
  volOfVol: number;             // volatility of volatility
  returnSkew: number;
  returnKurtosis: number;
  parkinsonVol: number;         // high-low estimator

  // Liquidity
  liquidityScore: number;       // composite: spread + depth + resilience
  spreadVolatility: number;
  depthResilience: number;      // how fast depth recovers after large trade

  // Cross-exchange
  exchangeSpread: number;       // max price diff across exchanges
  leadLagScore: number;         // which exchange leads

  // Regime
  regime: MarketRegime;
  regimeConfidence: number;     // 0-1

  // Funding & liquidations
  fundingRate: number;
  liquidationPressure: number;  // rolling liquidation volume
  openInterestDelta: number;
}

// ─── Trading Signal ────────────────────────────────────────────────
export type SignalDirection = "long" | "short" | "flat";

export interface TradingSignal {
  ts: MilliTs;
  symbol: Symbol;
  exchange: Exchange;
  direction: SignalDirection;
  confidence: number;           // 0-1
  expectedReturn: number;       // predicted return over horizon
  horizon: number;              // seconds
  strategy: string;             // strategy name that generated it
  features: Partial<FeatureVector>;
  metadata?: Record<string, unknown>;
}

// ─── Order Intent ──────────────────────────────────────────────────
export type OrderType = "market" | "limit" | "limit_ioc" | "twap" | "iceberg";

export interface OrderIntent {
  signal: TradingSignal;
  symbol: Symbol;
  exchange: Exchange;
  side: "buy" | "sell";
  qty: Decimal;
  orderType: OrderType;
  limitPrice?: Decimal;
  /** Max acceptable slippage in bps */
  maxSlippageBps: number;
  /** Time-to-live in ms before auto-cancel */
  ttlMs: number;
  /** Risk-adjusted position size from portfolio manager */
  riskBudget: Decimal;
}
