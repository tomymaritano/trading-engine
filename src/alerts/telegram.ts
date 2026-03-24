import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("telegram");

/**
 * Telegram Alert System
 *
 * Sends trading notifications to your Telegram chat.
 *
 * Setup:
 * 1. Message @BotFather on Telegram → /newbot → get your BOT_TOKEN
 * 2. Message your bot → then visit:
 *    https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
 *    → find your chat_id
 * 3. Set env vars:
 *    TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
 *    TELEGRAM_CHAT_ID=987654321
 *
 * Alerts sent for:
 * - Trade filled (entry/exit with PnL)
 * - Signal generated (high confidence only)
 * - Risk events (circuit breaker, kill switch)
 * - Whale events (large institutional activity)
 */
export class TelegramAlerts {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;
  private messageCount = 0;
  private lastMessageTs = 0;
  private readonly minIntervalMs = 1000; // max 1 msg/sec (Telegram rate limit)

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
    this.chatId = process.env.TELEGRAM_CHAT_ID ?? "";
    this.enabled = !!(this.botToken && this.chatId);
  }

  start(): void {
    if (!this.enabled) {
      log.info("Telegram alerts disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)");
      return;
    }

    // Trade fills
    bus.on("order:filled", (fill) => {
      this.send(
        `📊 *Trade Filled*\n` +
        `${fill.direction === "long" ? "🟢 LONG" : "🔴 SHORT"} ${fill.symbol}\n` +
        `Price: $${Number(fill.fillPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}\n` +
        `Qty: ${Number(fill.fillQty).toFixed(6)}\n` +
        `Slippage: ${Number(fill.slippageBps).toFixed(1)} bps`,
      );
    });

    // High-confidence signals only (to avoid spam)
    bus.on("signal:new", (signal) => {
      if (signal.confidence < 0.7) return; // only alert on strong signals
      this.send(
        `🎯 *Signal*\n` +
        `${signal.direction === "long" ? "🟢" : "🔴"} ${signal.direction.toUpperCase()} ${signal.symbol}\n` +
        `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n` +
        `Strategy: ${signal.strategy}\n` +
        `Expected: +${(signal.expectedReturn * 100).toFixed(2)}%`,
      );
    });

    // Risk events (always alert)
    bus.on("risk:circuit_breaker", ({ reason }) => {
      this.send(`⚠️ *Circuit Breaker*\n${reason}`);
    });

    bus.on("risk:kill_switch", ({ reason }) => {
      this.send(`🚨 *KILL SWITCH*\n${reason}\nAll trading halted.`);
    });

    // Whale events
    bus.on("feature:anomaly", (anomaly) => {
      if (!anomaly.type.startsWith("whale_") || anomaly.severity < 0.7) return;
      this.send(
        `🐋 *Whale Activity*\n` +
        `${anomaly.type.replace("whale_", "").toUpperCase()} on ${anomaly.symbol}\n` +
        `${anomaly.details}`,
      );
    });

    // Startup message
    this.send("✅ *CriterionX Engine Started*\nMonitoring markets...");

    log.info("Telegram alerts enabled");
  }

  /** Send a message with rate limiting */
  private async send(text: string): Promise<void> {
    if (!this.enabled) return;

    // Rate limit
    const elapsed = Date.now() - this.lastMessageTs;
    if (elapsed < this.minIntervalMs) return;
    this.lastMessageTs = Date.now();

    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
      this.messageCount++;
    } catch (err) {
      // Silent fail — alerts are supplementary
      log.debug({ err }, "Telegram send failed");
    }
  }

  get stats() {
    return { enabled: this.enabled, messagesSent: this.messageCount };
  }
}
