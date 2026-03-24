-- TimescaleDB schema for tick storage
-- Run automatically on first docker-compose up

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ── Trades ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
    ts          TIMESTAMPTZ     NOT NULL,
    exchange    TEXT            NOT NULL,
    symbol      TEXT            NOT NULL,
    trade_id    TEXT            NOT NULL,
    price       NUMERIC(20,8)  NOT NULL,
    qty         NUMERIC(20,8)  NOT NULL,
    side        TEXT            NOT NULL,
    is_buyer_maker BOOLEAN     NOT NULL DEFAULT FALSE
);

SELECT create_hypertable('trades', by_range('ts'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades (symbol, ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_exchange ON trades (exchange, symbol, ts DESC);

-- ── Order Book Snapshots ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS book_snapshots (
    ts          TIMESTAMPTZ     NOT NULL,
    exchange    TEXT            NOT NULL,
    symbol      TEXT            NOT NULL,
    mid_price   NUMERIC(20,8)  NOT NULL,
    spread_bps  NUMERIC(10,4)  NOT NULL,
    bid_depth   NUMERIC(20,2)  NOT NULL,
    ask_depth   NUMERIC(20,2)  NOT NULL,
    imbalance_5 NUMERIC(8,6)   NOT NULL,
    imbalance_20 NUMERIC(8,6)  NOT NULL
);

SELECT create_hypertable('book_snapshots', by_range('ts'), if_not_exists => TRUE);

-- ── Feature Vectors ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS features (
    ts                  TIMESTAMPTZ     NOT NULL,
    symbol              TEXT            NOT NULL,
    mid_price           NUMERIC(20,8),
    book_imbalance_5    NUMERIC(8,6),
    trade_imbalance     NUMERIC(8,6),
    realized_vol        NUMERIC(10,6),
    vol_of_vol          NUMERIC(10,6),
    liquidity_score     NUMERIC(6,4),
    regime              TEXT,
    regime_confidence   NUMERIC(4,3)
);

SELECT create_hypertable('features', by_range('ts'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_features_symbol ON features (symbol, ts DESC);

-- ── Signals ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
    ts          TIMESTAMPTZ     NOT NULL,
    symbol      TEXT            NOT NULL,
    exchange    TEXT            NOT NULL,
    direction   TEXT            NOT NULL,
    confidence  NUMERIC(5,4)   NOT NULL,
    expected_return NUMERIC(10,6),
    horizon_s   INTEGER,
    strategy    TEXT            NOT NULL
);

SELECT create_hypertable('signals', by_range('ts'), if_not_exists => TRUE);

-- ── Orders ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id              TEXT            PRIMARY KEY,
    ts              TIMESTAMPTZ     NOT NULL,
    symbol          TEXT            NOT NULL,
    exchange        TEXT            NOT NULL,
    side            TEXT            NOT NULL,
    qty             NUMERIC(20,8)  NOT NULL,
    order_type      TEXT            NOT NULL,
    status          TEXT            NOT NULL,
    fill_price      NUMERIC(20,8),
    fill_qty        NUMERIC(20,8),
    slippage_bps    NUMERIC(8,4),
    strategy        TEXT
);

-- ── Portfolio ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    ts              TIMESTAMPTZ     NOT NULL,
    equity          NUMERIC(20,2)  NOT NULL,
    cash            NUMERIC(20,2)  NOT NULL,
    unrealized_pnl  NUMERIC(20,2)  NOT NULL,
    realized_pnl    NUMERIC(20,2)  NOT NULL,
    position_count  INTEGER        NOT NULL,
    drawdown_pct    NUMERIC(8,4)   NOT NULL
);

SELECT create_hypertable('portfolio_snapshots', by_range('ts'), if_not_exists => TRUE);

-- ── Continuous aggregates for dashboards ───────────────────────
-- 1-minute OHLCV from trades
CREATE MATERIALIZED VIEW IF NOT EXISTS trades_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', ts) AS bucket,
    symbol,
    exchange,
    first(price, ts)  AS open,
    max(price)         AS high,
    min(price)         AS low,
    last(price, ts)   AS close,
    sum(qty)           AS volume,
    count(*)           AS trade_count
FROM trades
GROUP BY bucket, symbol, exchange
WITH NO DATA;

-- Refresh policy: update every minute, covering last 10 minutes
SELECT add_continuous_aggregate_policy('trades_1m',
    start_offset    => INTERVAL '10 minutes',
    end_offset      => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists   => TRUE
);
