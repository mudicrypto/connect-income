-- 0003: simulated strategy and performance engine.
--
-- Everything here is SIMULATED: instruments are synthetic (symbol prefix SIM-,
-- is_simulated is forced TRUE), prices come from a deterministic generator or
-- test scripts, and strategy capital is paper capital that is never sourced
-- from customer funds.

-- ---------------------------------------------------------------------------
-- Synthetic market data
-- ---------------------------------------------------------------------------
CREATE TABLE market_instruments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol                TEXT NOT NULL UNIQUE CHECK (symbol ~ '^SIM-[A-Z0-9-]{2,28}$'),
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('spot', 'staking', 'lending')),
  quote_asset           TEXT NOT NULL REFERENCES assets (code),
  is_simulated          BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_simulated),
  data_source           TEXT NOT NULL CHECK (data_source IN ('synthetic_generator', 'synthetic_scripted')),
  price_scale           SMALLINT NOT NULL DEFAULT 8 CHECK (price_scale BETWEEN 0 AND 18),
  quantity_scale        SMALLINT NOT NULL DEFAULT 8 CHECK (quantity_scale BETWEEN 0 AND 18),
  fee_bps               NUMERIC(12, 6) NOT NULL CHECK (fee_bps >= 0 AND fee_bps < 1000),
  slippage_bps          NUMERIC(12, 6) NOT NULL CHECK (slippage_bps >= 0 AND slippage_bps < 1000),
  tick_interval_minutes INT NOT NULL CHECK (tick_interval_minutes > 0),
  genesis_at            TIMESTAMPTZ NOT NULL,
  -- Generator parameters (synthetic_generator only). Per-tick return =
  -- drift + volatility * (2u - 1), minus shock_bps with probability shock_probability.
  seed                  TEXT,
  start_price           NUMERIC(38, 18),
  drift_bps             NUMERIC(24, 12),
  volatility_bps        NUMERIC(24, 12),
  shock_probability     NUMERIC(24, 12),
  shock_bps             NUMERIC(24, 12),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT market_instruments_generator_params CHECK (
    data_source <> 'synthetic_generator' OR (
      seed IS NOT NULL AND start_price > 0 AND drift_bps IS NOT NULL AND volatility_bps >= 0
      AND shock_probability BETWEEN 0 AND 1 AND shock_bps >= 0
      AND volatility_bps + shock_bps - drift_bps < 10000
    )
  )
);

CREATE TABLE market_ticks (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id UUID NOT NULL REFERENCES market_instruments (id),
  seq           BIGINT NOT NULL CHECK (seq >= 0),
  -- Simulated time on the synthetic timeline, not wall-clock time.
  simulated_at  TIMESTAMPTZ NOT NULL,
  price         NUMERIC(38, 18) NOT NULL CHECK (price > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT market_ticks_instrument_seq_uq UNIQUE (instrument_id, seq)
);

-- Instruments are reference data: once ticks depend on their parameters they
-- must never change, or determinism would be lost.
CREATE TRIGGER market_instruments_immutable BEFORE UPDATE OR DELETE ON market_instruments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER market_ticks_append_only BEFORE UPDATE OR DELETE ON market_ticks
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER market_ticks_no_truncate BEFORE TRUNCATE ON market_ticks
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

INSERT INTO market_instruments
  (symbol, name, description, kind, quote_asset, data_source, fee_bps, slippage_bps, tick_interval_minutes,
   genesis_at, seed, start_price, drift_bps, volatility_bps, shock_probability, shock_bps)
VALUES
  ('SIM-BTC-USDT', 'Simulated BTC/USDT',
   'Synthetic random-walk price series. Not real market data.',
   'spot', 'USDT', 'synthetic_generator', 10, 5, 60,
   '2026-01-01T00:00:00Z', 'sim-btc-usdt-v1', 60000, 0, 80, 0.002, 600),
  ('SIM-ETH-STAKED', 'Simulated staked ETH',
   'Synthetic staked-asset index: price random walk plus a small staking accrual drift, with rare slashing shocks. Not real market data.',
   'staking', 'USDT', 'synthetic_generator', 10, 10, 60,
   '2026-01-01T00:00:00Z', 'sim-eth-staked-v1', 3000, 0.05, 40, 0.001, 500),
  ('SIM-USDT-LENDING', 'Simulated USDT lending pool',
   'Synthetic lending-pool share index: accrues simulated interest each tick, with rare borrower-default haircuts. Not real market data.',
   'lending', 'USDT', 'synthetic_generator', 0, 1, 60,
   '2026-01-01T00:00:00Z', 'sim-usdt-lending-v1', 1, 0.09, 0.5, 0.0005, 150);

-- ---------------------------------------------------------------------------
-- Strategies
-- ---------------------------------------------------------------------------
CREATE TABLE strategies (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code               TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,32}$'),
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description        TEXT NOT NULL CHECK (length(description) <= 1000),
  strategy_type      TEXT NOT NULL CHECK (strategy_type IN ('trading', 'staking', 'lending')),
  instrument_id      UUID NOT NULL REFERENCES market_instruments (id),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  pause_reason       TEXT,
  paused_at          TIMESTAMPTZ,
  -- Risk limits
  max_allocation     NUMERIC(38, 18) NOT NULL CHECK (max_allocation > 0),
  max_position_value NUMERIC(38, 18) NOT NULL CHECK (max_position_value > 0),
  max_exposure_ratio NUMERIC(12, 8) NOT NULL CHECK (max_exposure_ratio > 0 AND max_exposure_ratio <= 1),
  daily_loss_limit   NUMERIC(38, 18) NOT NULL CHECK (daily_loss_limit > 0),
  max_drawdown_ratio NUMERIC(12, 8) NOT NULL CHECK (max_drawdown_ratio > 0 AND max_drawdown_ratio < 1),
  params             JSONB NOT NULL,
  -- Engine state (updated only by the engine, inside the tick transaction)
  last_tick_seq      BIGINT NOT NULL CHECK (last_tick_seq >= 0),
  last_equity        NUMERIC(38, 18) NOT NULL DEFAULT 0,
  peak_equity        NUMERIC(38, 18) NOT NULL DEFAULT 0,
  day_start_equity   NUMERIC(38, 18) NOT NULL DEFAULT 0,
  current_day        DATE,
  created_by         UUID REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT strategies_pause_reason CHECK ((status = 'paused') = (pause_reason IS NOT NULL AND paused_at IS NOT NULL))
);

