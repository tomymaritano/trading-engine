import Decimal from "decimal.js";
import PQueue from "p-queue";
import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";
import { orderBookManager } from "../stream/order-book-manager.js";
import { getTradingParams } from "../config/trading-params.js";
import type { OrderIntent, OrderType } from "../types/signals.js";
import type { Exchange } from "../types/market.js";
import type { AppConfig } from "../config/index.js";

const log = createChildLogger("execution-engine");

interface OrderState {
  id: string;
  intent: OrderIntent;
  status: "pending" | "submitted" | "partial" | "filled" | "cancelled" | "rejected";
  filledQty: Decimal;
  avgFillPrice: Decimal;
  submittedTs: number;
  fills: Array<{ price: number; qty: number; ts: number }>;
}

/**
 * Execution Engine — smart order routing and execution.
 *
 * Turns OrderIntents into actual exchange orders, managing:
 * 1. Order type selection (market vs limit IOC vs TWAP)
 * 2. Slippage estimation and control
 * 3. Order lifecycle (submit, monitor, cancel on TTL expiry)
 * 4. Fill tracking and reporting
 * 5. Rate limiting per exchange
 *
 * Smart execution strategies:
 * - For high-confidence signals: market order (speed > price)
 * - For medium confidence: limit IOC at mid + 1 tick
 * - For large orders: TWAP over the signal horizon
 * - For iceberg: split into smaller visible chunks
 *
 * In paper trading mode, simulates fills using current book state.
 */
export class ExecutionEngine {
  private orders = new Map<string, OrderState>();
  private orderCounter = 0;
  private queues = new Map<Exchange, PQueue>();
  private paperMode: boolean;

  constructor(private config: AppConfig) {
    this.paperMode = config.env !== "production";
  }

  start(): void {
    // Initialize rate-limited queues per exchange
    for (const exchange of ["binance", "kraken", "okx"] as Exchange[]) {
      const rateLimit = this.config.exchanges[exchange].rateLimit;
      this.queues.set(
        exchange,
        new PQueue({
          concurrency: 1,
          intervalCap: rateLimit.maxOrdersPerSecond,
          interval: 1000,
        }),
      );
    }

    bus.on("order:intent", (intent) => this.executeOrder(intent));
    log.info({ paperMode: this.paperMode }, "Execution engine started");
  }

  stop(): void {
    // Cancel all pending orders
    for (const [id, order] of this.orders) {
      if (order.status === "pending" || order.status === "submitted") {
        this.cancelOrder(id, "engine_shutdown");
      }
    }
  }

  private async executeOrder(intent: OrderIntent): Promise<void> {
    const id = `ord_${++this.orderCounter}_${Date.now()}`;

    const orderState: OrderState = {
      id,
      intent,
      status: "pending",
      filledQty: new Decimal(0),
      avgFillPrice: new Decimal(0),
      submittedTs: Date.now(),
      fills: [],
    };
    this.orders.set(id, orderState);

    // ── Pre-execution slippage check ─────────────────────────
    const book = orderBookManager.getBook(intent.exchange, intent.symbol);
    if (book) {
      const estimatedSlippage = this.estimateSlippage(intent, book);
      if (estimatedSlippage > intent.maxSlippageBps) {
        this.rejectOrder(id, `Estimated slippage ${estimatedSlippage.toFixed(1)} bps > max ${intent.maxSlippageBps} bps`);
        return;
      }
    }

    // ── Enqueue with rate limiting ───────────────────────────
    const queue = this.queues.get(intent.exchange);
    if (!queue) {
      this.rejectOrder(id, `No queue for exchange ${intent.exchange}`);
      return;
    }

    await queue.add(async () => {
      // Check live mode from trading params (can change at runtime from dashboard)
      const isLive = getTradingParams().mode === "live";
      if (this.paperMode && !isLive) {
        this.executePaperOrder(id, orderState);
      } else {
        await this.executeLiveOrder(id, orderState);
      }
    });

    // ── TTL management ───────────────────────────────────────
    if (intent.ttlMs > 0) {
      setTimeout(() => {
        const order = this.orders.get(id);
        if (order && (order.status === "pending" || order.status === "submitted")) {
          this.cancelOrder(id, "ttl_expired");
        }
      }, intent.ttlMs);
    }
  }

