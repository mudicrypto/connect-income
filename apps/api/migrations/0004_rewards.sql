-- 0004: customer pool allocations and the SIMULATED variable reward engine.
-- Specification: docs/rewards-accounting.md

-- ---------------------------------------------------------------------------
-- Ledger: new purposes and entry types
-- ---------------------------------------------------------------------------
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_purpose_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_purpose_check CHECK (purpose IN (
  'user_available', 'user_invested', 'platform_sim_custody',
  'strategy_capital', 'strategy_cash', 'strategy_position',
  'strategy_realised_gain', 'strategy_realised_loss', 'strategy_fees',
  'strategy_distributions',  -- realised profit swept out of a strategy for customers (contra-equity)
  'pool_reserve',            -- customer-side reserve withheld from a pool's distributions (liability)
  'user_reward_pending'      -- rewards owed to a customer, not yet released (liability)
));
-- pool_reserve is owned by a pool (strategy id) but is NOT part of the strategy sub-ledger.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_strategy_owner;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_strategy_owner
  CHECK ((purpose LIKE 'strategy\_%' OR purpose = 'pool_reserve') = (owner_strategy_id IS NOT NULL));

ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN (
  'simulated_deposit', 'investment_open', 'investment_mature',
  'strategy_capital_allocation', 'strategy_trade',
  'reward_distribution', 'reward_reserve_release', 'reward_release'
));