CREATE FUNCTION strategies_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'strategies cannot be deleted';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code
     OR NEW.strategy_type IS DISTINCT FROM OLD.strategy_type
     OR NEW.instrument_id IS DISTINCT FROM OLD.instrument_id THEN
    RAISE EXCEPTION 'strategy identity fields are immutable';
  END IF;
  IF NEW.last_tick_seq < OLD.last_tick_seq THEN
    RAISE EXCEPTION 'strategy tick cursor cannot move backwards';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategies_guard_trg BEFORE UPDATE OR DELETE ON strategies
  FOR EACH ROW EXECUTE FUNCTION strategies_guard();

-- Current open position per strategy and instrument (long-only, spot).
-- Fully derivable from strategy_trades; kept for fast reads and checked by
-- the integrity checker.
CREATE TABLE strategy_positions (
  strategy_id   UUID NOT NULL REFERENCES strategies (id),
  instrument_id UUID NOT NULL REFERENCES market_instruments (id),
  quantity      NUMERIC(38, 18) NOT NULL CHECK (quantity >= 0),
  cost_basis    NUMERIC(38, 18) NOT NULL CHECK (cost_basis >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_id, instrument_id),
  CONSTRAINT strategy_positions_flat_consistent CHECK ((quantity = 0) = (cost_basis = 0))
);

-- Global engine settings (single row).
CREATE TABLE engine_settings (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  kill_switch        BOOLEAN NOT NULL DEFAULT FALSE,
  kill_switch_reason TEXT,
  updated_by         UUID REFERENCES users (id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO engine_settings (id) VALUES (TRUE);

-- One row per engine processing run (operational record; status is mutable).
CREATE TABLE strategy_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger         TEXT NOT NULL CHECK (trigger IN ('admin', 'scheduler', 'test', 'seed')),
  actor_user_id   UUID REFERENCES users (id),
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'abandoned')),
  ticks_processed INT NOT NULL DEFAULT 0,
  trades          INT NOT NULL DEFAULT 0,
  error           TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