  /**
   * Paper trading: simulate fills using current order book.
   *
   * This is critical for development — we simulate realistic fills
   * including partial fills, slippage, and market impact.
   */
  private executePaperOrder(id: string, order: OrderState): void {
    const { intent } = order;
    const book = orderBookManager.getBook(intent.exchange, intent.symbol);

    // Use book prices if available, otherwise fall back to signal's midPrice
    const hasBook = book && book.bestBid && book.bestAsk;
    const midPrice = hasBook
      ? book.cachedMidPrice
      : (intent.signal.features.midPrice ?? 0);

    log.info({ id, hasBook, midPrice, side: intent.side, qty: intent.qty.toString() }, "Executing paper order");

    if (midPrice <= 0) {
      this.rejectOrder(id, "No price data available for paper fill");
      return;
    }

    order.status = "submitted";
    bus.emit("order:submitted", { id, intent });

    // Simulate fill
    let fillPrice: number;
    if (!hasBook || intent.orderType === "market") {
      // Market order or no book: fill at mid ± simulated impact (2 bps)
      const impact = midPrice * 0.0002;
      fillPrice = intent.side === "buy" ? midPrice + impact : midPrice - impact;
    } else {
      // Limit order with book data
      const limitPrice = intent.limitPrice?.toNumber() ?? book!.cachedMidPrice;
      const canFill = intent.side === "buy"
        ? limitPrice >= book!.bestAsk!.price.toNumber()
        : limitPrice <= book!.bestBid!.price.toNumber();

      if (!canFill) {
        this.cancelOrder(id, "Limit price not reachable");
        return;
      }
      fillPrice = limitPrice;
    }

    // Simulate partial fill (90-100% of intended qty)
    const fillRatio = 0.9 + Math.random() * 0.1;
    const fillQty = intent.qty.toNumber() * fillRatio;

    const slippageBps = intent.side === "buy"
      ? ((fillPrice - midPrice) / midPrice) * 10000
      : ((midPrice - fillPrice) / midPrice) * 10000;

    order.status = "filled";
    order.filledQty = new Decimal(fillQty);
    order.avgFillPrice = new Decimal(fillPrice);
    order.fills.push({ price: fillPrice, qty: fillQty, ts: Date.now() });

    bus.emit("order:filled", {
      id,
      fillPrice,
      fillQty,
      slippageBps: Math.max(0, slippageBps),
      symbol: intent.symbol,
      exchange: intent.exchange,
      side: intent.side,
      direction: intent.signal.direction,
    });

    log.info(
      {
        id,
        symbol: intent.symbol,
        side: intent.side,
        qty: fillQty.toFixed(6),
        price: fillPrice.toFixed(2),
        slippageBps: slippageBps.toFixed(2),
      },
      "Paper order filled",
    );
  }

  /**
   * Live execution: send real orders to exchanges.
   * Routes through wallet bridge if USE_WALLET=true, otherwise uses Binance direct.
   */
  private async executeLiveOrder(id: string, order: OrderState): Promise<void> {
    const { intent } = order;

    // ── Route via Wallet if configured ─────────────────────
    if (process.env.USE_WALLET === "true") {
      await this.executeViaWallet(id, order);
      return;
    }

    // ── Direct Binance execution (legacy) ──────────────────
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    const testnet = process.env.BINANCE_TESTNET !== "false";

    if (!apiKey || !apiSecret) {
      log.warn({ id }, "No Binance API keys, falling back to paper");
      this.executePaperOrder(id, order);
      return;
    }

    try {
      const { BinanceFuturesRestClient } = await import("../adapters/rest/binance-futures-rest.js");
      const client = new BinanceFuturesRestClient(apiKey, apiSecret, testnet);

      const binanceSymbol = intent.symbol.replace("-", "");
      const side = intent.side === "buy" ? "BUY" as const : "SELL" as const;

      // Round quantity to exchange precision
      const qty = intent.qty.toFixed(intent.symbol.includes("BTC") ? 3 : intent.symbol.includes("ETH") ? 3 : 0);

      log.info({
        id,
        symbol: binanceSymbol,
        side,
        qty,
        type: intent.orderType === "market" ? "MARKET" : "LIMIT",
        testnet,
      }, "Executing LIVE order on Binance Futures");

      const result = await client.placeOrder({
        symbol: binanceSymbol,
        side,
        type: intent.orderType === "market" ? "MARKET" : "LIMIT",
        quantity: qty,
        price: intent.orderType !== "market" && intent.limitPrice
          ? intent.limitPrice.toString()
          : undefined,
        timeInForce: intent.orderType !== "market" ? "IOC" : undefined,
      });

      if (result) {
        const fillData = result as Record<string, unknown>;
        const avgPrice = Number(fillData.avgPrice ?? fillData.price ?? 0);
        const executedQty = Number(fillData.executedQty ?? qty);

        order.status = "filled";
        order.filledQty = new Decimal(executedQty);
        order.avgFillPrice = new Decimal(avgPrice);

        bus.emit("order:filled", {
          id,
          fillPrice: avgPrice,
          fillQty: executedQty,
          slippageBps: 0,
          symbol: intent.symbol,
          exchange: intent.exchange,
          side: intent.side,
          direction: intent.signal.direction,
        });

        log.info({
          id,
          symbol: binanceSymbol,
          side,
          qty: executedQty,
          price: avgPrice,
          testnet,
          orderId: fillData.orderId,
        }, "LIVE order filled");
      } else {
        this.rejectOrder(id, "Exchange returned null response");
      }
    } catch (err) {
      log.error({ id, err }, "LIVE order execution failed");
      this.rejectOrder(id, `Exchange error: ${(err as Error).message}`);
    }
  }

