# CriterionX — Trading Intelligence Engine

Sistema de trading algorítmico para criptomonedas. Analiza microestructura del mercado, order flow y regímenes de volatilidad para detectar oportunidades en tiempo real.

```
Exchange WS → Adapters → EventBus → OrderBook → Features → Strategies → Risk → Execution
                                                     ↓
                                              Dashboard (WS :3001)
                                                     ↓
                                              Next.js UI (:3000)
```

---

## Arquitectura

```
┌──────────────────────────────────────────────────────────────────────┐
│                     TRADING INTELLIGENCE ENGINE                      │
│                                                                      │
│  INGESTION            PROCESSING            INTELLIGENCE             │
│  ┌──────────────┐    ┌───────────────┐     ┌──────────────────────┐  │
│  │ Binance WS   │───▶│ OrderBook Mgr │────▶│ Feature Engine       │  │
│  │ Kraken WS    │    │ (L2 depth)    │     │ (30+ features/tick)  │  │
│  │ OKX WS       │    └───────────────┘     ├──────────────────────┤  │
│  └──────────────┘                          │ Whale Detector       │  │
│                                            │ Sentiment Engine     │  │
│  REST CLIENTS                              │ Cross-Exchange       │  │
│  ┌──────────────┐                          └──────────┬───────────┘  │
│  │ Binance REST │    STRATEGIES                       │              │
│  │ Kraken REST  │    ┌───────────────┐     ┌──────────▼───────────┐  │
│  │ OKX REST     │    │ Composite α   │◀────│ Strategy Orchestrator│  │
│  └──────────────┘    │ Book Imbalance│     │ (merge + regime gate)│  │
│                      │ Liq. Cascade  │     └──────────┬───────────┘  │
│                      │ Vol Regime    │                │              │
│                      │ Cross-Exch    │     ┌──────────▼───────────┐  │
│                      └───────────────┘     │ Risk Engine          │  │
│                                            │ Kelly sizing         │  │
│  EXECUTION                                 │ Circuit breakers     │  │
│  ┌──────────────┐                          │ Kill switch          │  │
│  │ Smart Router │◀─────────────────────────┤                      │  │
│  │ Paper + Live │                          └──────────────────────┘  │
│  │ Slippage Ctrl│                                                    │
│  └──────────────┘    OBSERVABILITY                                   │
│                      ┌──────────────────────────────────────────┐    │
│  STORAGE             │ Prometheus Metrics │ Pino Logs │ WS API  │    │
│  ┌──────────────┐    └──────────────────────────────────────────┘    │
│  │ TickStore    │                                                    │
│  │ (NDJSON.gz)  │    DASHBOARD (Next.js)                             │
│  └──────────────┘    ┌──────────────────────────────────────────┐    │
│                      │ Equity Chart │ Signal Feed │ Risk Panel  │    │
│  ML SERVICE (Python) │ Tickers │ Microstructure │ Whale Alerts  │    │
│  ┌──────────────┐    └──────────────────────────────────────────┘    │
│  │ FastAPI      │                                                    │
│  │ ONNX/LightGBM│                                                    │
│  └──────────────┘                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
# Instalar dependencias
cd trading-engine && npm install
cd ../trading-dashboard && npm install

# Correr tests
cd trading-engine && npm test

# Descargar datos históricos (trades, 30 días)
npm run download -- --symbol BTCUSDT --days 30

# Capturar datos de order book en tiempo real (4-6 horas)
npm run capture -- --symbols BTC-USDT --duration 6h

# Optimizar parámetros de estrategias
npm run optimize -- --symbol BTC-USDT --trials 200

# Correr backtest
npm run backtest -- --symbol BTC-USDT --walkforward --steps 5

# Live paper trading
npm run live -- --exchanges binance --symbols BTC-USDT,ETH-USDT

# Dashboard (en otra terminal)
cd trading-dashboard && npm run dev
# Abrir http://localhost:3000
```

---

## Estructura del Proyecto

