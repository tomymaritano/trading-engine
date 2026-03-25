"""
Train ML model for trade signal filtering.

Goal: predict which signals have edge > 2 bps (profitable after fees)
vs signals that will lose money.

Input: 10 microstructure features per snapshot
Output: probability of profitable trade at 15s horizon

Model: LightGBM (fast, handles tabular data well, no GPU needed)

Usage:
    pip install lightgbm scikit-learn pandas numpy
    python ml/train_model.py
"""

import json
import os
import sys
from pathlib import Path
from collections import defaultdict
import numpy as np

# Check for required packages
try:
    import lightgbm as lgb
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.metrics import accuracy_score, classification_report, roc_auc_score
except ImportError:
    print("Install required packages:")
    print("  pip install lightgbm scikit-learn numpy")
    sys.exit(1)


def load_capture_data(capture_dir: str) -> tuple[list, list]:
    """Load book snapshots and trades from capture directory."""
    books = []
    trades = []

    for date_dir in sorted(Path(capture_dir).iterdir()):
        if date_dir.name.startswith("."):
            continue

        book_file = date_dir / "book.ndjson"
        trade_file = date_dir / "trades.ndjson"

        if book_file.exists():
            with open(book_file) as f:
                for line in f:
                    try:
                        d = json.loads(line)
                        if d.get("bids"):
                            books.append(d)
                    except:
                        pass

        if trade_file.exists():
            with open(trade_file) as f:
                for line in f:
                    try:
                        d = json.loads(line)
                        if d.get("type") == "trade":
                            trades.append(d)
                    except:
                        pass

    return books, trades


def build_features(books: list, trades: list, symbol: str = "ETH-USDT") -> tuple[np.ndarray, np.ndarray]:
    """Build feature matrix and labels from raw data."""

    # Filter by symbol
    sym_books = [b for b in books if b.get("symbol") == symbol]
    sym_trades = [t for t in trades if t.get("symbol") == symbol]

    print(f"  {symbol}: {len(sym_books)} books, {len(sym_trades)} trades")

    if len(sym_books) < 100:
        print(f"  Not enough data for {symbol}")
        return np.array([]), np.array([])

    # Sort by timestamp
    events = []
    for b in sym_books:
        events.append({"ts": b["ts"], "type": "book", "data": b})
    for t in sym_trades:
        events.append({"ts": t["ts"], "type": "trade", "data": t})
    events.sort(key=lambda x: x["ts"])

    # Build snapshots
    current_book = None
    recent_trades = []
    snapshots = []  # (ts, features_dict, mid_price)
    last_ts = 0

    for event in events:
        if event["type"] == "book":
            current_book = event["data"]
            continue

        trade = event["data"]
        recent_trades.append(trade)

        # Keep 5s window
        cutoff = event["ts"] - 5000
        recent_trades = [t for t in recent_trades if t["ts"] > cutoff]

        if event["ts"] - last_ts < 1000 or current_book is None or len(recent_trades) < 2:
            continue
        last_ts = event["ts"]

        bids = [(float(p), float(q)) for p, q in current_book["bids"]]
        asks = [(float(p), float(q)) for p, q in current_book["asks"]]

        if not bids or not asks:
            continue

        mid = (bids[0][0] + asks[0][0]) / 2
        spread = asks[0][0] - bids[0][0]

        # Book features
        bid_qty_5 = sum(q for _, q in bids[:5])
        ask_qty_5 = sum(q for _, q in asks[:5])
        bid_qty_20 = sum(q for _, q in bids[:20])
        ask_qty_20 = sum(q for _, q in asks[:20])
        bid_depth = sum(p * q for p, q in bids[:20])
        ask_depth = sum(p * q for p, q in asks[:20])

        total_qty = bid_qty_5 + ask_qty_5
        imbalance_5 = (bid_qty_5 - ask_qty_5) / total_qty if total_qty > 0 else 0
        total_qty_20 = bid_qty_20 + ask_qty_20
        imbalance_20 = (bid_qty_20 - ask_qty_20) / total_qty_20 if total_qty_20 > 0 else 0
        depth_ratio = bid_depth / ask_depth if ask_depth > 0 else 1

        # Trade flow features
        buy_vol = sum(float(t["q"]) for t in recent_trades if t["s"] == "buy")
        sell_vol = sum(float(t["q"]) for t in recent_trades if t["s"] == "sell")
        total_vol = buy_vol + sell_vol
        trade_imbalance = (buy_vol - sell_vol) / total_vol if total_vol > 0 else 0
        trade_intensity = len(recent_trades) / 5  # trades per second

        # Volatility (simple: spread as % of mid)
        spread_pct = spread / mid if mid > 0 else 0

        features = {
            "imbalance_5": imbalance_5,
            "imbalance_20": imbalance_20,
            "trade_imbalance": trade_imbalance,
            "depth_ratio": depth_ratio,
            "spread_pct": spread_pct,
            "trade_intensity": trade_intensity,
            "bid_depth_norm": bid_depth / mid if mid > 0 else 0,
            "ask_depth_norm": ask_depth / mid if mid > 0 else 0,
            "buy_pressure": buy_vol - sell_vol,
            "imb_x_flow": imbalance_5 * trade_imbalance,  # interaction feature
        }

        snapshots.append((event["ts"], features, mid))

    # Compute labels: will price go up by > threshold in 15s?
    print(f"  Snapshots: {len(snapshots)}")

    FEATURE_NAMES = list(snapshots[0][1].keys()) if snapshots else []
    X = []
    y = []

    for i in range(len(snapshots)):
        ts_i, feat_i, mid_i = snapshots[i]

        # Find price 15s later
        future_mid = None
        for j in range(i + 1, len(snapshots)):
            dt = snapshots[j][0] - ts_i
            if 13000 <= dt <= 17000:
                future_mid = snapshots[j][2]
                break
            if dt > 20000:
                break

        if future_mid is None:
            continue

        ret = (future_mid - mid_i) / mid_i

        # Direction-adjusted return (positive if imbalance predicts correctly)
        direction = 1 if feat_i["imbalance_5"] > 0 else -1
        adj_ret = ret * direction

        # Label: 1 if profitable (> 2 bps after direction adjustment), 0 otherwise
        label = 1 if adj_ret > 0.0002 else 0  # 2 bps threshold

        feature_array = [feat_i[name] for name in FEATURE_NAMES]
        X.append(feature_array)
        y.append(label)

    X = np.array(X)
    y = np.array(y)

    print(f"  Labeled samples: {len(X)}")
    print(f"  Positive rate: {y.mean():.1%}")
    print(f"  Features: {FEATURE_NAMES}")

    return X, y