  /**
   * Execute via CriterionX Wallet.
   * The wallet handles key management, signing, and chain submission.
   */
  private async executeViaWallet(id: string, order: OrderState): Promise<void> {
    const { intent } = order;

    try {
      const { getWalletBridge } = await import("../adapters/rest/wallet-bridge.js");
      const wallet = getWalletBridge();

      if (!wallet.isHealthy) {
        log.warn({ id }, "Wallet unhealthy, falling back to paper");
        this.executePaperOrder(id, order);
        return;
      }

      // Map exchange to chain
      const chain = this.exchangeToChain(intent.exchange);

      log.info({
        id,
        chain,
        symbol: intent.symbol,
        side: intent.signal.direction,
        qty: intent.qty.toString(),
      }, "Executing via wallet bridge");

      order.status = "submitted";
      bus.emit("order:submitted", { id, intent });

      const result = await wallet.signTrade({
        chain,
        symbol: intent.symbol,
        side: intent.signal.direction as "long" | "short",
        size: intent.qty.toNumber(),
        price: intent.limitPrice?.toNumber(),
      });

      if (result.status === "submitted") {
        const fillPrice = intent.limitPrice?.toNumber() ?? orderBookManager.getBook(intent.exchange, intent.symbol)?.cachedMidPrice ?? 0;

        order.status = "filled";
        order.filledQty = intent.qty;
        order.avgFillPrice = new Decimal(fillPrice);

        bus.emit("order:filled", {
          id,
          fillPrice,
          fillQty: intent.qty.toNumber(),
          slippageBps: 0,
          symbol: intent.symbol,
          exchange: intent.exchange,
          side: intent.side,
          direction: intent.signal.direction,
        });

        log.info({
          id,
          chain,
          txHash: result.txHash,
          walletOrderId: result.orderId,
          signedBy: result.signedBy,
        }, "Wallet order filled");
      } else {
        this.rejectOrder(id, `Wallet signing failed: ${result.error}`);
      }
    } catch (err) {
      log.error({ id, err }, "Wallet execution failed");
      this.rejectOrder(id, `Wallet error: ${(err as Error).message}`);
    }
  }

  /**
   * Map exchange name to wallet chain identifier.
   */
  private exchangeToChain(exchange: Exchange): string {
    switch (exchange) {
      case "binance": return "arbitrum"; // default EVM chain for CEX-like trading
      default: return "dydx"; // dYdX is the primary target
    }
  }

  /**
   * Estimate slippage by walking the order book.
   *
   * For a buy order of qty Q, walk up the ask side
   * accumulating fills until Q is satisfied. The volume-weighted
   * average fill price minus the mid price gives slippage.
   */
  private estimateSlippage(
    intent: OrderIntent,
    book: ReturnType<typeof orderBookManager.getBook> & {},
  ): number {
    const levels = intent.side === "buy" ? book.asks : book.bids;
    const mid = book.cachedMidPrice;
    if (mid === 0 || levels.length === 0) return 0;

    let remainingQty = intent.qty.toNumber();
    let totalCost = 0;

    for (const level of levels) {
      const levelQty = level.qty.toNumber();
      const fillQty = Math.min(remainingQty, levelQty);
      totalCost += fillQty * level.price.toNumber();
      remainingQty -= fillQty;
      if (remainingQty <= 0) break;
    }

    if (remainingQty > 0) return 100; // Can't fill — extreme slippage

    const avgPrice = totalCost / intent.qty.toNumber();
    return Math.abs((avgPrice - mid) / mid) * 10000;
  }

  private cancelOrder(id: string, reason: string): void {
    const order = this.orders.get(id);
    if (order) {
      order.status = "cancelled";
      bus.emit("order:cancelled", { id, reason });
      log.debug({ id, reason }, "Order cancelled");
    }
  }

  private rejectOrder(id: string, reason: string): void {
    const order = this.orders.get(id);
    if (order) {
      order.status = "rejected";
      bus.emit("order:rejected", { id, reason });
      log.warn({ id, reason }, "Order rejected");
    }
  }

  get stats() {
    const states = { pending: 0, submitted: 0, filled: 0, cancelled: 0, rejected: 0, partial: 0 };
    for (const order of this.orders.values()) {
      states[order.status]++;
    }
    return { ...states, total: this.orders.size };
  }
}
