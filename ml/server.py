"""
ML Prediction Server for Trading Engine.

Serves micro-movement predictions via HTTP API.
Run with: uvicorn ml.server:app --port 8000

Architecture:
  - FastAPI for HTTP serving (async, fast)
  - ONNX Runtime for model inference (<5ms per prediction)
  - Feature normalization from training stats

Models supported:
  1. LightGBM (default) — fast, interpretable, good baseline
  2. Temporal Fusion Transformer — best accuracy, slower
  3. Simple LSTM — middle ground

For production, export models to ONNX format for cross-platform
inference. Training happens in Jupyter notebooks, serving happens here.
"""

from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
from typing import Optional
import time
import logging

logger = logging.getLogger(__name__)
app = FastAPI(title="Trading ML Server", version="0.1.0")

# ── Feature configuration ──────────────────────────────────────────
# Must match the feature vector ordering in ml-bridge.ts
FEATURE_NAMES = [
    "bidAskSpread", "midPrice", "weightedMidPrice",
    "bookImbalance", "bookImbalanceTop5", "bookImbalanceTop20",
    "bookDepthBid", "bookDepthAsk", "bidAskSlope",
    "tradeImbalance", "vwap", "volumeAcceleration",
    "largeTradeRatio", "buyPressure", "aggTradeIntensity",
    "realizedVol", "volOfVol", "returnSkew", "returnKurtosis",
    "parkinsonVol", "liquidityScore", "spreadVolatility",
    "depthResilience", "exchangeSpread", "leadLagScore",
    "regimeConfidence", "fundingRate", "liquidationPressure",
    "openInterestDelta",
]

NUM_FEATURES = len(FEATURE_NAMES)


# ── Request/Response models ────────────────────────────────────────

class PredictRequest(BaseModel):
    features: list[float]
    horizon: int = 30
    symbol: Optional[str] = None
    timestamp: Optional[int] = None


class BatchPredictRequest(BaseModel):
    batch: list[PredictRequest]


class PredictionResponse(BaseModel):
    predicted_return: float
    prob_up: float
    prob_down: float
    confidence: float
    model: str


class BatchPredictionResponse(BaseModel):
    predictions: list[PredictionResponse]


# ── Model ──────────────────────────────────────────────────────────

class BaselineModel:
    """
    Simple heuristic model for development.

    Uses book imbalance + trade imbalance as a linear predictor.
    Replace with trained LightGBM/ONNX model in production.

    Production upgrade path:
      1. Collect features + labels (future 30s return)
      2. Train LightGBM: lgb.train(params, train_data)
      3. Export: model.save_model("model.txt")
      4. Load here: lgb.Booster(model_file="model.txt")
      5. Or export to ONNX: onnxmltools.convert_lightgbm(model)
    """

    def __init__(self):
        self.name = "baseline_heuristic_v1"
        # Feature indices (matching the array order)
        self.idx_book_imbalance = 4      # bookImbalanceTop5
        self.idx_trade_imbalance = 9     # tradeImbalance
        self.idx_realized_vol = 15       # realizedVol
        self.idx_liquidity_score = 20    # liquidityScore
        self.idx_buy_pressure = 13       # buyPressure

    def predict(self, features: np.ndarray) -> PredictionResponse:
        """Predict for a single feature vector."""
        if len(features) < NUM_FEATURES:
            features = np.pad(features, (0, NUM_FEATURES - len(features)))

        book_imb = features[self.idx_book_imbalance]
        trade_imb = features[self.idx_trade_imbalance]
        vol = max(features[self.idx_realized_vol], 0.001)
        liquidity = features[self.idx_liquidity_score]

        # Simple linear combination
        raw_signal = 0.4 * book_imb + 0.4 * trade_imb + 0.2 * (book_imb * trade_imb)

        # Scale by volatility (higher vol = larger expected move)
        predicted_return = raw_signal * vol * 0.1

        # Convert to probabilities using sigmoid
        prob_up = 1 / (1 + np.exp(-raw_signal * 3))
        prob_down = 1 - prob_up

        # Confidence: higher when signals agree and liquidity is good
        signal_agreement = abs(book_imb) * abs(trade_imb)
        confidence = min(0.9, 0.3 + signal_agreement * 2 + liquidity * 0.2)

        return PredictionResponse(
            predicted_return=float(predicted_return),
            prob_up=float(prob_up),
            prob_down=float(prob_down),
            confidence=float(confidence),
            model=self.name,
        )

    def predict_batch(self, features_batch: np.ndarray) -> list[PredictionResponse]:
        """Predict for a batch of feature vectors."""
        return [self.predict(f) for f in features_batch]


# ── Model instance ─────────────────────────────────────────────────
model = BaselineModel()


# ── Endpoints ──────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "model": model.name, "features": NUM_FEATURES}


@app.post("/predict", response_model=PredictionResponse)
async def predict(req: PredictRequest):
    features = np.array(req.features, dtype=np.float64)
    return model.predict(features)


@app.post("/predict/batch", response_model=BatchPredictionResponse)
async def predict_batch(req: BatchPredictRequest):
    features_batch = np.array(
        [r.features for r in req.batch], dtype=np.float64
    )
    predictions = model.predict_batch(features_batch)
    return BatchPredictionResponse(predictions=predictions)


@app.get("/features")
async def feature_info():
    """Return feature names and expected ordering."""
    return {
        "features": FEATURE_NAMES,
        "count": NUM_FEATURES,
        "note": "Feature array must follow this exact ordering",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
