import { z } from "zod";
import { defineDecision, createRule, engine } from "@criterionx/core";

// ── Input: market metrics ────────────────────────────────────────

const RegimeInputSchema = z.object({
  realizedVol: z.number(),
  volOfVol: z.number(),
  tradeImbalance: z.number(),
  trendSlope: z.number(),
  volumeAcceleration: z.number(),
  bookImbalance: z.number(),
  spreadVolatility: z.number(),
});

type RegimeInput = z.infer<typeof RegimeInputSchema>;

// ── Output ───────────────────────────────────────────────────────

const RegimeOutputSchema = z.object({
  regime: z.enum(["trending_up", "trending_down", "mean_reverting", "volatile", "low_vol", "breakout"]),
  confidence: z.number(),
  description: z.string(),
});

type RegimeOutput = z.infer<typeof RegimeOutputSchema>;

// ── Profile: tunable thresholds ──────────────────────────────────

const RegimeProfileSchema = z.object({
  highVolThreshold: z.number(),       // vol above this = high vol regime
  lowVolThreshold: z.number(),        // vol below this = low vol
  trendThresholdHighVol: z.number(),  // trend slope for trending (high vol)
  trendThresholdModVol: z.number(),   // trend slope for trending (moderate vol)
  meanRevImbalanceThreshold: z.number(), // imbalance for mean-reverting
  breakoutVolAccelThreshold: z.number(), // volume accel for breakout
  breakoutSpreadThreshold: z.number(),   // spread widening for breakout
});

type RegimeProfile = z.infer<typeof RegimeProfileSchema>;

// ── Decision ─────────────────────────────────────────────────────