```
criterionx/
├── trading-engine/                  # Backend: motor de trading (Node.js + TypeScript)
│   ├── src/
│   │   ├── adapters/               # Adaptadores por exchange
│   │   │   ├── base-adapter.ts     # Interface abstracta
│   │   │   ├── binance.ts          # Binance WebSocket (combined streams)
│   │   │   ├── kraken.ts           # Kraken WebSocket v2
│   │   │   ├── okx.ts             # OKX WebSocket v5
│   │   │   └── rest/
│   │   │       ├── binance-rest.ts # Binance REST (descarga histórica)
│   │   │       ├── kraken-rest.ts  # Kraken REST
│   │   │       └── okx-rest.ts     # OKX REST
│   │   ├── ingestion/
│   │   │   └── ws-manager.ts       # Gestor de WebSocket con reconexión
│   │   ├── stream/
│   │   │   └── order-book-manager.ts # Order book local desde deltas
│   │   ├── features/
│   │   │   ├── feature-engine.ts   # 30+ features de microestructura
│   │   │   ├── sentiment.ts        # Fear & Greed + funding + liquidaciones
│   │   │   ├── cross-exchange.ts   # Spread cross-exchange + lead-lag
│   │   │   └── whale-detector.ts   # Detección de icebergs, sweeps, absorption
│   │   ├── models/
│   │   │   ├── strategy-base.ts    # Interface de estrategia
│   │   │   ├── strategy-orchestrator.ts # Merge de señales + filtro por régimen
│   │   │   ├── ml-bridge.ts        # Puente HTTP a servicio ML (Python)
│   │   │   └── strategies/
│   │   │       ├── composite-alpha.ts      # Ensemble de 6 fuentes de alpha
│   │   │       ├── book-imbalance.ts       # Imbalance del order book
│   │   │       ├── liquidation-cascade.ts  # Cascadas de liquidación
│   │   │       ├── volatility-regime.ts    # Transiciones de régimen de vol
│   │   │       └── cross-exchange-spread.ts # Spread cross-exchange
│   │   ├── risk/
│   │   │   └── risk-engine.ts      # Kelly sizing, circuit breakers, kill switch
│   │   ├── execution/
│   │   │   └── execution-engine.ts # Smart order routing, paper + live
│   │   ├── portfolio/
│   │   │   └── portfolio-manager.ts # Tracking de posiciones y PnL
│   │   ├── backtest/
│   │   │   ├── backtester.ts       # Walk-forward backtesting
│   │   │   ├── runner.ts           # CLI para correr backtests
│   │   │   └── optimizer.ts        # Grid search + random search de parámetros
│   │   ├── storage/
│   │   │   └── tick-store.ts       # Almacenamiento NDJSON comprimido
│   │   ├── api/
│   │   │   └── ws-server.ts        # WebSocket API para el dashboard
│   │   ├── dashboard/
│   │   │   └── terminal.ts         # Dashboard ANSI para terminal
│   │   ├── config/
│   │   │   └── index.ts            # Configuración validada con Zod
│   │   ├── types/
│   │   │   ├── market.ts           # Tipos de datos de mercado
│   │   │   └── signals.ts          # Feature vectors, señales, órdenes
│   │   ├── utils/
│   │   │   ├── event-bus.ts        # Pub/sub tipado (sistema nervioso)
│   │   │   ├── ring-buffer.ts      # Buffer circular O(1)
│   │   │   ├── math.ts             # Utilidades cuantitativas
│   │   │   ├── metrics.ts          # Exportador Prometheus
│   │   │   ├── logger.ts           # Logging estructurado (pino)
│   │   │   └── time.ts             # Timers de alta resolución
│   │   ├── index.ts                # Entry point principal
│   │   └── live.ts                 # Modo live paper trading
│   ├── scripts/
│   │   ├── download-bulk.ts        # Descarga masiva (Binance Data Vision)
│   │   ├── download-data.ts        # Descarga via REST API
│   │   ├── capture-book.ts         # Captura de order book en tiempo real
│   │   ├── optimize.ts             # CLI del optimizador de parámetros
│   │   └── init-db.sql             # Schema TimescaleDB
│   ├── ml/
│   │   ├── server.py               # Servidor ML (FastAPI + baseline model)
│   │   ├── requirements.txt        # Dependencias Python
│   │   └── Dockerfile              # Container para el servicio ML
│   ├── tests/
│   │   └── unit/                   # 65 tests unitarios
│   │       ├── ring-buffer.test.ts
│   │       ├── math.test.ts
│   │       ├── binance-adapter.test.ts
│   │       ├── book-imbalance-strategy.test.ts
│   │       ├── order-book.test.ts
│   │       ├── portfolio-manager.test.ts
│   │       ├── backtester.test.ts
│   │       ├── event-bus.test.ts
│   │       ├── metrics.test.ts
│   │       └── ml-bridge.test.ts
│   ├── infra/
│   │   └── prometheus.yml          # Config Prometheus
│   ├── docker-compose.yml          # Stack completo
│   ├── Dockerfile                  # Container del engine
│   ├── ecosystem.config.cjs        # PM2 config (daemon 24/7)
│   └── package.json
│
└── trading-dashboard/               # Frontend: cockpit (Next.js)
    ├── src/
    │   ├── app/
    │   │   ├── layout.tsx           # Root layout (dark mode)
    │   │   ├── page.tsx             # Dashboard principal
    │   │   └── globals.css          # CSS variables + tema dark
    │   ├── components/
    │   │   ├── connection-bar.tsx   # Barra superior: status + kill switch
    │   │   ├── ticker-strip.tsx     # Precios en vivo
    │   │   ├── equity-chart.tsx     # Curva de equity (Recharts)
    │   │   ├── signal-feed.tsx      # Feed de señales en tiempo real
    │   │   ├── microstructure-panel.tsx # Imbalance bars + métricas
    │   │   ├── risk-panel.tsx       # Equity, drawdown, PnL, status
    │   │   └── whale-alerts.tsx     # Alertas de actividad institucional
    │   └── hooks/
    │       └── use-engine.ts        # WebSocket hook → engine state
    └── package.json
```

