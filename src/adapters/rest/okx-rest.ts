import Decimal from "decimal.js";
import { createChildLogger } from "../../utils/logger.js";
import { sleep } from "../../utils/time.js";
import type { Exchange, Symbol, Trade, Kline } from "../../types/market.js";

const log = createChildLogger("okx-rest");
const BASE_URL = "https://www.okx.com";

/**
 * OKX REST client for historical data.
 * OKX uses instId format "BTC-USDT" which matches our normalized format.
 * Rate limit: 20 requests per 2 seconds.
 */
export class OkxRestClient {
  private lastRequestTs = 0;
  private readonly minIntervalMs = 100;

  async *fetchTrades(
    symbol: Symbol,
    startTs: number,
    endTs: number,
  ): AsyncGenerator<Trade[]> {
    let after = ""; // OKX uses trade ID for pagination
    let totalFetched = 0;
    let reachedEnd = false;

    log.info({ symbol, startTs: new Date(startTs).toISOString() }, "Starting OKX trade download");

    while (!reachedEnd) {
      await this.rateLimit();

      const params = new URLSearchParams({
        instId: symbol,
        limit: "100", // OKX max per request for public trades
      });
      if (after) params.set("after", after);

      const url = `${BASE_URL}/api/v5/market/trades-history?${params}`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          log.warn({ status: res.status }, "OKX API error");
          await sleep(5000);
          continue;
        }

        const json = await res.json() as {
          code: string;
          data: Array<{
            instId: string;
            tradeId: string;
            px: string;
            sz: string;
            side: string;
            ts: string;
          }>;
        };

        if (json.code !== "0" || !json.data || json.data.length === 0) {
          break;
        }

        const trades: Trade[] = json.data
          .map((t) => {
            const ts = Number(t.ts);
            if (ts < startTs || ts > endTs) return null;
            return {
              exchange: "okx" as Exchange,
              symbol,
              id: t.tradeId,
              ts,
              localTs: BigInt(0),
              price: new Decimal(t.px),
              qty: new Decimal(t.sz),
              side: t.side as "buy" | "sell",
              isBuyerMaker: t.side === "sell",
            };
          })
          .filter((t): t is Trade => t !== null);

        if (trades.length === 0) {
          // Check if we've gone past the start
          const oldestTs = Number(json.data[json.data.length - 1].ts);
          if (oldestTs < startTs) break;
        }

        totalFetched += trades.length;
        if (trades.length > 0) yield trades;

        // OKX returns newest first, paginate backward
        after = json.data[json.data.length - 1].tradeId;

        const oldestTs = Number(json.data[json.data.length - 1].ts);
        if (oldestTs <= startTs) reachedEnd = true;
        if (json.data.length < 100) reachedEnd = true;

        if (totalFetched % 10_000 === 0) {
          log.info({ totalFetched }, "OKX download progress");
        }
      } catch (err) {
        log.error({ err }, "OKX fetch error, retrying");
        await sleep(3000);
      }
    }

    log.info({ totalFetched, symbol }, "OKX trade download complete");
  }

  async *fetchKlines(
    symbol: Symbol,
    bar: string, // "1m", "5m", "1H", "1D" etc.
    startTs: number,
    endTs: number,
  ): AsyncGenerator<Kline[]> {
    let after = "";
    let totalFetched = 0;

    while (true) {
      await this.rateLimit();

      const params = new URLSearchParams({
        instId: symbol,
        bar,
        limit: "100",
      });
      if (after) params.set("after", after);

      const url = `${BASE_URL}/api/v5/market/history-candles?${params}`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          await sleep(5000);
          continue;
        }

        const json = await res.json() as {
          code: string;
          data: string[][];
        };

        if (json.code !== "0" || !json.data || json.data.length === 0) break;

        const klines: Kline[] = json.data
          .map((k) => {
            const openTs = Number(k[0]);
            if (openTs < startTs || openTs > endTs) return null;
            return {
              exchange: "okx" as Exchange,
              symbol,
              interval: bar,
              openTs,
              closeTs: openTs + this.barToMs(bar),
              open: new Decimal(k[1]),
              high: new Decimal(k[2]),
              low: new Decimal(k[3]),
              close: new Decimal(k[4]),
              volume: new Decimal(k[5]),
              quoteVolume: new Decimal(k[7] || "0"),
              trades: 0,
            };
          })
          .filter((k): k is Kline => k !== null);

        if (klines.length === 0) break;

        totalFetched += klines.length;
        yield klines;

        after = json.data[json.data.length - 1][0];
        const oldestTs = Number(json.data[json.data.length - 1][0]);
        if (oldestTs <= startTs) break;
        if (json.data.length < 100) break;
      } catch (err) {
        log.error({ err }, "OKX kline fetch error");
        await sleep(3000);
      }
    }

    log.info({ totalFetched, symbol }, "OKX kline download complete");
  }

  private barToMs(bar: string): number {
    const map: Record<string, number> = {
      "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
      "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000,
    };
    return map[bar] ?? 60_000;
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTs;
    if (elapsed < this.minIntervalMs) await sleep(this.minIntervalMs - elapsed);
    this.lastRequestTs = Date.now();
  }
}
