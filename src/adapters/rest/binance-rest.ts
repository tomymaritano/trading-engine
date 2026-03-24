import { createChildLogger } from "../../utils/logger.js";
import { sleep } from "../../utils/time.js";
import type { Exchange, Symbol, Trade, Kline } from "../../types/market.js";
import Decimal from "decimal.js";

const log = createChildLogger("binance-rest");

const BASE_URL = "https://api.binance.com";
const FUTURES_URL = "https://fapi.binance.com";

interface RawKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
  trades: number;
}

/**
 * Binance REST API client for historical data downloads.
 *
 * Endpoints used:
 * - GET /api/v3/aggTrades     — aggregated trades (most efficient)
 * - GET /api/v3/klines        — OHLCV candlestick data
 * - GET /fapi/v1/aggTrades    — futures aggregated trades
 * - GET /fapi/v1/klines       — futures OHLCV
 *
 * Rate limiting: Binance allows 1200 requests/min for spot.
 * We use 10 req/s with automatic backoff on 429.
 */
export class BinanceRestClient {
  private requestCount = 0;
  private lastRequestTs = 0;
  private readonly minIntervalMs = 100; // 10 req/s

  /**
   * Download historical aggregated trades for a symbol.
   *
   * Aggregated trades group fills at the same price/time into one record,
   * reducing data volume ~3-5x vs raw trades while preserving all price
   * discovery information.
   *
   * @param symbol - Trading pair (e.g., "BTC-USDT")
   * @param startTs - Start timestamp in ms
   * @param endTs - End timestamp in ms
   * @param onBatch - Callback for each batch (for streaming to storage)
   */
  async *fetchAggTrades(
    symbol: Symbol,
    startTs: number,
    endTs: number,
    futures = false,
  ): AsyncGenerator<Trade[]> {
    const binanceSymbol = symbol.replace("-", "").toUpperCase();
    const base = futures ? FUTURES_URL : BASE_URL;
    const path = futures ? "/fapi/v1/aggTrades" : "/api/v3/aggTrades";

    let fromId: number | undefined;
    let currentStartTs = startTs;
    let totalFetched = 0;

    log.info({ symbol, startTs: new Date(startTs).toISOString(), endTs: new Date(endTs).toISOString() }, "Starting trade download");

    while (currentStartTs < endTs) {
      await this.rateLimit();

      const params = new URLSearchParams({
        symbol: binanceSymbol,
        startTime: currentStartTs.toString(),
        endTime: Math.min(currentStartTs + 3_600_000, endTs).toString(), // 1h chunks
        limit: "1000",
      });
      if (fromId !== undefined) {
        params.set("fromId", fromId.toString());
        params.delete("startTime");
        params.delete("endTime");
      }

      const url = `${base}${path}?${params}`;

      try {
        const response = await fetch(url);

        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After") ?? 60);
          log.warn({ retryAfter }, "Rate limited, backing off");
          await sleep(retryAfter * 1000);
          continue;
        }

        if (!response.ok) {
          log.error({ status: response.status, url }, "API error");
          await sleep(5000);
          continue;
        }

        const rawTrades = await response.json() as Array<{
          a: number;  // agg trade ID
          p: string;  // price
          q: string;  // quantity
          T: number;  // timestamp
          m: boolean; // is buyer maker
        }>;

        if (rawTrades.length === 0) {
          // Move to next hour
          currentStartTs += 3_600_000;
          fromId = undefined;
          continue;
        }

        const trades: Trade[] = rawTrades.map((t) => ({
          exchange: "binance" as Exchange,
          symbol,
          id: String(t.a),
          ts: t.T,
          localTs: BigInt(0),
          price: new Decimal(t.p),
          qty: new Decimal(t.q),
          side: t.m ? "sell" as const : "buy" as const,
          isBuyerMaker: t.m,
        }));

        totalFetched += trades.length;
        yield trades;

        // Advance cursor
        const lastTrade = rawTrades[rawTrades.length - 1];
        if (lastTrade.T >= endTs) break;

        if (rawTrades.length === 1000) {
          // More data in this window, paginate by ID
          fromId = lastTrade.a + 1;
        } else {
          // Window exhausted, move to next hour
          currentStartTs = lastTrade.T + 1;
          fromId = undefined;
        }

        if (totalFetched % 50_000 === 0) {
          log.info({ totalFetched, currentTs: new Date(lastTrade.T).toISOString() }, "Download progress");
        }
      } catch (err) {
        log.error({ err, url }, "Fetch error, retrying");
        await sleep(3000);
      }
    }

    log.info({ totalFetched, symbol }, "Trade download complete");
  }

  /**
   * Download historical OHLCV klines.
   *
   * @param symbol - Trading pair
   * @param interval - Candle interval (1m, 5m, 15m, 1h, 4h, 1d)
   * @param startTs - Start timestamp
   * @param endTs - End timestamp
   */
  async *fetchKlines(
    symbol: Symbol,
    interval: string,
    startTs: number,
    endTs: number,
    futures = false,
  ): AsyncGenerator<Kline[]> {
    const binanceSymbol = symbol.replace("-", "").toUpperCase();
    const base = futures ? FUTURES_URL : BASE_URL;
    const path = futures ? "/fapi/v1/klines" : "/api/v3/klines";

    let currentStartTs = startTs;
    let totalFetched = 0;

    while (currentStartTs < endTs) {
      await this.rateLimit();

      const params = new URLSearchParams({
        symbol: binanceSymbol,
        interval,
        startTime: currentStartTs.toString(),
        endTime: endTs.toString(),
        limit: "1000",
      });

      const url = `${base}${path}?${params}`;

      try {
        const response = await fetch(url);

        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After") ?? 60);
          log.warn({ retryAfter }, "Rate limited");
          await sleep(retryAfter * 1000);
          continue;
        }

        if (!response.ok) {
          log.error({ status: response.status }, "Kline API error");
          await sleep(5000);
          continue;
        }

        const raw = await response.json() as unknown[][];

        if (raw.length === 0) break;

        const klines: Kline[] = raw.map((k) => ({
          exchange: "binance" as Exchange,
          symbol,
          interval,
          openTs: k[0] as number,
          closeTs: k[6] as number,
          open: new Decimal(k[1] as string),
          high: new Decimal(k[2] as string),
          low: new Decimal(k[3] as string),
          close: new Decimal(k[4] as string),
          volume: new Decimal(k[5] as string),
          quoteVolume: new Decimal(k[7] as string),
          trades: k[8] as number,
        }));

        totalFetched += klines.length;
        yield klines;

        const lastKline = klines[klines.length - 1];
        currentStartTs = lastKline.closeTs + 1;

        if (raw.length < 1000) break; // no more data
      } catch (err) {
        log.error({ err }, "Kline fetch error, retrying");
        await sleep(3000);
      }
    }

    log.info({ totalFetched, symbol, interval }, "Kline download complete");
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTs;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestTs = Date.now();
    this.requestCount++;
  }
}
