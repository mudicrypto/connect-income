-- 0007: rewards v2: per-investment loss recovery, reserve ownership and
-- settlement, daily UTC periods. Specification: docs/rewards-accounting-v2.md.
-- Forward-only. No historical reward run, line or ledger row is modified.

-- ---------------------------------------------------------------------------
-- Pools: loss model and period mode
-- ---------------------------------------------------------------------------
ALTER TABLE reward_pools
  ADD COLUMN loss_model TEXT NOT NULL DEFAULT 'investment_v2' CHECK (loss_model IN ('pool_v1', 'investment_v2')),
  ADD COLUMN transition_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN period_mode TEXT NOT NULL DEFAULT 'daily_utc' CHECK (period_mode IN ('daily_utc', 'ad_hoc')),
  ADD CONSTRAINT reward_pools_transition_flag CHECK (NOT transition_required OR loss_model = 'pool_v1');

-- Classify existing pools (section 7). Pools that existed before this migration
-- keep ad hoc periods (their current behaviour). A pool moves to the
-- per-investment model only if it has no legacy pool-level carry-forward or
-- reserve; otherwise it stays on pool_v1 and is flagged for a founder decision.
UPDATE reward_pools rp SET
  period_mode = 'ad_hoc',
  loss_model = CASE WHEN legacy.cf = 0 AND legacy.reserve = 0 THEN 'investment_v2' ELSE 'pool_v1' END,
  transition_required = NOT (legacy.cf = 0 AND legacy.reserve = 0)
FROM (
  SELECT p.strategy_id,
         COALESCE((SELECT r.cf_close FROM reward_runs r WHERE r.pool_strategy_id = p.strategy_id AND r.status = 'posted'
                    ORDER BY r.period_end DESC LIMIT 1), 0) AS cf,
         COALESCE((SELECT sum(a.balance) FROM ledger_accounts a WHERE a.owner_strategy_id = p.strategy_id AND a.purpose = 'pool_reserve'), 0) AS reserve
    FROM reward_pools p
) legacy
WHERE legacy.strategy_id = rp.strategy_id;

-- The loss model may only move forward (v1 -> v2), never back.
CREATE OR REPLACE FUNCTION reward_pools_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reward pools cannot be deleted'; END IF;
  IF NEW.strategy_id IS DISTINCT FROM OLD.strategy_id OR NEW.rewards_start_at IS DISTINCT FROM OLD.rewards_start_at THEN
    RAISE EXCEPTION 'reward pool identity fields are immutable';
  END IF;
  IF OLD.loss_model = 'investment_v2' AND NEW.loss_model = 'pool_v1' THEN
    RAISE EXCEPTION 'a pool cannot move back to the pool_v1 loss model';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Runs and lines: model marker and per-investment memo columns
-- ---------------------------------------------------------------------------
ALTER TABLE reward_runs
  ADD COLUMN loss_model TEXT NOT NULL DEFAULT 'pool_v1' CHECK (loss_model IN ('pool_v1', 'investment_v2')),
  ADD COLUMN attribution_residual NUMERIC(38, 18) NOT NULL DEFAULT 0 CHECK (attribution_residual >= 0);
-- Existing rows keep 'pool_v1' via the default; new runs set the value explicitly.
ALTER TABLE reward_runs ALTER COLUMN loss_model DROP DEFAULT;

ALTER TABLE reward_run_lines
  ADD COLUMN loss_open            NUMERIC(38, 18) CHECK (loss_open >= 0),
  ADD COLUMN attributable         NUMERIC(38, 18),
  ADD COLUMN loss_recovered       NUMERIC(38, 18) CHECK (loss_recovered >= 0),
  ADD COLUMN loss_close           NUMERIC(38, 18) CHECK (loss_close >= 0),
  ADD COLUMN reserve_open         NUMERIC(38, 18) CHECK (reserve_open >= 0),
  ADD COLUMN reserve_applied      NUMERIC(38, 18) CHECK (reserve_applied >= 0),
  ADD COLUMN eligible             NUMERIC(38, 18) CHECK (eligible >= 0),
  ADD COLUMN reserve_contribution NUMERIC(38, 18) CHECK (reserve_contribution >= 0),
  ADD COLUMN reserve_close        NUMERIC(38, 18) CHECK (reserve_close >= 0),
  -- v2 lines carry every memo field; v1 (historical) lines carry none.
  ADD CONSTRAINT reward_run_lines_v2_complete CHECK (
    (loss_open IS NULL) = (attributable IS NULL) AND (attributable IS NULL) = (loss_recovered IS NULL)
    AND (loss_recovered IS NULL) = (loss_close IS NULL) AND (loss_close IS NULL) = (reserve_open IS NULL)
    AND (reserve_open IS NULL) = (reserve_applied IS NULL) AND (reserve_applied IS NULL) = (eligible IS NULL)
    AND (eligible IS NULL) = (reserve_contribution IS NULL) AND (reserve_contribution IS NULL) = (reserve_close IS NULL)
  ),
  ADD CONSTRAINT reward_run_lines_v2_identities CHECK (
    loss_open IS NULL OR (
      loss_close = loss_open + GREATEST(-attributable, 0) - reserve_applied - loss_recovered
      AND reserve_close = reserve_open + reserve_contribution - reserve_applied
      AND eligible = GREATEST(attributable, 0) - loss_recovered
      AND reward = eligible - reserve_contribution
      AND (reserve_applied = 0 OR attributable < 0)
      AND (loss_recovered = 0 OR attributable > 0)
    )
  );

