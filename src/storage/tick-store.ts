import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { createChildLogger } from "../utils/logger.js";
import type { Trade, MarketEvent, Exchange, Symbol } from "../types/market.js";

const log = createChildLogger("tick-store");

/**
 * File-based tick storage engine.
 *
 * Stores market events as newline-delimited JSON (NDJSON), compressed
 * with gzip. Each file covers one hour of data for one exchange:symbol pair.
 *
 * File layout:
 *   data/ticks/{exchange}/{symbol}/2024-01-15/14.ndjson.gz
 *
 * Why file-based instead of TimescaleDB for MVP?
 * - Zero infrastructure dependency
 * - Gzip NDJSON is ~10x smaller than raw JSON
 * - Sequential reads are fast (backtesting reads sequentially)
 * - Easy to rsync between machines
 * - TimescaleDB can be added later as a hot storage tier
 *
 * Write path: events buffered in memory, flushed every 5s or 10k events.
 * Read path: streaming gunzip → line-by-line parse → iterator.
 */
export class TickStore {
  private buffers = new Map<string, MarketEvent[]>();
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private writeCount = 0;
  private readonly flushIntervalMs = 5000;
  private readonly maxBufferSize = 10_000;

  constructor(private readonly baseDir: string = "data/ticks") {}

  start(): void {
    mkdirSync(this.baseDir, { recursive: true });

    this.flushInterval = setInterval(() => {
      this.flushAll();
    }, this.flushIntervalMs);

    log.info({ baseDir: this.baseDir }, "Tick store started");
  }

  async stop(): Promise<void> {
    if (this.flushInterval) clearInterval(this.flushInterval);
    await this.flushAll();
    log.info({ totalWrites: this.writeCount }, "Tick store stopped");
  }

  /** Append an event to the write buffer */
  append(event: MarketEvent): void {
    const key = this.bufferKey(event);
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = [];
      this.buffers.set(key, buf);
    }
    buf.push(event);

    if (buf.length >= this.maxBufferSize) {
      this.flushBuffer(key, buf);
      this.buffers.set(key, []);
    }
  }

  /** Flush all buffers to disk */
  async flushAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [key, buf] of this.buffers) {
      if (buf.length > 0) {
        promises.push(this.flushBuffer(key, buf));
        this.buffers.set(key, []);
      }
    }
    await Promise.all(promises);
  }

  /**
   * Read events for a date range.
   * Returns an async generator for memory-efficient streaming.
   */
  async *read(
    exchange: Exchange,
    symbol: Symbol,
    startTs: number,
    endTs: number,
  ): AsyncGenerator<MarketEvent> {
    const startDate = new Date(startTs);
    const endDate = new Date(endTs);

    // Iterate over each day in range
    const current = new Date(startDate);
    current.setUTCHours(0, 0, 0, 0);

    while (current <= endDate) {
      const dateStr = current.toISOString().split("T")[0];
      const dayDir = join(this.baseDir, exchange, symbol.replace("/", "-"), dateStr);

      if (existsSync(dayDir)) {
        // Read each hour file
        const files = await readdir(dayDir);
        const hourFiles = files.filter((f) => f.endsWith(".ndjson.gz")).sort();

        for (const file of hourFiles) {
          const filePath = join(dayDir, file);
          yield* this.readFile(filePath, startTs, endTs);
        }
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }
  }

  /** Count events in a date range */
  async count(
    exchange: Exchange,
    symbol: Symbol,
    startTs: number,
    endTs: number,
  ): Promise<number> {
    let count = 0;
    for await (const _ of this.read(exchange, symbol, startTs, endTs)) {
      count++;
    }
    return count;
  }

  /** List available date ranges for an exchange:symbol pair */
  async listRanges(exchange: Exchange, symbol: Symbol): Promise<string[]> {
    const dir = join(this.baseDir, exchange, symbol.replace("/", "-"));
    if (!existsSync(dir)) return [];
    const dates = await readdir(dir);
    return dates.sort();
  }

  // ── Private ─────────────────────────────────────────────────

  private bufferKey(event: MarketEvent): string {
    const data = event.data;
    const ts = "ts" in data ? data.ts : Date.now();
    const date = new Date(ts);
    const hour = date.getUTCHours();
    const dateStr = date.toISOString().split("T")[0];
    return `${data.exchange}/${data.symbol.replace("/", "-")}/${dateStr}/${hour}`;
  }

  private async flushBuffer(key: string, events: MarketEvent[]): Promise<void> {
    if (events.length === 0) return;

    const filePath = join(this.baseDir, `${key}.ndjson.gz`);
    const dir = join(filePath, "..");
    mkdirSync(dir, { recursive: true });

    // Serialize events as NDJSON
    const lines = events.map((e) => JSON.stringify(this.serializeEvent(e)));
    const content = lines.join("\n") + "\n";

    // Append (gzip) to file
    const writeStream = createWriteStream(filePath, { flags: "a" });
    const gzip = createGzip({ level: 6 });

    await pipeline(Readable.from(content), gzip, writeStream);

    this.writeCount += events.length;
  }

  private async *readFile(
    filePath: string,
    startTs: number,
    endTs: number,
  ): AsyncGenerator<MarketEvent> {
    const gunzip = createGunzip();
    const fileStream = createReadStream(filePath);

    const rl = createInterface({
      input: fileStream.pipe(gunzip),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = this.deserializeEvent(JSON.parse(line));
        const ts = "ts" in event.data ? event.data.ts : 0;
        if (ts >= startTs && ts <= endTs) {
          yield event;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  /** Serialize Decimal.js values to strings for JSON storage */
  private serializeEvent(event: MarketEvent): Record<string, unknown> {
    const data = event.data as unknown as Record<string, unknown>;
    const serialized: Record<string, unknown> = { type: event.type };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "toFixed" in v) {
        serialized[k] = (v as { toString(): string }).toString();
      } else if (typeof v === "bigint") {
        serialized[k] = v.toString();
      } else {
        serialized[k] = v;
      }
    }
    return serialized;
  }

  /** Deserialize stored events back into typed MarketEvents */
  private deserializeEvent(raw: Record<string, unknown>): MarketEvent {
    // Simplified: return as-is with type tag. Full deserialization
    // with Decimal reconstruction happens in the consumer.
    return raw as unknown as MarketEvent;
  }
}