-- Every simulated fill. Append-only.
CREATE TABLE strategy_trades (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id         UUID NOT NULL REFERENCES strategies (id),
  instrument_id       UUID NOT NULL REFERENCES market_instruments (id),
  tick_id             BIGINT NOT NULL REFERENCES market_ticks (id),
  tick_seq            BIGINT NOT NULL,
  seq_in_tick         SMALLINT NOT NULL CHECK (seq_in_tick >= 0),
  run_id              UUID REFERENCES strategy_runs (id),
  side                TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  reason              TEXT NOT NULL CHECK (reason IN ('signal', 'rebalance', 'risk_liquidation')),
  quantity            NUMERIC(38, 18) NOT NULL CHECK (quantity > 0),
  mid_price           NUMERIC(38, 18) NOT NULL CHECK (mid_price > 0),
  exec_price          NUMERIC(38, 18) NOT NULL CHECK (exec_price > 0),
  notional            NUMERIC(38, 18) NOT NULL CHECK (notional > 0),
  fee                 NUMERIC(38, 18) NOT NULL CHECK (fee >= 0),
  slippage_cost       NUMERIC(38, 18) NOT NULL CHECK (slippage_cost >= 0),
  cost_basis_released NUMERIC(38, 18) NOT NULL CHECK (cost_basis_released >= 0),
  realised_pnl        NUMERIC(38, 18) NOT NULL,
  position_qty_after  NUMERIC(38, 18) NOT NULL CHECK (position_qty_after >= 0),
  entry_id            UUID NOT NULL UNIQUE REFERENCES journal_entries (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT strategy_trades_once UNIQUE (strategy_id, tick_id, seq_in_tick),
  CONSTRAINT strategy_trades_side_consistent CHECK (
    (side = 'buy' AND cost_basis_released = 0 AND realised_pnl = 0) OR side = 'sell'
  )
);
CREATE INDEX strategy_trades_strategy_idx ON strategy_trades (strategy_id, tick_seq DESC, seq_in_tick DESC);

-- Valuation snapshot written once per (strategy, tick). The unique constraint
-- is the database-level guarantee that a market event is never processed twice.
CREATE TABLE strategy_tick_results (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  strategy_id      UUID NOT NULL REFERENCES strategies (id),
  tick_id          BIGINT NOT NULL REFERENCES market_ticks (id),
  tick_seq         BIGINT NOT NULL,
  run_id           UUID REFERENCES strategy_runs (id),
  status_after     TEXT NOT NULL CHECK (status_after IN ('active', 'paused')),
  price            NUMERIC(38, 18) NOT NULL,
  cash             NUMERIC(38, 18) NOT NULL,
  position_qty     NUMERIC(38, 18) NOT NULL,
  position_value   NUMERIC(38, 18) NOT NULL,
  cost_basis       NUMERIC(38, 18) NOT NULL,
  equity           NUMERIC(38, 18) NOT NULL,
  peak_equity      NUMERIC(38, 18) NOT NULL,
  drawdown_ratio   NUMERIC(20, 12) NOT NULL,
  day_pnl          NUMERIC(38, 18) NOT NULL,
  trades           SMALLINT NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT strategy_tick_results_once UNIQUE (strategy_id, tick_id)
);
CREATE INDEX strategy_tick_results_strategy_idx ON strategy_tick_results (strategy_id, tick_seq DESC);

-- Strategy lifecycle and risk events. Append-only.
CREATE TABLE strategy_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  strategy_id   UUID REFERENCES strategies (id),
  event_type    TEXT NOT NULL CHECK (event_type IN (
                  'created', 'paused', 'resumed', 'capital_allocated', 'risk_breach',
                  'order_clipped', 'order_rejected', 'kill_switch_on', 'kill_switch_off')),
  tick_seq      BIGINT,
  run_id        UUID REFERENCES strategy_runs (id),
  actor_user_id UUID REFERENCES users (id),
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX strategy_events_strategy_idx ON strategy_events (strategy_id, id DESC);

CREATE TRIGGER strategy_trades_append_only BEFORE UPDATE OR DELETE ON strategy_trades
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER strategy_trades_no_truncate BEFORE TRUNCATE ON strategy_trades
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER strategy_tick_results_append_only BEFORE UPDATE OR DELETE ON strategy_tick_results
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER strategy_tick_results_no_truncate BEFORE TRUNCATE ON strategy_tick_results
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER strategy_events_append_only BEFORE UPDATE OR DELETE ON strategy_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER strategy_events_no_truncate BEFORE TRUNCATE ON strategy_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Ledger: strategy-owned accounts and new entry types
-- ---------------------------------------------------------------------------
ALTER TABLE ledger_accounts ADD COLUMN owner_strategy_id UUID REFERENCES strategies (id);

ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_purpose_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_purpose_check CHECK (purpose IN (
  'user_available',          -- customer funds free to use (platform liability)
  'user_invested',           -- customer principal locked in investments (platform liability)
  'platform_sim_custody',    -- simulated USDT held by the platform (platform asset)
  'strategy_capital',        -- simulated paper capital allocated to a strategy (equity)
  'strategy_cash',           -- strategy's uninvested simulated cash (asset)
  'strategy_position',       -- cost basis of the strategy's open simulated positions (asset)
  'strategy_realised_gain',  -- realised simulated trading gains (revenue)
  'strategy_realised_loss',  -- realised simulated trading losses (expense)
  'strategy_fees'            -- simulated venue fees paid (expense)
));
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_strategy_owner
  CHECK ((purpose LIKE 'strategy\_%') = (owner_strategy_id IS NOT NULL));
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_single_owner
  CHECK (owner_user_id IS NULL OR owner_strategy_id IS NULL);

DROP INDEX ledger_accounts_platform_purpose_uq;
CREATE UNIQUE INDEX ledger_accounts_platform_purpose_uq
  ON ledger_accounts (purpose, asset) WHERE owner_user_id IS NULL AND owner_strategy_id IS NULL;
CREATE UNIQUE INDEX ledger_accounts_strategy_purpose_uq
  ON ledger_accounts (owner_strategy_id, purpose, asset) WHERE owner_strategy_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ledger_accounts_guard_balance() RETURNS trigger AS $$
BEGIN
  IF (NEW.balance IS DISTINCT FROM OLD.balance OR NEW.version IS DISTINCT FROM OLD.version)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'ledger account balance can only change through ledger postings';
  END IF;
  IF NEW.asset IS DISTINCT FROM OLD.asset
     OR NEW.normal_balance IS DISTINCT FROM OLD.normal_balance
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.owner_strategy_id IS DISTINCT FROM OLD.owner_strategy_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'ledger account identity fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN (
  'simulated_deposit', 'investment_open', 'investment_mature',
  'strategy_capital_allocation', 'strategy_trade'
));