---

## Comandos

### Engine

| Comando | Descripción |
|---------|-------------|
| `npm run live` | Paper trading en vivo (conecta a Binance WS) |
| `npm run live:headless` | Lo mismo sin dashboard de terminal |
| `npm run dev` | Modo desarrollo con watch |
| `npm test` | Correr 65 tests unitarios |
| `npm run lint` | Type-check con TypeScript |
| `npm run download -- --symbol BTCUSDT --days 30` | Descargar trades históricos (Binance Data Vision, rápido) |
| `npm run download:api -- --symbol BTC-USDT --days 7` | Descargar trades via REST API (lento) |
| `npm run capture -- --symbols BTC-USDT --duration 6h` | Capturar order book L2 en tiempo real |
| `npm run backtest -- --symbol BTC-USDT` | Correr backtest |
| `npm run backtest -- --symbol BTC-USDT --walkforward --steps 5` | Walk-forward validation |
| `npm run optimize -- --symbol BTC-USDT --trials 200` | Optimizar parámetros de estrategia |
| `npm run build` | Build de producción |

### Dashboard

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Dashboard en http://localhost:3000 |
| `npm run build` | Build de producción |

### Docker

| Comando | Descripción |
|---------|-------------|
| `docker compose up` | Stack completo (engine + Redis + TimescaleDB + Prometheus + Grafana) |
| `docker compose up -d` | Lo mismo en background |

### PM2 (daemon 24/7)

| Comando | Descripción |
|---------|-------------|
| `pm2 start ecosystem.config.cjs` | Iniciar engine como daemon |
| `pm2 logs trading-engine` | Ver logs |
| `pm2 monit` | Monitoreo en terminal |
| `pm2 save && pm2 startup` | Auto-start en reboot |

---

## Flujo de Datos

### Tiempo Real (Live Mode)

```
Binance WS ──────────────────────────────────────────────────────────▶
  ├─ @trade stream ──▶ EventBus "market:trade" ──▶ FeatureEngine
  │                                               ├─▶ WhaleDetector
  │                                               └─▶ SentimentEngine
  │
  ├─ @depth stream ──▶ EventBus "market:book_delta" ──▶ OrderBookManager
  │                                                      ├─ cachedImbalance
  │                                                      ├─ cachedMidPrice
  │                                                      └─ cachedSpread
  │
  └─ All events ────▶ TickStore (persiste a disco para backtesting futuro)

FeatureEngine (cada 1s) ──▶ FeatureVector (30+ métricas)
  └─▶ StrategyOrchestrator
        ├─ CompositeAlpha ──▶ TradingSignal
        ├─ BookImbalance ──▶ TradingSignal
        ├─ LiquidationCascade ──▶ TradingSignal
        ├─ VolatilityRegime ──▶ TradingSignal
        └─ CrossExchangeSpread ──▶ TradingSignal
              │
              ▼ (señales mergeadas)
        RiskEngine
        ├─ Kelly sizing
        ├─ Position limits
        ├─ Drawdown check
        └─ Circuit breaker check
              │
              ▼ (si pasa todos los checks)
        ExecutionEngine
        ├─ Slippage estimation
        ├─ Rate limiting
        └─ Paper fill simulation
              │
              ▼
        PortfolioManager
        └─ Mark-to-market, PnL tracking
```

### Dashboard (WebSocket)

```
Engine (port 3001) ──WS──▶ Dashboard (port 3000)

Cada 500ms:
  Server → Client: { type: "state", data: { tickers, features, signals, risk, whales } }

Eventos instantáneos:
  Server → Client: { type: "signal", data: TradingSignal }
  Server → Client: { type: "whale", data: WhaleEvent }
  Server → Client: { type: "fill", data: FillEvent }

Kill switch:
  Client → Server: { type: "kill_switch" }
```