-- ---------------------------------------------------------------------------
-- Pools, product assignment, allocations
-- ---------------------------------------------------------------------------
CREATE TABLE reward_pools (
  strategy_id       UUID PRIMARY KEY REFERENCES strategies (id),
  customer_capacity NUMERIC(38, 18) NOT NULL CHECK (customer_capacity > 0),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  -- Start of the first reward period (periods are contiguous from here).
  rewards_start_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION reward_pools_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reward pools cannot be deleted'; END IF;
  IF NEW.strategy_id IS DISTINCT FROM OLD.strategy_id OR NEW.rewards_start_at IS DISTINCT FROM OLD.rewards_start_at THEN
    RAISE EXCEPTION 'reward pool identity fields are immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reward_pools_guard_trg BEFORE UPDATE OR DELETE ON reward_pools
  FOR EACH ROW EXECUTE FUNCTION reward_pools_guard();

-- History of product -> pool assignments. The latest row per product is current.
CREATE TABLE product_pool_assignments (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id       UUID NOT NULL REFERENCES investment_products (id),
  pool_strategy_id UUID REFERENCES reward_pools (strategy_id),
  reason           TEXT,
  assigned_by      UUID REFERENCES users (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX product_pool_assignments_product_idx ON product_pool_assignments (product_id, id DESC);

-- One row per (investment, pool) participation. Immutable.
CREATE TABLE pool_allocations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id    UUID NOT NULL REFERENCES investments (id),
  user_id          UUID NOT NULL REFERENCES users (id),
  pool_strategy_id UUID NOT NULL REFERENCES reward_pools (strategy_id),
  assignment_id    BIGINT NOT NULL REFERENCES product_pool_assignments (id),
  weight           NUMERIC(12, 8) NOT NULL CHECK (weight > 0 AND weight <= 1),
  amount           NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
  effective_from   TIMESTAMPTZ NOT NULL,
  effective_to     TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pool_allocations_dates CHECK (effective_to > effective_from),
  CONSTRAINT pool_allocations_once UNIQUE (investment_id, pool_strategy_id)
);
CREATE INDEX pool_allocations_pool_idx ON pool_allocations (pool_strategy_id, effective_from);

-- ---------------------------------------------------------------------------
-- Policies (versioned, immutable)
-- ---------------------------------------------------------------------------
CREATE TABLE reward_policies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version       INT NOT NULL UNIQUE CHECK (version > 0),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  reserve_ratio NUMERIC(12, 8) NOT NULL CHECK (reserve_ratio >= 0 AND reserve_ratio < 1),
  created_by    UUID REFERENCES users (id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO reward_policies (version, name, description, reserve_ratio)
VALUES (1, 'Default v1', 'Realised profit only, loss carry-forward, 10% reserve, no performance fee.', 0.1);

-- ---------------------------------------------------------------------------
-- Reward runs (the reward journal)
-- ---------------------------------------------------------------------------
CREATE TABLE reward_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_strategy_id     UUID NOT NULL REFERENCES reward_pools (strategy_id),
  policy_id            UUID NOT NULL REFERENCES reward_policies (id),
  policy_version       INT NOT NULL,
  period_start         TIMESTAMPTZ NOT NULL,
  period_end           TIMESTAMPTZ NOT NULL,
  status               TEXT NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'posted', 'cancelled', 'failed')),
  -- Inputs
  source_trade_count   INT NOT NULL,
  gross_gains          NUMERIC(38, 18) NOT NULL CHECK (gross_gains >= 0),
  gross_losses         NUMERIC(38, 18) NOT NULL CHECK (gross_losses >= 0),
  fees                 NUMERIC(38, 18) NOT NULL CHECK (fees >= 0),
  net_realised         NUMERIC(38, 18) NOT NULL,
  capital_integral     NUMERIC(60, 18) NOT NULL CHECK (capital_integral >= 0),
  allocation_integral  NUMERIC(60, 18) NOT NULL CHECK (allocation_integral >= 0),
  customer_fraction    NUMERIC(30, 18) NOT NULL CHECK (customer_fraction >= 0 AND customer_fraction <= 1),
  attributable         NUMERIC(38, 18) NOT NULL,
  -- Carry-forward and reserve
  cf_open              NUMERIC(38, 18) NOT NULL CHECK (cf_open >= 0),
  cf_recovered         NUMERIC(38, 18) NOT NULL CHECK (cf_recovered >= 0),
  cf_close             NUMERIC(38, 18) NOT NULL CHECK (cf_close >= 0),
  reserve_open         NUMERIC(38, 18) NOT NULL CHECK (reserve_open >= 0),
  reserve_applied      NUMERIC(38, 18) NOT NULL CHECK (reserve_applied >= 0),
  -- Outputs
  eligible_profit      NUMERIC(38, 18) NOT NULL CHECK (eligible_profit >= 0),
  reserve_contribution NUMERIC(38, 18) NOT NULL CHECK (reserve_contribution >= 0), -- incl. rounding residual
  rounding_residual    NUMERIC(38, 18) NOT NULL CHECK (rounding_residual >= 0),
  distributable        NUMERIC(38, 18) NOT NULL CHECK (distributable >= 0),
  total_rewards        NUMERIC(38, 18) NOT NULL CHECK (total_rewards >= 0),
  -- Ledger references (set when posted)
  distribution_entry_id UUID REFERENCES journal_entries (id),
  reserve_release_entry_id UUID REFERENCES journal_entries (id),
  error                TEXT,
  created_by           UUID REFERENCES users (id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at            TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ,
  CONSTRAINT reward_runs_period CHECK (period_end > period_start),
  CONSTRAINT reward_runs_cap CHECK (total_rewards <= distributable),
  CONSTRAINT reward_runs_conservation CHECK (total_rewards + reserve_contribution = eligible_profit),
  CONSTRAINT reward_runs_residual CHECK (rounding_residual <= reserve_contribution),
  CONSTRAINT reward_runs_loss_xor_profit CHECK (reserve_applied = 0 OR eligible_profit = 0),
  CONSTRAINT reward_runs_posted CHECK ((status = 'posted') = (posted_at IS NOT NULL))
);
CREATE UNIQUE INDEX reward_runs_one_pending ON reward_runs (pool_strategy_id) WHERE status = 'calculated';
CREATE UNIQUE INDEX reward_runs_period_once ON reward_runs (pool_strategy_id, period_start) WHERE status = 'posted';
CREATE INDEX reward_runs_pool_idx ON reward_runs (pool_strategy_id, period_end DESC);

-- Only status/outcome fields may change, and only out of 'calculated'.
CREATE FUNCTION reward_runs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reward runs cannot be deleted'; END IF;
  IF OLD.status <> 'calculated' THEN RAISE EXCEPTION 'reward run % is final (%)', OLD.id, OLD.status; END IF;
  IF (NEW.pool_strategy_id, NEW.policy_id, NEW.policy_version, NEW.period_start, NEW.period_end, NEW.source_trade_count,
      NEW.gross_gains, NEW.gross_losses, NEW.fees, NEW.net_realised, NEW.capital_integral, NEW.allocation_integral,
      NEW.customer_fraction, NEW.attributable, NEW.cf_open, NEW.cf_recovered, NEW.cf_close, NEW.reserve_open,
      NEW.reserve_applied, NEW.eligible_profit, NEW.reserve_contribution, NEW.rounding_residual, NEW.distributable,
      NEW.total_rewards, NEW.created_at)
     IS DISTINCT FROM
     (OLD.pool_strategy_id, OLD.policy_id, OLD.policy_version, OLD.period_start, OLD.period_end, OLD.source_trade_count,
      OLD.gross_gains, OLD.gross_losses, OLD.fees, OLD.net_realised, OLD.capital_integral, OLD.allocation_integral,
      OLD.customer_fraction, OLD.attributable, OLD.cf_open, OLD.cf_recovered, OLD.cf_close, OLD.reserve_open,
      OLD.reserve_applied, OLD.eligible_profit, OLD.reserve_contribution, OLD.rounding_residual, OLD.distributable,
      OLD.total_rewards, OLD.created_at) THEN
    RAISE EXCEPTION 'reward run calculation fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reward_runs_guard_trg BEFORE UPDATE OR DELETE ON reward_runs
  FOR EACH ROW EXECUTE FUNCTION reward_runs_guard();

-- One line per recipient allocation, written at calculation. Immutable except
-- for the one-time release reference.
CREATE TABLE reward_run_lines (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id              UUID NOT NULL REFERENCES reward_runs (id),
  allocation_id       UUID NOT NULL REFERENCES pool_allocations (id),
  investment_id       UUID NOT NULL REFERENCES investments (id),
  user_id             UUID NOT NULL REFERENCES users (id),
  allocation_amount   NUMERIC(38, 18) NOT NULL,
  overlap_us          NUMERIC(30, 0) NOT NULL CHECK (overlap_us > 0),
  weighted_allocation NUMERIC(60, 18) NOT NULL CHECK (weighted_allocation > 0),
  weight_fraction     NUMERIC(30, 18) NOT NULL CHECK (weight_fraction > 0 AND weight_fraction <= 1),
  reward              NUMERIC(38, 18) NOT NULL CHECK (reward >= 0),
  released_entry_id   UUID REFERENCES journal_entries (id),
  released_at         TIMESTAMPTZ,
  CONSTRAINT reward_run_lines_once UNIQUE (run_id, allocation_id),
  CONSTRAINT reward_run_lines_release CHECK ((released_entry_id IS NULL) = (released_at IS NULL))
);
CREATE INDEX reward_run_lines_investment_idx ON reward_run_lines (investment_id);
CREATE INDEX reward_run_lines_user_idx ON reward_run_lines (user_id);

CREATE FUNCTION reward_run_lines_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reward run lines cannot be deleted'; END IF;
  IF OLD.released_entry_id IS NOT NULL THEN RAISE EXCEPTION 'reward line % already released', OLD.id; END IF;
  IF (NEW.run_id, NEW.allocation_id, NEW.investment_id, NEW.user_id, NEW.allocation_amount, NEW.overlap_us,
      NEW.weighted_allocation, NEW.weight_fraction, NEW.reward)
     IS DISTINCT FROM
     (OLD.run_id, OLD.allocation_id, OLD.investment_id, OLD.user_id, OLD.allocation_amount, OLD.overlap_us,
      OLD.weighted_allocation, OLD.weight_fraction, OLD.reward) THEN
    RAISE EXCEPTION 'reward run lines are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reward_run_lines_guard_trg BEFORE UPDATE OR DELETE ON reward_run_lines
  FOR EACH ROW EXECUTE FUNCTION reward_run_lines_guard();

-- Trades that fed a POSTED run. A trade can feed at most one posted run.
CREATE TABLE reward_run_sources (
  run_id   UUID NOT NULL REFERENCES reward_runs (id),
  trade_id UUID NOT NULL UNIQUE REFERENCES strategy_trades (id),
  PRIMARY KEY (run_id, trade_id)
);

-- Append-only / immutable tables
CREATE TRIGGER product_pool_assignments_append_only BEFORE UPDATE OR DELETE ON product_pool_assignments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER pool_allocations_append_only BEFORE UPDATE OR DELETE ON pool_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER reward_policies_append_only BEFORE UPDATE OR DELETE ON reward_policies
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER reward_run_sources_append_only BEFORE UPDATE OR DELETE ON reward_run_sources
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER reward_runs_no_truncate BEFORE TRUNCATE ON reward_runs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER reward_run_lines_no_truncate BEFORE TRUNCATE ON reward_run_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER pool_allocations_no_truncate BEFORE TRUNCATE ON pool_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
