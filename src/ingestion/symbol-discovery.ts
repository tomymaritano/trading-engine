import { createChildLogger } from "../utils/logger.js";
import type { Symbol } from "../types/market.js";

const log = createChildLogger("symbol-discovery");

interface BinanceTicker {
  symbol: string;
  quoteVolume: string;
  status?: string;
}

interface BinanceExchangeInfo {
  symbols: Array<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
  }>;
}

export interface DiscoveryOptions {
  /** Minimum 24h quote volume in USDT (default: 10M) */
  minVolume24h?: number;
  /** Quote asset filter (default: "USDT") */
  quoteAsset?: string;
  /** Max symbols to return (default: 50) */
  maxSymbols?: number;
  /** Always include these symbols regardless of volume */
  alwaysInclude?: Symbol[];
  /** Binance REST base URL */
  restUrl?: string;
}

const DEFAULTS: Required<DiscoveryOptions> = {
  minVolume24h: 10_000_000,
  quoteAsset: "USDT",
  maxSymbols: 50,
  alwaysInclude: ["BTC-USDT", "ETH-USDT", "SOL-USDT"],
  restUrl: "https://api.binance.com",
};

/**
 * Discover tradeable USDT pairs from Binance sorted by 24h volume.
 *
 * Flow:
 * 1. Fetch exchange info → filter TRADING + USDT pairs
 * 2. Fetch 24h tickers → sort by quoteVolume desc
 * 3. Return top N symbols above minimum volume threshold
 */
export async function discoverSymbols(
  opts?: DiscoveryOptions,
): Promise<Symbol[]> {
  const o = { ...DEFAULTS, ...opts };

  try {
    // Fetch exchange info + 24h tickers in parallel
    const [infoRes, tickerRes] = await Promise.all([
      fetch(`${o.restUrl}/api/v3/exchangeInfo`),
      fetch(`${o.restUrl}/api/v3/ticker/24hr`),
    ]);

    if (!infoRes.ok || !tickerRes.ok) {
      throw new Error(`Binance API error: info=${infoRes.status} ticker=${tickerRes.status}`);
    }

    const info = (await infoRes.json()) as BinanceExchangeInfo;
    const tickers = (await tickerRes.json()) as BinanceTicker[];

    // Build set of active USDT trading pairs
    const activeSymbols = new Set(
      info.symbols
        .filter((s) => s.status === "TRADING" && s.quoteAsset === o.quoteAsset)
        .map((s) => s.symbol),
    );

    // Map tickers to volume, filter by active + min volume
    const ranked = tickers
      .filter((t) => activeSymbols.has(t.symbol))
      .map((t) => ({
        binanceSymbol: t.symbol,
        volume: parseFloat(t.quoteVolume),
      }))
      .filter((t) => t.volume >= o.minVolume24h)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, o.maxSymbols);

    // Convert binance format → normalized (BTCUSDT → BTC-USDT)
    const symbolMap = new Map(
      info.symbols
        .filter((s) => activeSymbols.has(s.symbol))
        .map((s) => [s.symbol, `${s.baseAsset}-${s.quoteAsset}`]),
    );

    const discovered = ranked
      .map((r) => symbolMap.get(r.binanceSymbol)!)
      .filter(Boolean);

    // Ensure alwaysInclude symbols are present
    for (const sym of o.alwaysInclude) {
      if (!discovered.includes(sym)) {
        discovered.push(sym);
      }
    }

    log.info(
      {
        total: activeSymbols.size,
        aboveMinVolume: ranked.length,
        selected: discovered.length,
        minVolume24h: o.minVolume24h,
        top5: discovered.slice(0, 5),
      },
      "Symbol discovery complete",
    );

    return discovered;
  } catch (err) {
    log.error({ err }, "Symbol discovery failed, using fallback list");
    return o.alwaysInclude;
  }
}
