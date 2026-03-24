import { createChildLogger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";
import type { FeatureVector } from "../types/signals.js";

const log = createChildLogger("ml-bridge");

interface PredictionResult {
  /** Predicted price change (as fraction, e.g., 0.001 = 0.1%) */
  predictedReturn: number;
  /** Probability of up move */
  probUp: number;
  /** Probability of down move */
  probDown: number;
  /** Model confidence (0-1) */
  confidence: number;
  /** Prediction horizon in seconds */
  horizon: number;
  /** Model name that produced this */
  model: string;
  /** Inference latency in ms */
  latencyMs: number;
}

/**
 * ML Model Bridge — connects to external ML prediction services.
 *
 * Architecture options (in order of recommendation):
 *
 * 1. HTTP/JSON API (simplest, good for <100ms latency)
 *    - Python FastAPI serving ONNX/TorchScript models
 *    - Works with any ML framework
 *    - Deploy alongside the engine in Docker Compose
 *
 * 2. gRPC (lower latency, schema-enforced)
 *    - Protobuf serialization is ~10x faster than JSON
 *    - Use when latency matters (<10ms)
 *    - Requires .proto file maintenance
 *
 * 3. ONNX Runtime in Node.js (zero-network-hop)
 *    - `onnxruntime-node` runs models directly
 *    - Best latency (<5ms), but limited to ONNX-exportable models
 *    - Can't use Python-only features (custom layers, etc.)
 *
 * This bridge supports option 1 (HTTP) as the default, with
 * a placeholder for ONNX Runtime integration.
 */
export class MLBridge {
  private serviceUrl: string;
  private available = false;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(serviceUrl = "http://localhost:8000") {
    this.serviceUrl = serviceUrl;
  }

  async start(): Promise<void> {
    await this.checkHealth();

    // Periodic health check every 30s
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth();
    }, 30_000);
  }

  stop(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
  }

  get isAvailable(): boolean {
    return this.available;
  }

  /**
   * Get prediction for a feature vector.
   *
   * Expected Python API contract:
   *
   * POST /predict
   * Body: { features: number[], horizon: number }
   * Response: { predicted_return, prob_up, prob_down, confidence, model }
   */
  async predict(features: FeatureVector, horizon = 30): Promise<PredictionResult | null> {
    if (!this.available) return null;

    const startTs = Date.now();

    try {
      const featureArray = this.vectorToArray(features);

      const res = await fetch(`${this.serviceUrl}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: featureArray,
          horizon,
          symbol: features.symbol,
          timestamp: features.ts,
        }),
        signal: AbortSignal.timeout(500), // 500ms timeout — ML should be fast
      });

      if (!res.ok) {
        log.warn({ status: res.status }, "ML prediction failed");
        return null;
      }

      const data = await res.json() as {
        predicted_return: number;
        prob_up: number;
        prob_down: number;
        confidence: number;
        model: string;
      };

      return {
        predictedReturn: data.predicted_return,
        probUp: data.prob_up,
        probDown: data.prob_down,
        confidence: data.confidence,
        horizon,
        model: data.model,
        latencyMs: Date.now() - startTs,
      };
    } catch (err) {
      // Don't spam logs on timeout
      if ((err as Error).name !== "TimeoutError") {
        log.warn({ err }, "ML prediction error");
      }
      return null;
    }
  }

  /**
   * Batch predict — send multiple feature vectors at once.
   * More efficient than individual calls (single HTTP roundtrip).
   */
  async batchPredict(
    features: FeatureVector[],
    horizon = 30,
  ): Promise<(PredictionResult | null)[]> {
    if (!this.available || features.length === 0) {
      return features.map(() => null);
    }

    const startTs = Date.now();

    try {
      const batch = features.map((f) => ({
        features: this.vectorToArray(f),
        symbol: f.symbol,
        horizon,
      }));

      const res = await fetch(`${this.serviceUrl}/predict/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch }),
        signal: AbortSignal.timeout(2000),
      });

      if (!res.ok) return features.map(() => null);

      const data = await res.json() as {
        predictions: Array<{
          predicted_return: number;
          prob_up: number;
          prob_down: number;
          confidence: number;
          model: string;
        }>;
      };

      const latencyMs = Date.now() - startTs;

      return data.predictions.map((p) => ({
        predictedReturn: p.predicted_return,
        probUp: p.prob_up,
        probDown: p.prob_down,
        confidence: p.confidence,
        horizon,
        model: p.model,
        latencyMs,
      }));
    } catch {
      return features.map(() => null);
    }
  }

  /**
   * Convert FeatureVector to a flat number array for ML input.
   *
   * IMPORTANT: this ordering must match the training pipeline.
   * Any change here requires retraining models.
   */
  private vectorToArray(f: FeatureVector): number[] {
    return [
      f.bidAskSpread,
      f.midPrice,
      f.weightedMidPrice,
      f.bookImbalance,
      f.bookImbalanceTop5,
      f.bookImbalanceTop20,
      f.bookDepthBid,
      f.bookDepthAsk,
      f.bidAskSlope,
      f.tradeImbalance,
      f.vwap,
      f.volumeAcceleration,
      f.largeTradeRatio,
      f.buyPressure,
      f.aggTradeIntensity,
      f.realizedVol,
      f.volOfVol,
      f.returnSkew,
      f.returnKurtosis,
      f.parkinsonVol,
      f.liquidityScore,
      f.spreadVolatility,
      f.depthResilience,
      f.exchangeSpread,
      f.leadLagScore,
      f.regimeConfidence,
      f.fundingRate,
      f.liquidationPressure,
      f.openInterestDelta,
    ];
  }

  private async checkHealth(): Promise<void> {
    try {
      const res = await fetch(`${this.serviceUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      this.available = res.ok;
      if (this.available) {
        log.debug("ML service available");
      }
    } catch {
      if (this.available) {
        log.warn("ML service unavailable");
      }
      this.available = false;
    }
  }
}
