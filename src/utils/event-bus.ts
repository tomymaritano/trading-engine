import EventEmitter from "eventemitter3";
import type { MarketEvent, Trade, OrderBookSnapshot, OrderBookDelta, Liquidation, FundingRate } from "../types/market.js";
import type { FeatureVector, TradingSignal, OrderIntent } from "../types/signals.js";

/**
 * Typed event bus — the nervous system of the trading engine.
 *
 * Every layer publishes and subscribes through this bus, keeping
 * components decoupled. The bus is synchronous within a single
 * process; for multi-process deployments, swap the backing store
 * to Redis Streams.
 *
 * Event flow:
 *   Adapters → market.* → StreamProcessor → feature.* → PredictionLayer
 *             → signal.* → RiskEngine → order.* → ExecutionEngine
 */
interface EventMap {
  // Raw market data from exchange adapters
  "market:trade": (trade: Trade) => void;
  "market:book_snapshot": (book: OrderBookSnapshot) => void;
  "market:book_delta": (delta: OrderBookDelta) => void;
  "market:liquidation": (liq: Liquidation) => void;
  "market:funding": (funding: FundingRate) => void;
  "market:event": (event: MarketEvent) => void;

  // Computed features from the feature engine
  "feature:vector": (features: FeatureVector) => void;
  "feature:regime_change": (data: { symbol: string; from: string; to: string; confidence: number }) => void;
  "feature:anomaly": (data: { symbol: string; type: string; severity: number; details: string }) => void;

  // Trading signals from the prediction layer
  "signal:new": (signal: TradingSignal) => void;
  "signal:expired": (signal: TradingSignal) => void;

  // Orders from the risk engine / execution
  "order:intent": (intent: OrderIntent) => void;
  "order:submitted": (data: { id: string; intent: OrderIntent }) => void;
  "order:filled": (data: { id: string; fillPrice: number; fillQty: number; slippageBps: number; symbol: string; exchange: string; side: string; direction: string }) => void;
  "order:cancelled": (data: { id: string; reason: string }) => void;
  "order:rejected": (data: { id: string; reason: string }) => void;

  // Risk events
  "risk:circuit_breaker": (data: { reason: string; ts: number }) => void;
  "risk:kill_switch": (data: { reason: string; ts: number }) => void;
  "risk:warning": (data: { type: string; message: string }) => void;
  "risk:decision": (data: { symbol: string; action: string; reason: string; explanation: string; matchedRule: string; confidence: number; direction: string }) => void;

  // Execution events
  "trailing:update": (stops: Array<{ symbol: string; side: string; activated: boolean; stopPrice: number; entryPrice: number; highWaterMark: number; lowWaterMark: number; trailingPct: number }>) => void;

  // System lifecycle
  "system:ready": () => void;
  "system:shutdown": (reason: string) => void;
  "system:error": (error: Error) => void;

  // Connection status
  "ws:connected": (data: { exchange: string }) => void;
  "ws:disconnected": (data: { exchange: string; reason: string }) => void;
  "ws:reconnecting": (data: { exchange: string; attempt: number }) => void;
}

class TradingEventBus extends EventEmitter<EventMap> {
  private _eventCounts = new Map<string, number>();
  private _startTs = Date.now();

  // @ts-expect-error — eventemitter3 generic signature is overly restrictive for overrides
  override emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): boolean {
    this._eventCounts.set(event as string, (this._eventCounts.get(event as string) ?? 0) + 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.emit(event, ...(args as any));
  }

  /** Events-per-second for a given channel */
  throughput(event: keyof EventMap): number {
    const count = this._eventCounts.get(event as string) ?? 0;
    const elapsed = (Date.now() - this._startTs) / 1000;
    return elapsed > 0 ? count / elapsed : 0;
  }

  /** Total event counts for monitoring */
  stats(): Record<string, number> {
    return Object.fromEntries(this._eventCounts);
  }

  resetStats(): void {
    this._eventCounts.clear();
    this._startTs = Date.now();
  }
}

/** Singleton event bus — import this everywhere */
export const bus = new TradingEventBus();