def train_model(X: np.ndarray, y: np.ndarray) -> lgb.Booster:
    """Train LightGBM model with time-series cross-validation."""

    print("\n=== Training LightGBM ===")

    # Time-series split (no shuffling — respects temporal order)
    tscv = TimeSeriesSplit(n_splits=3)

    best_auc = 0
    best_model = None
    fold_results = []

    for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]

        train_data = lgb.Dataset(X_train, label=y_train)
        valid_data = lgb.Dataset(X_test, label=y_test, reference=train_data)

        params = {
            "objective": "binary",
            "metric": "auc",
            "learning_rate": 0.05,
            "num_leaves": 15,        # small to prevent overfitting
            "min_data_in_leaf": 50,
            "max_depth": 4,
            "feature_fraction": 0.8,
            "bagging_fraction": 0.8,
            "bagging_freq": 5,
            "verbose": -1,
        }

        model = lgb.train(
            params,
            train_data,
            num_boost_round=200,
            valid_sets=[valid_data],
            callbacks=[lgb.early_stopping(20), lgb.log_evaluation(0)],
        )

        # Evaluate
        y_pred_proba = model.predict(X_test)
        y_pred = (y_pred_proba > 0.5).astype(int)
        auc = roc_auc_score(y_test, y_pred_proba)
        acc = accuracy_score(y_test, y_pred)

        fold_results.append({"fold": fold + 1, "auc": auc, "acc": acc, "samples": len(y_test)})
        print(f"  Fold {fold + 1}: AUC={auc:.4f} Acc={acc:.1%} Samples={len(y_test)}")

        if auc > best_auc:
            best_auc = auc
            best_model = model

    # Feature importance
    print(f"\n  Best AUC: {best_auc:.4f}")
    print(f"\n  Feature Importance:")
    importance = best_model.feature_importance(importance_type="gain")
    feature_names = [
        "imbalance_5", "imbalance_20", "trade_imbalance", "depth_ratio",
        "spread_pct", "trade_intensity", "bid_depth_norm", "ask_depth_norm",
        "buy_pressure", "imb_x_flow",
    ]
    for name, imp in sorted(zip(feature_names, importance), key=lambda x: -x[1]):
        bar = "█" * int(imp / max(importance) * 30)
        print(f"    {name:>20}: {bar} ({imp:.0f})")

    return best_model


def save_model(model: lgb.Booster, output_dir: str = "ml/models"):
    """Save model for serving."""
    os.makedirs(output_dir, exist_ok=True)

    model_path = os.path.join(output_dir, "signal_filter.txt")
    model.save_model(model_path)
    print(f"\n  Model saved to {model_path}")

    # Also save as ONNX for Node.js serving (optional)
    try:
        import onnxmltools
        from onnxmltools.convert import convert_lightgbm
        from onnxmltools.utils import FloatTensorType

        initial_types = [("features", FloatTensorType([None, 10]))]
        onnx_model = convert_lightgbm(model, initial_types=initial_types)
        onnx_path = os.path.join(output_dir, "signal_filter.onnx")
        onnxmltools.utils.save_model(onnx_model, onnx_path)
        print(f"  ONNX model saved to {onnx_path}")
    except ImportError:
        print("  (ONNX export skipped — install onnxmltools for Node.js serving)")


def main():
    print("╔══════════════════════════════════════════════╗")
    print("║   ML Model Training — Signal Filter          ║")
    print("║   Predict which trades will be profitable     ║")
    print("╚══════════════════════════════════════════════╝\n")

    capture_dir = "data/capture"

    if not os.path.exists(capture_dir):
        print("No capture data found. Run: npm run capture -- --symbols ETH-USDT --duration 4h")
        sys.exit(1)

    # Load data
    print("Loading capture data...")
    books, trades = load_capture_data(capture_dir)
    print(f"  Total: {len(books)} books, {len(trades)} trades\n")

    # Build features for ETH
    print("Building features for ETH-USDT...")
    X, y = build_features(books, trades, "ETH-USDT")

    if len(X) < 100:
        print("\nNot enough ETH data. Need at least 100 labeled samples.")
        print("Run: npm run capture -- --symbols ETH-USDT --duration 4h")
        sys.exit(1)

    # Train
    model = train_model(X, y)

    # Save
    save_model(model)

    # Summary
    print("\n╔══════════════════════════════════════════════╗")
    print("║   Training Complete                          ║")
    print("╚══════════════════════════════════════════════╝")
    print(f"  Samples: {len(X)}")
    print(f"  Positive rate: {y.mean():.1%}")
    print(f"  Model: ml/models/signal_filter.txt")
    print(f"\n  To serve: python ml/server.py")
    print(f"  The engine will auto-connect to http://localhost:8000")


if __name__ == "__main__":
    main()
