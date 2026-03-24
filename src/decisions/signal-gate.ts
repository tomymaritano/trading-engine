import { z } from "zod";
import { defineDecision, createRule, engine } from "@criterionx/core";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("signal-decisions");

// ── Input: signal + market context ───────────────────────────────

const SignalInputSchema = z.object({
  symbol: z.string(),
  direction: z.enum(["long", "short", "flat"]),
  confidence: z.number(),
  strategy: z.string(),
  regime: z.string(),
  regimeConfidence: z.number(),
  liquidityScore: z.number(),
  spreadBps: z.number(),
  tradeImbalance: z.number(),
  bookImbalance: z.number(),
  realizedVol: z.number(),
  signalAge: z.number(), // seconds since last signal
  concurrentSignals: z.number(), // how many strategies agree
});

type SignalInput = z.infer<typeof SignalInputSchema>;

// ── Output ───────────────────────────────────────────────────────

const SignalOutputSchema = z.object({
  action: z.enum(["execute", "reject", "delay", "reduce_confidence"]),
  confidenceMultiplier: z.number().optional(),
  reason: z.string(),
});

type SignalOutput = z.infer<typeof SignalOutputSchema>;

// ── Profile ──────────────────────────────────────────────────────

const SignalProfileSchema = z.object({
  maxSpreadBps: z.number(),
  minLiquidity: z.number(),
  minConfidence: z.number(),
  minRegimeConfidence: z.number(),
  cooldownSeconds: z.number(),
  allowMeanReversionInTrend: z.boolean(),
  allowMomentumInLowVol: z.boolean(),
});

type SignalProfile = z.infer<typeof SignalProfileSchema>;

// ── Decision rules ───────────────────────────────────────────────

