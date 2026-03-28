import { createHmac, randomUUID } from "node:crypto";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("wallet-bridge");

const WALLET_URL = process.env.WALLET_URL || "http://localhost:3004";
const HMAC_SECRET = process.env.WALLET_HMAC_SECRET || "";

interface SignTradeRequest {
  chain: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  price?: number;
}

interface SignTradeResponse {
  orderId: string;
  txHash: string | null;
  status: "submitted" | "failed";
  signedBy: string;
  error?: string;
}

/**
 * Wallet Bridge — routes order execution through the CriterionX Wallet.
 *
 * Instead of signing trades directly with exchange API keys,
 * this bridge delegates to the wallet's signing service.
 * The wallet handles key management, spending limits, and on-chain execution.
 *
 * Used when USE_WALLET=true in the engine config.
 */
export class WalletBridge {
  private healthy = false;

  constructor() {
    this.checkHealth();
    // Health check every 30s
    setInterval(() => this.checkHealth(), 30_000);
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Sign and submit a trade via the wallet.
   */
  async signTrade(req: SignTradeRequest): Promise<SignTradeResponse> {
    if (!HMAC_SECRET) {
      throw new Error("WALLET_HMAC_SECRET not configured");
    }

    const requestId = randomUUID();
    const timestamp = Date.now();

    const payload = { ...req, requestId, timestamp };
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", HMAC_SECRET).update(body).digest("hex");

    log.info({ chain: req.chain, symbol: req.symbol, side: req.side, size: req.size }, "Sending trade to wallet");

    const response = await fetch(`${WALLET_URL}/api/sign-trade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        "X-Timestamp": String(timestamp),
        "X-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    const result = await response.json() as SignTradeResponse;

    if (!response.ok) {
      log.error({ status: response.status, error: result.error }, "Wallet rejected trade");
      throw new Error(`Wallet error ${response.status}: ${result.error ?? "unknown"}`);
    }

    log.info({
      orderId: result.orderId,
      txHash: result.txHash,
      status: result.status,
      signedBy: result.signedBy,
    }, "Wallet trade response");

    return result;
  }

  /**
   * Get balances from the wallet.
   */
  async getBalances(): Promise<Record<string, unknown>> {
    const response = await fetch(`${WALLET_URL}/api/balances`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Trigger kill switch on the wallet (halt all trading).
   */
  async killSwitch(reason: string): Promise<void> {
    const requestId = randomUUID();
    const timestamp = Date.now();
    const payload = { reason, requestId, timestamp };
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", HMAC_SECRET).update(body).digest("hex");

    await fetch(`${WALLET_URL}/api/kill-switch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        "X-Timestamp": String(timestamp),
        "X-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });

    log.warn({ reason }, "Kill switch sent to wallet");
  }

  private async checkHealth(): Promise<void> {
    try {
      const res = await fetch(`${WALLET_URL}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      const data = await res.json() as { status: string };
      this.healthy = data.status === "ok";
      if (!this.healthy) {
        log.warn("Wallet health check: degraded");
      }
    } catch {
      this.healthy = false;
      log.warn("Wallet unreachable");
    }
  }
}

/** Singleton — created lazily when USE_WALLET=true */
let _bridge: WalletBridge | null = null;

export function getWalletBridge(): WalletBridge {
  if (!_bridge) _bridge = new WalletBridge();
  return _bridge;
}
