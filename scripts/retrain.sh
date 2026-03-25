#!/bin/bash
# Auto-retrain ML model with latest capture data
# Run via cron: 0 */6 * * * cd /path/to/trading-engine && ./scripts/retrain.sh

set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

LOG="data/retrain.log"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

echo "[$TIMESTAMP] Starting retrain..." >> "$LOG"

# Check if capture data exists
if [ ! -d "data/capture" ]; then
  echo "[$TIMESTAMP] No capture data found, skipping" >> "$LOG"
  exit 0
fi

# Train model
python3 ml/train_model.py >> "$LOG" 2>&1

if [ $? -eq 0 ]; then
  echo "[$TIMESTAMP] Retrain successful" >> "$LOG"

  # Restart ML server if running
  pkill -f "uvicorn.*server:app" 2>/dev/null || true
  sleep 1
  cd ml && nohup python3 -m uvicorn server:app --host 0.0.0.0 --port 8000 >> "../$LOG" 2>&1 &
  echo "[$TIMESTAMP] ML server restarted" >> "$LOG"
else
  echo "[$TIMESTAMP] Retrain failed" >> "$LOG"
fi
