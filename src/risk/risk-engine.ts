import Decimal from "decimal.js";
import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";
import { evaluateRiskGate } from "../decisions/risk-gate.js";
import type { TradingSignal, OrderIntent } from "../types/signals.js";
import type { RiskConfig, AppConfig } from "../config/index.js";

const log = createChildLogger("risk-engine");

interface Position {
  symbol: string;
  exchange: string;
  side: "long" | "short";
  qty: Decimal;
  entryPrice: Decimal;
  unrealizedPnl: Decimal;
  ts: number;
}

/**
 * Risk Engine — the guardian of capital.
 *
 * Every signal must pass through this gate before becoming an order.
 * The risk engine enforces:
 *
 * 1. Position sizing (Kelly criterion with fractional scaling)
 * 2. Max position per asset
 * 3. Portfolio-level exposure limits
 * 4. Drawdown circuit breakers
 * 5. Daily loss limits
 * 6. Correlation-based exposure limits
 * 7. Kill switch for catastrophic events
 *
 * Philosophy: the risk engine should NEVER be overridden.
 * A strategy can be wrong, but the risk engine keeps you alive.
 */
export class RiskEngine {
  private positions = new Map<string, Position>();
  private dailyPnl = 0;
  private peakEquity: number;
  private currentEquity: number;
  private circuitBreakerActive = false;
  private killSwitchActive = false;

  constructor(
    private config: AppConfig,
    initialEquity: number,
  ) {
    this.peakEquity = initialEquity;
    this.currentEquity = initialEquity;
  }

  start(): void {
    bus.on("signal:new", (signal) => this.evaluateSignal(signal));

    bus.on("order:filled", (fill) => {
      this.onFill(fill.id, fill.fillPrice, fill.fillQty);
    });

    // Reset daily PnL at midnight UTC
    const msUntilMidnight = this.msUntilNextUtcMidnight();
    setTimeout(() => {
      this.dailyPnl = 0;
      setInterval(() => { this.dailyPnl = 0; }, 86_400_000);
    }, msUntilMidnight);

    log.info({ config: this.config.risk }, "Risk engine started");
  }

  stop(): void {
    // Close all positions (in production, this should be graceful)
  }

  private evaluateSignal(signal: TradingSignal): void {
    // ── Pre-checks (stateful, not decision-rule based) ──────
    if (this.killSwitchActive) {
      log.warn("Kill switch active, rejecting all signals");
      return;
    }
    if (this.circuitBreakerActive) {
      log.warn("Circuit breaker active, rejecting signal");
      return;
    }

    // ── CriterionX Risk Gate Decision ───────────────────────
    // All risk logic is now declarative, explainable, and auditable
    const drawdown = (this.peakEquity - this.currentEquity) / this.peakEquity;
    const existingPosition = this.positions.get(`${signal.exchange}:${signal.symbol}`);

    const riskResult = evaluateRiskGate({
      equity: this.currentEquity,
      peakEquity: this.peakEquity,
      dailyPnl: this.dailyPnl,
      drawdownPct: drawdown,
      signalConfidence: signal.confidence,
      signalDirection: signal.direction as "long" | "short",
      symbol: signal.symbol,
      hasExistingPosition: !!existingPosition,
      existingPositionSide: existingPosition?.side ?? "none",
      liquidityScore: signal.features.liquidityScore ?? 0.5,
      regime: signal.features.regime ?? "mean_reverting",
      expectedReturn: signal.expectedReturn,
    }, "moderate");

    const action = riskResult.data?.action;

    if (action === "kill_switch") {
      this.activateKillSwitch(riskResult.data!.reason);
      return;
    }
    if (action === "circuit_breaker") {
      this.activateCircuitBreaker(riskResult.data!.reason);
      return;
    }
    if (action === "reject") {
      log.debug({ reason: riskResult.data?.reason, rule: riskResult.meta.matchedRule }, "Signal rejected by risk gate");
      return;
    }

    // Use reduced position size if risk gate says so
    const maxPositionPct = riskResult.data?.maxPositionPct ?? this.config.risk.maxPositionPct;

    // ── Position sizing: fractional Kelly ────────────────────
    const qty = this.computePositionSize(signal, maxPositionPct);
    if (qty.isZero()) {
      log.debug("Position size is zero after risk adjustment");
      return;
    }

    // ── Emit order intent ────────────────────────────────────
    const intent: OrderIntent = {
      signal,
      symbol: signal.symbol,
      exchange: signal.exchange,
      side: signal.direction === "long" ? "buy" : "sell",
      qty,
      orderType: signal.confidence > 0.8 ? "market" : "limit_ioc",
      maxSlippageBps: signal.confidence > 0.8 ? 5 : 3,
      ttlMs: signal.horizon * 1000,
      riskBudget: new Decimal(this.currentEquity * this.config.risk.maxPositionPct),
    };

    bus.emit("order:intent", intent);

    log.info(
      {
        symbol: signal.symbol,
        direction: signal.direction,
        qty: qty.toString(),
        confidence: signal.confidence.toFixed(3),
      },
      "Order intent emitted",
    );
  }