export const signalGateDecision = defineDecision<SignalInput, SignalOutput, SignalProfile>({
  id: "signal-gate",
  version: "1.0.0",
  inputSchema: SignalInputSchema,
  outputSchema: SignalOutputSchema,
  profileSchema: SignalProfileSchema,
  meta: {
    owner: "strategy-orchestrator",
    tags: ["signal", "gating", "regime"],
    description: "Decides whether a strategy signal should be forwarded to the risk engine",
  },
  rules: [
    // Rule 1: Reject flat signals
    createRule<SignalInput, SignalProfile, SignalOutput>({
      id: "reject-flat",
      when: (ctx) => ctx.direction === "flat",
      emit: () => ({
        action: "reject",
        reason: "Flat signal — no trade",
      }),
      explain: () => "Signal direction is flat, nothing to trade",
    }),

    // Rule 2: Reject if spread is too wide
    createRule<SignalInput, SignalProfile, SignalOutput>({
      id: "reject-wide-spread",
      when: (ctx, profile) => ctx.spreadBps > profile.maxSpreadBps,
      emit: () => ({
        action: "reject",
        reason: "Spread too wide for reliable execution",
      }),
      explain: (ctx, profile) =>
        `Spread ${ctx.spreadBps.toFixed(1)} bps > max ${profile.maxSpreadBps} bps`,
    }),

    // Rule 3: Reject if too illiquid
    createRule<SignalInput, SignalProfile, SignalOutput>({
      id: "reject-illiquid",
      when: (ctx, profile) => ctx.liquidityScore < profile.minLiquidity,
      emit: () => ({
        action: "reject",
        reason: "Market too illiquid",
      }),
      explain: (ctx, profile) =>
        `Liquidity ${ctx.liquidityScore.toFixed(2)} < min ${profile.minLiquidity.toFixed(2)}`,
    }),

    // Rule 4: Reject if confidence too low
    createRule<SignalInput, SignalProfile, SignalOutput>({
      id: "reject-low-confidence",
      when: (ctx, profile) => ctx.confidence < profile.minConfidence,
      emit: () => ({
        action: "reject",
        reason: "Confidence below threshold",
      }),
      explain: (ctx, profile) =>
        `Confidence ${(ctx.confidence * 100).toFixed(0)}% < min ${(profile.minConfidence * 100).toFixed(0)}%`,
    }),

    // Rule 5: Delay if cooldown not met
    createRule<SignalInput, SignalProfile, SignalOutput>({
      id: "delay-cooldown",
      when: (ctx, profile) => ctx.signalAge < profile.cooldownSeconds,
      emit: () => ({
        action: "delay",
        reason: "Cooldown period not elapsed",
      }),
      explain: (ctx, profile) =>
        `Signal age ${ctx.signalAge}s < cooldown ${profile.cooldownSeconds}s`,
    }),

    // Rule 6: Reject mean-reversion signals in trending regime (unless allowed)
    createRule<SignalInput, SignalProfile, SignalOutput>({
      id: "reject-meanrev-in-trend",
      when: (ctx, profile) => {
        if (profile.allowMeanReversionInTrend) return false;
        const isTrending = ctx.regime === "trending_up" || ctx.regime === "trending_down";
        const isCounterTrend =
          (ctx.regime === "trending_up" && ctx.direction === "short") ||
          (ctx.regime === "trending_down" && ctx.direction === "long");
        return isTrending && isCounterTrend && ctx.strategy.includes("mean_reversion");
      },
      emit: () => ({
        action: "reject",
        reason: "Counter-trend signal blocked in trending regime",
      }),
      explain: (ctx) =>
        `${ctx.strategy} ${ctx.direction} signal rejected: market is ${ctx.regime}`,
    }),

    // Rule 7: Reduce confidence if regime is uncertain
    createRule<SignalInput, SignalProfile, SignalOutput>({
      id: "reduce-uncertain-regime",
      when: (ctx, profile) => ctx.regimeConfidence < profile.minRegimeConfidence,
      emit: () => ({
        action: "reduce_confidence",
        confidenceMultiplier: 0.8,
        reason: "Regime uncertain — reducing confidence",
      }),
      explain: (ctx, profile) =>
        `Regime confidence ${(ctx.regimeConfidence * 100).toFixed(0)}% < min ${(profile.minRegimeConfidence * 100).toFixed(0)}%`,
    }),

    // Rule 8: Boost if multiple strategies agree
    createRule<SignalInput, SignalProfile, SignalOutput>({
      id: "boost-concurrent",
      when: (ctx) => ctx.concurrentSignals > 1,
      emit: (ctx) => ({
        action: "execute",
        confidenceMultiplier: 1 + 0.1 * (ctx.concurrentSignals - 1),
        reason: `${ctx.concurrentSignals} strategies agree — boosted`,
      }),
      explain: (ctx) =>
        `${ctx.concurrentSignals} strategies emit concordant ${ctx.direction} signal`,
    }),

    // Rule 9: Default — execute
    createRule<SignalInput, SignalProfile, SignalOutput>({
      id: "execute-default",
      when: () => true,
      emit: () => ({
        action: "execute",
        confidenceMultiplier: 1.0,
        reason: "Signal passed all gates",
      }),
      explain: () => "All signal quality checks passed",
    }),
  ],
});

// ── Profiles ─────────────────────────────────────────────────────

export const SIGNAL_PROFILES = {
  strict: {
    maxSpreadBps: 5,
    minLiquidity: 0.5,
    minConfidence: 0.6,
    minRegimeConfidence: 0.6,
    cooldownSeconds: 30,
    allowMeanReversionInTrend: false,
    allowMomentumInLowVol: false,
  },
  balanced: {
    maxSpreadBps: 10,
    minLiquidity: 0.3,
    minConfidence: 0.45,
    minRegimeConfidence: 0.4,
    cooldownSeconds: 15,
    allowMeanReversionInTrend: false,
    allowMomentumInLowVol: true,
  },
  aggressive: {
    maxSpreadBps: 20,
    minLiquidity: 0.2,
    minConfidence: 0.35,
    minRegimeConfidence: 0.3,
    cooldownSeconds: 5,
    allowMeanReversionInTrend: true,
    allowMomentumInLowVol: true,
  },
} satisfies Record<string, SignalProfile>;

// ── Evaluate helper ──────────────────────────────────────────────

export function evaluateSignalGate(input: SignalInput, profileName: keyof typeof SIGNAL_PROFILES = "balanced") {
  const profile = SIGNAL_PROFILES[profileName];
  const result = engine.run(signalGateDecision, input, { profile });

  if (result.data?.action !== "execute") {
    log.debug({
      action: result.data?.action,
      reason: result.data?.reason,
      symbol: input.symbol,
      strategy: input.strategy,
      matchedRule: result.meta.matchedRule,
    }, "Signal gate decision");
  }

  return result;
}
