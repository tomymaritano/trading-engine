import { createHmac } from "node:crypto";
import { createChildLogger } from "../../utils/logger.js";
import { sleep } from "../../utils/time.js";

const log = createChildLogger("binance-futures-rest");
const BASE_URL = "https://fapi.binance.com";
const TESTNET_URL = "https://testnet.binancefuture.com";

/**
 * Binance USD-M Futures REST client.
 *
 * Two modes:
 * 1. Public (no auth) — market data, klines, depth snapshots
 * 2. Signed (API key + secret) — orders, positions, account info
 *
 * For paper trading: use testnet (TESTNET_URL).
 * For live: use production (BASE_URL) with real API keys.
 */
export class BinanceFuturesRestClient {
  private lastRequestTs = 0;
  private readonly minIntervalMs = 100;
  private readonly baseUrl: string;

  constructor(
    private apiKey?: string,
    private apiSecret?: string,
    testnet = true,
  ) {
    this.baseUrl = testnet ? TESTNET_URL : BASE_URL;
  }

  // ── Public endpoints (no auth) ─────────────────────────────────

  /** Get current order book depth */
  async getDepth(symbol: string, limit = 20): Promise<{ bids: string[][]; asks: string[][] } | null> {
    return this.publicGet(`/fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
  }

  /** Get recent trades */
  async getRecentTrades(symbol: string, limit = 100): Promise<unknown[] | null> {
    return this.publicGet(`/fapi/v1/trades?symbol=${symbol}&limit=${limit}`);
  }

  /** Get current funding rate */
  async getFundingRate(symbol: string): Promise<{ symbol: string; fundingRate: string; fundingTime: number } | null> {
    return this.publicGet<{ symbol: string; fundingRate: string; fundingTime: number }>(`/fapi/v1/premiumIndex?symbol=${symbol}`);
  }

  /** Get mark price */
  async getMarkPrice(symbol: string): Promise<{ markPrice: string; indexPrice: string } | null> {
    return this.publicGet(`/fapi/v1/premiumIndex?symbol=${symbol}`);
  }

  // ── Signed endpoints (auth required) ───────────────────────────

  /** Get account info (balances, positions) */
  async getAccount(): Promise<unknown | null> {
    return this.signedGet("/fapi/v2/account");
  }

  /** Get open positions */
  async getPositions(): Promise<unknown[] | null> {
    return this.signedGet("/fapi/v2/positionRisk");
  }

  /** Get account balance */
  async getBalance(): Promise<unknown[] | null> {
    return this.signedGet("/fapi/v2/balance");
  }

  /**
   * Place a new order.
   *
   * @param symbol - Trading pair (e.g., "ETHUSDT")
   * @param side - "BUY" or "SELL"
   * @param type - "MARKET", "LIMIT", "STOP_MARKET", etc.
   * @param quantity - Order quantity
   * @param price - Limit price (required for LIMIT orders)
   * @param timeInForce - "GTC", "IOC", "FOK" (for LIMIT)
   */
  async placeOrder(params: {
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
    quantity: string;
    price?: string;
    stopPrice?: string;
    timeInForce?: "GTC" | "IOC" | "FOK";
    reduceOnly?: boolean;
  }): Promise<unknown | null> {
    const body: Record<string, string> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
    };

    if (params.price) body.price = params.price;
    if (params.stopPrice) body.stopPrice = params.stopPrice;
    if (params.timeInForce) body.timeInForce = params.timeInForce;
    if (params.reduceOnly) body.reduceOnly = "true";

    return this.signedPost("/fapi/v1/order", body);
  }

  /** Cancel an order */
  async cancelOrder(symbol: string, orderId: number): Promise<unknown | null> {
    return this.signedDelete(`/fapi/v1/order?symbol=${symbol}&orderId=${orderId}`);
  }

  /** Cancel all open orders for a symbol */
  async cancelAllOrders(symbol: string): Promise<unknown | null> {
    return this.signedDelete(`/fapi/v1/allOpenOrders?symbol=${symbol}`);
  }

  /** Set leverage for a symbol */
  async setLeverage(symbol: string, leverage: number): Promise<unknown | null> {
    return this.signedPost("/fapi/v1/leverage", {
      symbol,
      leverage: String(leverage),
    });
  }

  /** Set margin type (ISOLATED or CROSSED) */
  async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<unknown | null> {
    return this.signedPost("/fapi/v1/marginType", { symbol, marginType });
  }

  // ── HTTP helpers ───────────────────────────────────────────────

  private async publicGet<T>(path: string): Promise<T | null> {
    await this.rateLimit();
    try {
      const res = await fetch(`${this.baseUrl}${path}`);
      if (!res.ok) {
        log.warn({ status: res.status, path }, "Public API error");
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      log.error({ err, path }, "Public API fetch error");
      return null;
    }
  }

  private async signedGet<T>(path: string): Promise<T | null> {
    if (!this.apiKey || !this.apiSecret) {
      log.warn("API keys not configured for signed request");
      return null;
    }

    await this.rateLimit();
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = this.sign(queryString);
    const url = `${this.baseUrl}${path}?${queryString}&signature=${signature}`;

    try {
      const res = await fetch(url, {
        headers: { "X-MBX-APIKEY": this.apiKey },
      });
      if (!res.ok) {
        const body = await res.text();
        log.warn({ status: res.status, body: body.slice(0, 200) }, "Signed GET error");
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      log.error({ err }, "Signed GET fetch error");
      return null;
    }
  }

  private async signedPost<T>(path: string, params: Record<string, string>): Promise<T | null> {
    if (!this.apiKey || !this.apiSecret) {
      log.warn("API keys not configured for signed request");
      return null;
    }

    await this.rateLimit();
    const timestamp = Date.now();
    params.timestamp = String(timestamp);
    const queryString = new URLSearchParams(params).toString();
    const signature = this.sign(queryString);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "X-MBX-APIKEY": this.apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `${queryString}&signature=${signature}`,
      });
      if (!res.ok) {
        const body = await res.text();
        log.warn({ status: res.status, body: body.slice(0, 200) }, "Signed POST error");
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      log.error({ err }, "Signed POST fetch error");
      return null;
    }
  }

  private async signedDelete<T>(path: string): Promise<T | null> {
    if (!this.apiKey || !this.apiSecret) return null;

    await this.rateLimit();
    const timestamp = Date.now();
    const separator = path.includes("?") ? "&" : "?";
    const queryString = `timestamp=${timestamp}`;
    const fullQuery = path.includes("?")
      ? `${path.split("?")[1]}&${queryString}`
      : queryString;
    const signature = this.sign(fullQuery);
    const url = `${this.baseUrl}${path}${separator}${queryString}&signature=${signature}`;

    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: { "X-MBX-APIKEY": this.apiKey },
      });
      if (!res.ok) return null;
      return await res.json() as T;
    } catch {
      return null;
    }
  }

  private sign(queryString: string): string {
    return createHmac("sha256", this.apiSecret!).update(queryString).digest("hex");
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTs;
    if (elapsed < this.minIntervalMs) await sleep(this.minIntervalMs - elapsed);
    this.lastRequestTs = Date.now();
  }
}