export const regimeDecision = defineDecision<RegimeInput, RegimeOutput, RegimeProfile>({
  id: "regime-classifier",
  version: "1.0.0",
  inputSchema: RegimeInputSchema,
  outputSchema: RegimeOutputSchema,
  profileSchema: RegimeProfileSchema,
  meta: {
    owner: "feature-engine",
    tags: ["regime", "classification", "volatility"],
    description: "Classifies current market regime from microstructure features",
  },
  rules: [
    // Rule 1: Breakout — vol expanding + volume surging + spread widening
    createRule<RegimeInput, RegimeProfile, RegimeOutput>({
      id: "breakout",
      when: (ctx, p) =>
        ctx.volumeAcceleration > p.breakoutVolAccelThreshold &&
        ctx.spreadVolatility > p.breakoutSpreadThreshold &&
        ctx.realizedVol > p.lowVolThreshold,
      emit: (ctx) => ({
        regime: "breakout",
        confidence: Math.min(0.9, 0.5 + Math.abs(ctx.volumeAcceleration) * 2),
        description: "Breakout: volume surging with spread expansion",
      }),
      explain: (ctx, p) =>
        `Volume accel ${ctx.volumeAcceleration.toFixed(3)} > ${p.breakoutVolAccelThreshold}, spread vol ${ctx.spreadVolatility.toFixed(2)} > ${p.breakoutSpreadThreshold}`,
    }),

    // Rule 2: High vol + trending
    createRule<RegimeInput, RegimeProfile, RegimeOutput>({
      id: "trending-high-vol",
      when: (ctx, p) =>
        ctx.realizedVol > p.highVolThreshold &&
        Math.abs(ctx.trendSlope) > p.trendThresholdHighVol,
      emit: (ctx) => ({
        regime: ctx.trendSlope > 0 ? "trending_up" : "trending_down",
        confidence: Math.min(0.9, Math.abs(ctx.trendSlope) * 100),
        description: `Strong trend ${ctx.trendSlope > 0 ? "up" : "down"} in high volatility`,
      }),
      explain: (ctx, p) =>
        `Vol ${(ctx.realizedVol * 100).toFixed(1)}% > ${(p.highVolThreshold * 100).toFixed(1)}%, trend ${ctx.trendSlope.toFixed(4)} > ${p.trendThresholdHighVol}`,
    }),

    // Rule 3: High vol + no trend = pure volatility
    createRule<RegimeInput, RegimeProfile, RegimeOutput>({
      id: "volatile",
      when: (ctx, p) => ctx.realizedVol > p.highVolThreshold,
      emit: (ctx) => ({
        regime: "volatile",
        confidence: Math.min(0.85, ctx.realizedVol * 30),
        description: "High volatility without clear direction",
      }),
      explain: (ctx, p) =>
        `Vol ${(ctx.realizedVol * 100).toFixed(1)}% > high threshold ${(p.highVolThreshold * 100).toFixed(1)}%, no clear trend`,
    }),

    // Rule 4: Low vol
    createRule<RegimeInput, RegimeProfile, RegimeOutput>({
      id: "low-vol",
      when: (ctx, p) => ctx.realizedVol < p.lowVolThreshold,
      emit: () => ({
        regime: "low_vol",
        confidence: 0.7,
        description: "Low volatility — compressed range",
      }),
      explain: (ctx, p) =>
        `Vol ${(ctx.realizedVol * 100).toFixed(1)}% < low threshold ${(p.lowVolThreshold * 100).toFixed(1)}%`,
    }),

    // Rule 5: Strong imbalance → mean reverting
    createRule<RegimeInput, RegimeProfile, RegimeOutput>({
      id: "mean-reverting",
      when: (ctx, p) => Math.abs(ctx.tradeImbalance) > p.meanRevImbalanceThreshold,
      emit: (ctx) => ({
        regime: "mean_reverting",
        confidence: Math.abs(ctx.tradeImbalance),
        description: "Strong directional imbalance — likely to revert",
      }),
      explain: (ctx, p) =>
        `Trade imbalance ${ctx.tradeImbalance.toFixed(2)} > ${p.meanRevImbalanceThreshold} threshold`,
    }),

    // Rule 6: Moderate vol + trending
    createRule<RegimeInput, RegimeProfile, RegimeOutput>({
      id: "trending-moderate-vol",
      when: (ctx, p) => Math.abs(ctx.trendSlope) > p.trendThresholdModVol,
      emit: (ctx) => ({
        regime: ctx.trendSlope > 0 ? "trending_up" : "trending_down",
        confidence: Math.min(0.75, Math.abs(ctx.trendSlope) * 200),
        description: `Moderate trend ${ctx.trendSlope > 0 ? "up" : "down"}`,
      }),
      explain: (ctx, p) =>
        `Trend slope ${ctx.trendSlope.toFixed(4)} > moderate threshold ${p.trendThresholdModVol}`,
    }),

    // Rule 7: Default — mean reverting
    createRule<RegimeInput, RegimeProfile, RegimeOutput>({
      id: "default-mean-reverting",
      when: () => true,
      emit: () => ({
        regime: "mean_reverting",
        confidence: 0.5,
        description: "No strong signals — defaulting to mean-reverting",
      }),
      explain: () => "No regime rule matched — default mean-reverting",
    }),
  ],
});

// ── Profiles ─────────────────────────────────────────────────────

export const REGIME_PROFILES = {
  crypto_default: {
    highVolThreshold: 0.02,
    lowVolThreshold: 0.005,
    trendThresholdHighVol: 0.001,
    trendThresholdModVol: 0.0005,
    meanRevImbalanceThreshold: 0.3,
    breakoutVolAccelThreshold: 0.5,
    breakoutSpreadThreshold: 3.0,
  },
  crypto_tight: {
    highVolThreshold: 0.015,
    lowVolThreshold: 0.008,
    trendThresholdHighVol: 0.0008,
    trendThresholdModVol: 0.0003,
    meanRevImbalanceThreshold: 0.25,
    breakoutVolAccelThreshold: 0.3,
    breakoutSpreadThreshold: 2.0,
  },
} satisfies Record<string, RegimeProfile>;

export function classifyRegime(input: RegimeInput, profileName: keyof typeof REGIME_PROFILES = "crypto_default") {
  const profile = REGIME_PROFILES[profileName];
  return engine.run(regimeDecision, input, { profile });
}
