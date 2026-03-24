import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  serializers: {
    err: pino.stdSerializers.err,
  },
  base: { service: "trading-engine" },
});

export function createChildLogger(component: string) {
  return logger.child({ component });
}