---

## Estrategias

### 1. Composite Alpha (principal)

Combina 6 fuentes de alpha ortogonales con pesos adaptativos:

| Fuente | Peso | Qué mide |
|--------|------|----------|
| Order Flow | 25% | Book imbalance × trade flow (solo cuando ambos coinciden) |
| Volume Profile | 20% | Aceleración de volumen + presencia institucional |
| Volatility Surface | 15% | Term structure de vol → momentum o mean reversion |
| Microstructure | 15% | Calidad de spread → multiplicador de confianza |
| Funding/Sentiment | 10% | Contrarian en extremos, momentum en cascadas |
| Regime Alignment | 15% | Ajusta pesos según régimen actual |

**Score compuesto:**
```
finalScore = Σ(source_i × weight_i × regime_modifier_i) × confidence_multiplier
```

El threshold es dinámico — se ajusta según la accuracy histórica de las señales.

### 2. Book Imbalance

Cuando la profundidad de compra supera significativamente la de venta en el tope del order book, el precio tiende a subir. Requiere confirmación de trade flow.

### 3. Liquidation Cascade

Detecta cascadas de liquidación (liquidation volume > 3σ). Dos fases: momentum (durante la cascada) y counter-trade (después del agotamiento).

### 4. Volatility Regime

Detecta transiciones de régimen de volatilidad. Vol expansion → momentum. Vol compression → mean reversion. Vol-of-vol spike → anticipa cambio.

### 5. Cross-Exchange Spread

Detecta diferencias de precio entre exchanges. El exchange líder mueve primero; tradea en el rezagado en dirección de convergencia. Horizonte: 5-15 segundos.

---

## Feature Vector (30+ Features)

| Categoría | Features |
|-----------|----------|
| **Order Book** | bid-ask spread, mid price, weighted mid, imbalance (top-5, top-20), depth (bid/ask), depth slope |
| **Trade Flow** | trade imbalance, VWAP, volume acceleration, large trade ratio, buy pressure, aggressive trade intensity |
| **Volatility** | realized vol, vol-of-vol, return skew, return kurtosis, Parkinson vol |
| **Liquidity** | composite liquidity score, spread volatility, depth resilience |
| **Cross-Exchange** | exchange spread, lead-lag score |
| **Regime** | market regime classification, regime confidence |
| **Derivados** | funding rate, liquidation pressure, open interest delta |

---

## Detección de Whales

El `WhaleDetector` identifica 4 patrones de actividad institucional:

| Patrón | Detección | Significado |
|--------|-----------|-------------|
| **Large Order** | Trade > 5σ del tamaño promedio | Orden directa (poco sofisticada) |
| **Iceberg** | 10+ trades del mismo tamaño en <3s | Orden oculta ejecutándose en partes |
| **Sweep** | 5+ trades a precios crecientes en <1s | Orden agresiva comiendo el order book |
| **Absorption** | 15+ trades al mismo precio con flujo opuesto | "Wall" que absorbe presión |

---

## Risk Management

| Protección | Mecanismo | Default |
|-----------|-----------|---------|
| Position sizing | Kelly fraccional (25% del óptimo) | max 2% del portfolio |
| Daily loss limit | Circuit breaker automático | 3% |
| Max drawdown | Circuit breaker automático | 5% |
| Kill switch | Halt total de trading | 10% de pérdida total |
| Slippage guard | Estimación pre-ejecución via book walk | max 5 bps |
| Cooldown | Espera mínima entre señales | 10-30s |

---

## Backtesting

### Simulación realista

| Parámetro | Valor |
|-----------|-------|
| Slippage | 2 bps por fill |
| Fees | 4 bps maker, 6 bps taker |
| Latencia | 50ms order-to-fill |
| Fill rate | 90-100% (parcial) |

### Anti-overfitting

1. **Walk-forward validation** — train/test windows que avanzan en el tiempo
2. **Mínimo de trades** — no se aceptan resultados con <30 trades
3. **OOS/IS ratio** — si el Sharpe out-of-sample es <50% del in-sample, es overfit
4. **Scoring penaliza pocos trades** — `score = sharpe × √trades × (1 - maxDD) × √PF`

### Métricas objetivo

| Métrica | Target mínimo |
|---------|--------------|
| Sharpe Ratio | > 1.5 |
| Win Rate | > 55% |
| Profit Factor | > 1.5 |
| Max Drawdown | < 5% |
| Calmar Ratio | > 3.0 |

