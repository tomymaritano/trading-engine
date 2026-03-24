/** High-resolution timer for latency measurement */
export function microNow(): bigint {
  return process.hrtime.bigint();
}

/** Microseconds elapsed since a previous microNow() call */
export function microElapsed(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1000;
}

/** Format milliseconds into human-readable duration */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Format a timestamp to ISO string */
export function formatTs(ts: number): string {
  return new Date(ts).toISOString();
}

/** Sleep for given milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a timestamp-based ID */
export function tsId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
