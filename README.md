# CriterionX Trading Engine

Algorithmic crypto trading engine that finds microstructure edge in order book data using ML, AI agents, and real-time analysis.

> Part of the **CriterionX ecosystem**: [Trading Engine](https://github.com/tomymaritano/trading-engine) · [Dashboard](https://github.com/tomymaritano/trading-dashboard) · [Wallet](https://github.com/tomymaritano/criterionx-wallet)

## What It Does

Connects to crypto exchanges via WebSocket, analyzes order book microstructure in real-time, and generates trading signals when it detects exploitable patterns.

```
Market Data → Feature Engine → ML Model → Signal → Risk Gate → Execution
              (30+ features)   (LightGBM)         (CriterionX)  (Binance/dYdX)
```

## Key Results

| Metric | Value |
|--------|-------|
| Best edge | ETH book imbalance > 0.95 at 15s horizon |
| Win rate | 73% |
| Expected return | 1.37 bps per trade |
| IC (ETH) | 0.20 |
| Profitable on | dYdX (0% maker fee) |

## Features

- **5 strategies**: composite alpha, book imbalance, liquidation cascade, volatility regime, cross-exchange
- **30+ microstructure features**: imbalance, trade flow, realized vol, spread volatility, buy pressure, depth ratio
- **AI agents**: LLM sentiment (Claude Haiku + Reddit), Bull/Bear debate before trades
- **ML model**: LightGBM (AUC 0.60), auto-retrain pipeline
- **5 exchange adapters**: Binance (spot + futures), dYdX v4, Kraken, OKX
- **Risk engine**: CriterionX decision engine with 8 rule checks per trade
- **Execution**: paper trading, Binance Futures live, wallet bridge for on-chain
- **Real-time dashboard**: WebSocket server broadcasting state at 500ms
- **Monitoring**: Prometheus metrics, Telegram alerts, trade journal

## Tech Stack

Node.js · TypeScript · Python (ML) · LightGBM · WebSocket · Prometheus

## Quick Start

```bash
npm install && npm run dev        # Paper trading mode
npm test                          # 65 unit tests
cd ml && uvicorn server:app       # ML prediction server
```

## Docker (full stack)

```bash
cd .. && make up   # Engine + Dashboard + ML + TimescaleDB + Redis + Prometheus + Grafana
```

## Related

- **[Trading Dashboard](https://github.com/tomymaritano/trading-dashboard)** — Next.js UI with candlestick charts, order book, RSI/MACD/BB indicators
- **[CriterionX Wallet](https://github.com/tomymaritano/criterionx-wallet)** — Crypto wallet for on-chain trade signing (dYdX, Arbitrum, Base)

## License

MIT