---

## Obtención de Datos

### Opción 1: Binance Data Vision (trades históricos, gratis, rápido)

```bash
npm run download -- --symbol BTCUSDT --days 30
```

Descarga archivos ZIP pre-compilados. 494 MB en ~10 segundos. No necesita API key.

### Opción 2: Captura de Order Book (L2, gratis, tiempo real)

```bash
npm run capture -- --symbols BTC-USDT --duration 6h
```

Polling REST cada 1 segundo + trades por WebSocket. 4 horas = ~14,400 snapshots de book.

### Opción 3: Live mode (acumula todo automáticamente)

```bash
npm run live
```

El engine persiste todos los eventos (trades + book deltas) en `data/ticks/` mientras corre.

---

## Infraestructura

### Desarrollo

Solo necesitás Node.js 20+. Sin bases de datos, sin Docker.

```bash
npm install
npm run live
```

### Producción (VPS)

```bash
# PM2 (daemon)
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup

# O Docker Compose (stack completo)
docker compose up -d
```

El `docker-compose.yml` incluye:
- Engine (Node.js)
- ML Service (Python/FastAPI)
- Redis (state + event streaming)
- TimescaleDB (tick storage)
- Prometheus (métricas)
- Grafana (dashboards)

### Recomendación de VPS

| Provider | Plan | Precio | Latencia a Binance |
|----------|------|--------|--------------------|
| Hetzner | CPX21 | €5/mes | ~30ms (EU) |
| DigitalOcean | Basic | $6/mes | ~50ms (NYC/SFO) |
| AWS Lightsail | 2GB | $10/mes | ~15ms (ap-northeast-1) |

---

## Flujo de Trabajo Recomendado

```
1. Descargar datos ─────────────────────▶ npm run download -- --symbol BTCUSDT --days 30
                                          npm run capture -- --symbols BTC-USDT --duration 6h

2. Backtest inicial ────────────────────▶ npm run backtest -- --symbol BTC-USDT

3. Optimizar parámetros ────────────────▶ npm run optimize -- --symbol BTC-USDT --trials 200

4. Validar out-of-sample ───────────────▶ npm run backtest -- --symbol BTC-USDT --walkforward

5. Paper trading (2+ semanas) ──────────▶ npm run live

6. ¿Sharpe > 1.5 en paper? ────────────▶ Sí → micro-live ($50-100)
                                          No → iterar estrategias

7. ¿Rentable 2 semanas real? ──────────▶ Sí → escalar gradualmente
                                          No → volver a paper
```

---

## Stack Técnico

| Componente | Tecnología | Por qué |
|-----------|-----------|---------|
| Engine | Node.js + TypeScript | Async I/O, WS nativo, tipado |
| Parsing | Decimal.js | Precisión financiera sin float errors |
| Event bus | eventemitter3 | Pub/sub tipado, <1μs emit |
| Config | Zod | Validación en runtime con tipos inferidos |
| Logging | Pino | Structured JSON, 30x más rápido que console.log |
| Data structures | RingBuffer custom | O(1) push, zero GC pressure |
| Rate limiting | p-queue | Concurrency control per-exchange |
| Dashboard | Next.js + Recharts | SSR, real-time charts, dark mode |
| ML | Python + FastAPI | Ecosistema ML (PyTorch, scikit-learn) |
| DB (prod) | TimescaleDB | Time-series optimizado |
| Cache (prod) | Redis | Sub-ms reads, pub/sub |
| Monitoring | Prometheus + Grafana | Métricas industry-standard |

---

## Tests

```bash
npm test
```

**65 tests, 10 archivos, zero type errors.**

| Suite | Tests | Qué cubre |
|-------|-------|-----------|
| ring-buffer | 6 | Buffer circular, wrapping, iteración |
| math | 17 | EMA, stddev, skewness, kurtosis, Parkinson, VWAP, book imbalance |
| binance-adapter | 7 | Normalización de símbolos, parsing de WS messages |
| book-imbalance-strategy | 5 | Generación de señales, filtros, regime awareness |
| order-book | 6 | Merge de deltas, imbalance, depth at distance |
| portfolio-manager | 9 | Open/close positions, partial fills, PnL |
| backtester | 4 | Run, metrics, trending data, walk-forward |
| event-bus | 4 | Typed events, once, remove |
| metrics | 4 | Prometheus format, counters, gauges |
| ml-bridge | 3 | Unavailable handling, null predictions |

---

## Licencia

MIT
