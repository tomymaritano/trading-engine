/**
 * Numerical utilities for quantitative computations.
 * All operate on plain number[] for speed — avoid Decimal overhead
 * in the hot path of feature computation.
 */

/** Exponential moving average with decay factor α */
export function ema(values: number[], alpha: number): number {
  if (values.length === 0) return 0;
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = alpha * values[i] + (1 - alpha) * result;
  }
  return result;
}

/** Rolling standard deviation (population) */
export function stddev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

/** Skewness of a distribution */
export function skewness(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = stddev(values);
  if (sd === 0) return 0;
  const m3 = values.reduce((sum, v) => sum + ((v - mean) / sd) ** 3, 0) / n;
  return m3;
}

/** Excess kurtosis (normal distribution = 0) */
export function kurtosis(values: number[]): number {
  const n = values.length;
  if (n < 4) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = stddev(values);
  if (sd === 0) return 0;
  const m4 = values.reduce((sum, v) => sum + ((v - mean) / sd) ** 4, 0) / n;
  return m4 - 3; // excess kurtosis
}

/**
 * Parkinson volatility estimator (high-low).
 * More efficient than close-to-close: uses 5x less data for same accuracy.
 * Input: array of { high, low } pairs.
 */
export function parkinsonVolatility(bars: { high: number; low: number }[]): number {
  const n = bars.length;
  if (n === 0) return 0;
  const sumSq = bars.reduce((sum, { high, low }) => {
    const logRatio = Math.log(high / low);
    return sum + logRatio * logRatio;
  }, 0);
  return Math.sqrt(sumSq / (4 * n * Math.LN2));
}

/**
 * Weighted mid price — more accurate than simple (bid+ask)/2.
 * Weights by inverse of depth: if ask has less depth, mid shifts toward ask
 * because it's more likely the next trade moves that direction.
 */
export function weightedMidPrice(
  bidPrice: number, bidQty: number,
  askPrice: number, askQty: number,
): number {
  const totalQty = bidQty + askQty;
  if (totalQty === 0) return (bidPrice + askPrice) / 2;
  // Imbalance-weighted: more weight to the side with more depth
  return (bidPrice * askQty + askPrice * bidQty) / totalQty;
}

/**
 * Book imbalance ratio: measures directional pressure.
 * +1 = all depth on bid side (bullish), -1 = all on ask side (bearish)
 */
export function bookImbalance(bidQty: number, askQty: number): number {
  const total = bidQty + askQty;
  if (total === 0) return 0;
  return (bidQty - askQty) / total;
}

/**
 * Volume-Weighted Average Price over a window of trades.
 */
export function vwap(trades: { price: number; qty: number }[]): number {
  let totalNotional = 0;
  let totalQty = 0;
  for (const t of trades) {
    totalNotional += t.price * t.qty;
    totalQty += t.qty;
  }
  return totalQty > 0 ? totalNotional / totalQty : 0;
}

/** Percentile of a sorted array (linear interpolation) */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

/** Clamp a value to [min, max] */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Linear regression slope (least squares) */
export function linearSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += ys[i];
    sumXY += i * ys[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
