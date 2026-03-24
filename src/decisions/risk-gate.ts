import { z } from "zod";
import { defineDecision, createRule, engine } from "@criterionx/core";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("risk-decisions");

// ── Input: what the risk engine knows when evaluating a signal ────

const RiskInputSchema = z.object({
  equity: z.number(),
  peakEquity: z.number(),
  dailyPnl: z.number(),
  drawdownPct: z.number(),
  signalConfidence: z.number(),
  signalDirection: z.enum(["long", "short"]),
  symbol: z.string(),
  hasExistingPosition: z.boolean(),
  existingPositionSide: z.enum(["long", "short", "none"]),
  liquidityScore: z.number(),
  regime: z.string(),
  expectedReturn: z.number(),
});

type RiskInput = z.infer<typeof RiskInputSchema>;

// ── Output: what to do ───────────────────────────────────────────

const RiskOutputSchema = z.object({
  action: z.enum(["allow", "reject", "reduce_size", "circuit_breaker", "kill_switch"]),
  maxPositionPct: z.number().optional(),
  reason: z.string(),
});

type RiskOutput = z.infer<typeof RiskOutputSchema>;

// ── Profile: configurable risk parameters ────────────────────────

const RiskProfileSchema = z.object({
  maxDrawdownPct: z.number(),
  maxDailyLossPct: z.number(),
  killSwitchLossPct: z.number(),
  maxPositionPct: z.number(),
  minLiquidityScore: z.number(),
  minConfidence: z.number(),
  volatileRegimeMaxPosition: z.number(),
});

type RiskProfile = z.infer<typeof RiskProfileSchema>;

// ── Decision rules (evaluated in order, first match wins) ────────

export const riskGateDecision = defineDecision<RiskInput, RiskOutput, RiskProfile>({
  id: "risk-gate",
  version: "1.0.0",
  inputSchema: RiskInputSchema,
  outputSchema: RiskOutputSchema,
  profileSchema: RiskProfileSchema,
  meta: {
    owner: "risk-engine",
    tags: ["risk", "gating", "circuit-breaker"],
    description: "Decides whether a trading signal should be executed, reduced, or rejected",
  },
  rules: [
    // Rule 1: Kill switch — catastrophic drawdown
    createRule<RiskInput, RiskProfile, RiskOutput>({
      id: "kill-switch-drawdown",
      when: (ctx, profile) => ctx.drawdownPct > profile.killSwitchLossPct,
      emit: (_ctx, _profile) => ({
        action: "kill_switch",
        reason: "Catastrophic drawdown — all trading halted",
      }),
      explain: (ctx, profile) =>
        `Drawdown ${(ctx.drawdownPct * 100).toFixed(1)}% exceeds kill switch threshold ${(profile.killSwitchLossPct * 100).toFixed(1)}%`,
    }),

    // Rule 2: Circuit breaker — max drawdown
    createRule<RiskInput, RiskProfile, RiskOutput>({
      id: "circuit-breaker-drawdown",
      when: (ctx, profile) => ctx.drawdownPct > profile.maxDrawdownPct,
      emit: (_ctx, _profile) => ({
        action: "circuit_breaker",
        reason: "Max drawdown exceeded",
      }),
      explain: (ctx, profile) =>
        `Drawdown ${(ctx.drawdownPct * 100).toFixed(2)}% > max ${(profile.maxDrawdownPct * 100).toFixed(1)}%`,
    }),

    // Rule 3: Circuit breaker — daily loss limit
    createRule<RiskInput, RiskProfile, RiskOutput>({
      id: "circuit-breaker-daily-loss",
      when: (ctx, profile) => {
        const maxDailyLoss = ctx.equity * profile.maxDailyLossPct;
        return ctx.dailyPnl < -maxDailyLoss;
      },
      emit: (_ctx, _profile) => ({
        action: "circuit_breaker",
        reason: "Daily loss limit exceeded",
      }),
      explain: (ctx, profile) =>
        `Daily PnL $${ctx.dailyPnl.toFixed(2)} exceeds limit of -$${(ctx.equity * profile.maxDailyLossPct).toFixed(2)}`,
    }),

    // Rule 4: Reject — already positioned in same direction
    createRule<RiskInput, RiskProfile, RiskOutput>({
      id: "reject-same-direction",
      when: (ctx) => ctx.hasExistingPosition && ctx.existingPositionSide === ctx.signalDirection,
      emit: () => ({
        action: "reject",
        reason: "Already positioned in same direction",
      }),
      explain: (ctx) =>
        `Existing ${ctx.existingPositionSide} position on ${ctx.symbol}, signal also ${ctx.signalDirection}`,
    }),

    // Rule 5: Reject — liquidity too low
    createRule<RiskInput, RiskProfile, RiskOutput>({
      id: "reject-low-liquidity",
      when: (ctx, profile) => ctx.liquidityScore < profile.minLiquidityScore,
      emit: () => ({
        action: "reject",
        reason: "Market too illiquid",
      }),
      explain: (ctx, profile) =>
        `Liquidity ${ctx.liquidityScore.toFixed(2)} < min ${profile.minLiquidityScore.toFixed(2)}`,
    }),

    // Rule 6: Reject — confidence too low
    createRule<RiskInput, RiskProfile, RiskOutput>({
      id: "reject-low-confidence",
      when: (ctx, profile) => ctx.signalConfidence < profile.minConfidence,
      emit: () => ({
        action: "reject",
        reason: "Signal confidence too low",
      }),
      explain: (ctx, profile) =>
        `Confidence ${(ctx.signalConfidence * 100).toFixed(0)}% < min ${(profile.minConfidence * 100).toFixed(0)}%`,
    }),

    // Rule 7: Reduce size — volatile regime
    createRule<RiskInput, RiskProfile, RiskOutput>({
      id: "reduce-volatile-regime",
      when: (ctx) => ctx.regime === "volatile",
      emit: (_ctx, profile) => ({
        action: "reduce_size",
        maxPositionPct: profile.volatileRegimeMaxPosition,
        reason: "Volatile regime — reducing position size",
      }),
      explain: (ctx, profile) =>
        `Volatile regime detected, max position reduced to ${(profile.volatileRegimeMaxPosition * 100).toFixed(1)}%`,
    }),

    // Rule 8: Allow — all checks passed
    createRule<RiskInput, RiskProfile, RiskOutput>({
      id: "allow-trade",
      when: () => true, // catch-all
      emit: (_ctx, profile) => ({
        action: "allow",
        maxPositionPct: profile.maxPositionPct,
        reason: "All risk checks passed",
      }),
      explain: () => "All risk checks passed — trade allowed",
    }),
  ],
});

