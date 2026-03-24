import { z } from "zod";

const ExchangeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  passphrase: z.string().optional(), // OKX requires this
  testnet: z.boolean().default(true),
  wsUrl: z.string().default(""),
  restUrl: z.string().default(""),
  rateLimit: z.object({
    maxRequestsPerSecond: z.number().default(10),
    maxOrdersPerSecond: z.number().default(5),
  }).default({}),
});

const RiskConfigSchema = z.object({
  maxPositionPct: z.number().default(0.02),        // max 2% of portfolio per position
  maxDrawdownPct: z.number().default(0.05),         // 5% max drawdown triggers circuit breaker
  maxDailyLossPct: z.number().default(0.03),        // 3% max daily loss
  maxCorrelatedExposure: z.number().default(0.10),  // 10% in correlated assets
  maxLeverage: z.number().default(3),
  killSwitchLossPct: z.number().default(0.10),      // 10% loss = full shutdown
  minLiquidityScore: z.number().default(0.3),       // don't trade illiquid pairs
});

const StrategyConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  symbols: z.array(z.string()),
  timeframe: z.number().default(30),                // seconds
  minConfidence: z.number().default(0.6),
  maxPositions: z.number().default(3),
  params: z.record(z.unknown()).default({}),
});

export const AppConfigSchema = z.object({
  env: z.enum(["development", "staging", "production"]).default("development"),

  exchanges: z.object({
    binance: ExchangeConfigSchema.default({
      wsUrl: "wss://stream.binance.com:9443/ws",
      restUrl: "https://api.binance.com",
    }),
    kraken: ExchangeConfigSchema.default({
      wsUrl: "wss://ws.kraken.com/v2",
      restUrl: "https://api.kraken.com",
    }),
    okx: ExchangeConfigSchema.default({
      wsUrl: "wss://ws.okx.com:8443/ws/v5/public",
      restUrl: "https://www.okx.com",
    }),
  }),

  symbols: z.array(z.string()).default(["BTC-USDT", "ETH-USDT"]),

  risk: RiskConfigSchema.default({}),

  strategies: z.array(StrategyConfigSchema).default([]),

  redis: z.object({
    url: z.string().default("redis://localhost:6379"),
  }).default({}),

  db: z.object({
    url: z.string().default("postgresql://localhost:5432/trading"),
  }).default({}),

  features: z.object({
    bookDepthLevels: z.number().default(20),
    tradeWindowMs: z.number().default(5000),
    featureIntervalMs: z.number().default(1000),
    volatilityWindowMs: z.number().default(60000),
  }).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type ExchangeConfig = z.infer<typeof ExchangeConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  return AppConfigSchema.parse(overrides ?? {});
}