-- Lines stay immutable (now including the memo columns); release still once, only when posted.
CREATE OR REPLACE FUNCTION reward_run_lines_guard() RETURNS trigger AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reward run lines cannot be deleted'; END IF;
  IF OLD.released_entry_id IS NOT NULL THEN RAISE EXCEPTION 'reward line % already released', OLD.id; END IF;
  IF (NEW.run_id, NEW.allocation_id, NEW.investment_id, NEW.user_id, NEW.allocation_amount, NEW.overlap_us,
      NEW.weighted_allocation, NEW.weight_fraction, NEW.reward, NEW.loss_open, NEW.attributable, NEW.loss_recovered,
      NEW.loss_close, NEW.reserve_open, NEW.reserve_applied, NEW.eligible, NEW.reserve_contribution, NEW.reserve_close)
     IS DISTINCT FROM
     (OLD.run_id, OLD.allocation_id, OLD.investment_id, OLD.user_id, OLD.allocation_amount, OLD.overlap_us,
      OLD.weighted_allocation, OLD.weight_fraction, OLD.reward, OLD.loss_open, OLD.attributable, OLD.loss_recovered,
      OLD.loss_close, OLD.reserve_open, OLD.reserve_applied, OLD.eligible, OLD.reserve_contribution, OLD.reserve_close) THEN
    RAISE EXCEPTION 'reward run lines are immutable';
  END IF;
  IF NEW.released_entry_id IS NOT NULL THEN
    SELECT status INTO v_status FROM reward_runs WHERE id = NEW.run_id;
    IF v_status IS DISTINCT FROM 'posted' THEN
      RAISE EXCEPTION 'reward line % cannot be released: run % is not posted (%)', OLD.id, NEW.run_id, v_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Reserve settlement (per allocation, once)
-- ---------------------------------------------------------------------------
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN (
  'simulated_deposit', 'investment_open', 'investment_mature',
  'strategy_capital_allocation', 'strategy_trade',
  'reward_distribution', 'reward_reserve_release', 'reward_release',
  'reserve_settlement'
));

CREATE TABLE reserve_settlements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  allocation_id    UUID NOT NULL UNIQUE REFERENCES pool_allocations (id),
  pool_strategy_id UUID NOT NULL REFERENCES reward_pools (strategy_id),
  investment_id    UUID NOT NULL REFERENCES investments (id),
  user_id          UUID NOT NULL REFERENCES users (id),
  reserve_released NUMERIC(38, 18) NOT NULL CHECK (reserve_released >= 0),
  loss_expired     NUMERIC(38, 18) NOT NULL CHECK (loss_expired >= 0),
  entry_id         UUID UNIQUE REFERENCES journal_entries (id),
  settled_by       UUID REFERENCES users (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reserve_settlements_entry CHECK ((reserve_released > 0) = (entry_id IS NOT NULL))
);
CREATE INDEX reserve_settlements_pool_idx ON reserve_settlements (pool_strategy_id);

CREATE TRIGGER reserve_settlements_append_only BEFORE UPDATE OR DELETE ON reserve_settlements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER reserve_settlements_no_truncate BEFORE TRUNCATE ON reserve_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Daily UTC period boundary: the first UTC midnight strictly after ts.
-- ---------------------------------------------------------------------------
CREATE FUNCTION next_utc_midnight(ts TIMESTAMPTZ) RETURNS TIMESTAMPTZ AS $$
  SELECT (date_trunc('day', ts AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC';
$$ LANGUAGE sql IMMUTABLE;