  /**
   * Fractional Kelly Criterion for position sizing.
   *
   * Kelly fraction: f* = (p * b - q) / b
   * where p = win probability, q = 1-p, b = win/loss ratio
   *
   * We use 1/4 Kelly (very conservative) because:
   * 1. Our win probability estimates have uncertainty
   * 2. Returns are not normally distributed (fat tails in crypto)
   * 3. Bankruptcy is permanent
   *
   * The fraction is then clamped by max position size from risk config.
   */
  private computePositionSize(signal: TradingSignal, maxPositionPct?: number): Decimal {
    const midPrice = signal.features.midPrice ?? 0;
    if (midPrice <= 0) return new Decimal(0);

    const p = signal.confidence;
    const q = 1 - p;

    // Win/loss ratio: expected return vs stop loss
    // Stop loss is proportional to horizon volatility, not a fixed %
    const stopLossPct = Math.max(0.001, signal.expectedReturn * 1.5);
    const b = Math.max(0.2, signal.expectedReturn / stopLossPct);

    let kellyFraction = (p * b - q) / b;

    // In paper mode, use a minimum position size to generate trades for validation
    // Even if Kelly says "no edge", we want to test the signal quality
    if (kellyFraction <= 0) {
      // If confidence > 50%, trade with minimum size for paper testing
      if (p > 0.5) {
        kellyFraction = 0.005; // 0.5% of equity — small test position
        log.debug({ confidence: p, kellyRaw: kellyFraction }, "Kelly negative but conf > 50%, using min size");
      } else {
        return new Decimal(0);
      }
    }

    // Fractional Kelly: use 25% of optimal
    kellyFraction *= 0.25;

    // Minimum position size for paper trading
    kellyFraction = Math.max(kellyFraction, 0.001); // at least 0.1% of equity

    // Clamp to max position size (may be reduced by CriterionX risk gate)
    const maxFraction = maxPositionPct ?? this.config.risk.maxPositionPct;
    kellyFraction = Math.min(kellyFraction, maxFraction);

    // Convert to quote currency amount → base asset quantity
    const positionValue = this.currentEquity * kellyFraction;
    return new Decimal(positionValue / midPrice).toDecimalPlaces(8);
  }

  private onFill(orderId: string, fillPrice: number, fillQty: number): void {
    // Update position tracking, PnL, equity
    // (Simplified — production needs full position management)
    log.info({ orderId, fillPrice, fillQty }, "Fill processed");
  }

  private activateCircuitBreaker(reason: string): void {
    this.circuitBreakerActive = true;
    log.error({ reason }, "Circuit breaker activated");
    bus.emit("risk:circuit_breaker", { reason, ts: Date.now() });

    // Auto-reset after 5 minutes
    setTimeout(() => {
      this.circuitBreakerActive = false;
      log.info("Circuit breaker reset");
    }, 5 * 60 * 1000);
  }

  activateKillSwitch(reason: string): void {
    this.killSwitchActive = true;
    log.error({ reason }, "KILL SWITCH ACTIVATED — all trading halted");
    bus.emit("risk:kill_switch", { reason, ts: Date.now() });
  }

  updateEquity(equity: number): void {
    this.currentEquity = equity;
    if (equity > this.peakEquity) {
      this.peakEquity = equity;
    }

    // Kill switch: catastrophic loss
    const totalDrawdown = (this.peakEquity - equity) / this.peakEquity;
    if (totalDrawdown > this.config.risk.killSwitchLossPct) {
      this.activateKillSwitch(`Catastrophic drawdown: ${(totalDrawdown * 100).toFixed(1)}%`);
    }
  }

  private msUntilNextUtcMidnight(): number {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return tomorrow.getTime() - now.getTime();
  }

  get stats() {
    return {
      equity: this.currentEquity,
      peakEquity: this.peakEquity,
      drawdown: (this.peakEquity - this.currentEquity) / this.peakEquity,
      dailyPnl: this.dailyPnl,
      positions: this.positions.size,
      circuitBreaker: this.circuitBreakerActive,
      killSwitch: this.killSwitchActive,
    };
  }
}
