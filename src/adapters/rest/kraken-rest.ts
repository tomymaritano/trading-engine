import Decimal from "decimal.js";
import { createChildLogger } from "../../utils/logger.js";
import { sleep } from "../../utils/time.js";
import type { Exchange, Symbol, Trade, Kline } from "../../types/market.js";

const log = createChildLogger("kraken-rest");
const BASE_URL = "https://api.kraken.com";

/**
 * Kraken REST client for historical data.
 *
 * Kraken uses different symbol formats (XXBTZUSD) and returns
 * trades as arrays, not objects. We normalize everything.
 *
 * Rate limit: 15 calls per second (public endpoints).
 */
export class KrakenRestClient {
  private lastRequestTs = 0;
  private readonly minIntervalMs = 80;

  /** Map our symbols to Kraken format */
  private toKrakenPair(symbol: Symbol): string {
    const map: Record<string, string> = {
      "BTC-USDT": "XBTUSDT",
      "ETH-USDT": "ETHUSDT",
      "SOL-USDT": "SOLUSDT",
      "BTC-USD": "XXBTZUSD",
      "ETH-USD": "XETHZUSD",
    };
    return map[symbol] ?? symbol.replace("-", "");
  }

  async *fetchTrades(
    symbol: Symbol,
    startTs: number,
    endTs: number,
  ): AsyncGenerator<Trade[]> {
    const pair = this.toKrakenPair(symbol);
    // Kraken uses nanoseconds for the `since` parameter
    let since = (startTs * 1_000_000).toString();
    let totalFetched = 0;

    log.info({ symbol, pair, startTs: new Date(startTs).toISOString() }, "Starting Kraken trade download");

    while (true) {
      await this.rateLimit();

      const url = `${BASE_URL}/0/public/Trades?pair=${pair}&since=${since}`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          log.warn({ status: res.status }, "Kraken API error, retrying");
          await sleep(5000);
          continue;
        }

        const json = await res.json() as {
          error: string[];
          result: Record<string, unknown[][]> & { last: string };
        };

        if (json.error.length > 0) {
          log.warn({ errors: json.error }, "Kraken API returned errors");
          await sleep(3000);
          continue;
        }

        // Result has the pair key + "last"
        const pairKey = Object.keys(json.result).find((k) => k !== "last");
        if (!pairKey) break;

        const rawTrades = json.result[pairKey] as unknown[][];
        if (!rawTrades || rawTrades.length === 0) break;

        const trades: Trade[] = rawTrades
          .map((t, i) => {
            const ts = Math.floor(Number(t[2]) * 1000);
            if (ts > endTs) return null;
            return {
              exchange: "kraken" as Exchange,
              symbol,
              id: `${since}_${i}`,
              ts,
              localTs: BigInt(0),
              price: new Decimal(t[0] as string),
              qty: new Decimal(t[1] as string),
              side: (t[3] as string) === "b" ? "buy" as const : "sell" as const,
              isBuyerMaker: (t[3] as string) === "s",
            };
          })
          .filter((t): t is Trade => t !== null);

        if (trades.length === 0) break;

        totalFetched += trades.length;
        yield trades;

        // Check if we've passed the end
        const lastTradeTs = trades[trades.length - 1].ts;
        if (lastTradeTs >= endTs) break;

        since = json.result.last as string;

        if (totalFetched % 50_000 === 0) {
          log.info({ totalFetched, lastTs: new Date(lastTradeTs).toISOString() }, "Kraken download progress");
        }
      } catch (err) {
        log.error({ err }, "Kraken fetch error, retrying");
        await sleep(3000);
      }
    }

    log.info({ totalFetched, symbol }, "Kraken trade download complete");
  }

  async *fetchKlines(
    symbol: Symbol,
    intervalMinutes: number,
    startTs: number,
    endTs: number,
  ): AsyncGenerator<Kline[]> {
    const pair = this.toKrakenPair(symbol);
    let since = Math.floor(startTs / 1000);
    let totalFetched = 0;

    while (true) {
      await this.rateLimit();

      const url = `${BASE_URL}/0/public/OHLC?pair=${pair}&interval=${intervalMinutes}&since=${since}`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          await sleep(5000);
          continue;
        }

        const json = await res.json() as {
          error: string[];
          result: Record<string, unknown[][]> & { last: number };
        };

        if (json.error.length > 0) {
          await sleep(3000);
          continue;
        }

        const pairKey = Object.keys(json.result).find((k) => k !== "last");
        if (!pairKey) break;

        const rawKlines = json.result[pairKey] as unknown[][];
        if (!rawKlines || rawKlines.length === 0) break;

        const klines: Kline[] = rawKlines
          .map((k) => {
            const openTs = (k[0] as number) * 1000;
            if (openTs > endTs) return null;
            return {
              exchange: "kraken" as Exchange,
              symbol,
              interval: `${intervalMinutes}m`,
              openTs,
              closeTs: openTs + intervalMinutes * 60_000,
              open: new Decimal(k[1] as string),
              high: new Decimal(k[2] as string),
              low: new Decimal(k[3] as string),
              close: new Decimal(k[4] as string),
              volume: new Decimal(k[6] as string),
              quoteVolume: new Decimal(0), // Kraken doesn't provide this
              trades: k[7] as number,
            };
          })
          .filter((k): k is Kline => k !== null);

        if (klines.length === 0) break;

        totalFetched += klines.length;
        yield klines;

        since = json.result.last;
        if (klines[klines.length - 1].openTs >= endTs) break;
        if (rawKlines.length < 720) break;
      } catch (err) {
        log.error({ err }, "Kraken kline fetch error");
        await sleep(3000);
      }
    }

    log.info({ totalFetched, symbol }, "Kraken kline download complete");
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTs;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestTs = Date.now();
  }
}