// ── Risk profiles ────────────────────────────────────────────────

export const RISK_PROFILES = {
  conservative: {
    maxDrawdownPct: 0.03,
    maxDailyLossPct: 0.02,
    killSwitchLossPct: 0.07,
    maxPositionPct: 0.01,
    minLiquidityScore: 0.4,
    minConfidence: 0.6,
    volatileRegimeMaxPosition: 0.005,
  },
  moderate: {
    maxDrawdownPct: 0.05,
    maxDailyLossPct: 0.03,
    killSwitchLossPct: 0.10,
    maxPositionPct: 0.02,
    minLiquidityScore: 0.3,
    minConfidence: 0.5,
    volatileRegimeMaxPosition: 0.01,
  },
  aggressive: {
    maxDrawdownPct: 0.10,
    maxDailyLossPct: 0.05,
    killSwitchLossPct: 0.15,
    maxPositionPct: 0.05,
    minLiquidityScore: 0.2,
    minConfidence: 0.4,
    volatileRegimeMaxPosition: 0.025,
  },
} satisfies Record<string, RiskProfile>;

// ── Evaluate helper ──────────────────────────────────────────────

export function evaluateRiskGate(input: RiskInput, profileName: keyof typeof RISK_PROFILES = "moderate") {
  const profile = RISK_PROFILES[profileName];
  const result = engine.run(riskGateDecision, input, { profile });

  // Log the decision trace for auditing
  if (result.data?.action !== "allow") {
    log.info({
      action: result.data?.action,
      reason: result.data?.reason,
      matchedRule: result.meta.matchedRule,
      explanation: result.meta.explanation,
      rules: result.meta.evaluatedRules.map((r) => ({
        id: r.ruleId,
        matched: r.matched,
      })),
    }, "Risk gate decision");
  }

  return result;
}
