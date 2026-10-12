-- 0005: fixes from the milestone-3 audit (docs/milestone-3-audit.md).

-- ---------------------------------------------------------------------------
-- D3: nothing may be committed into a reward period that is already posted.
--
-- now() is the transaction START time. A transaction that began before a
-- period ended, but commits after the period was posted, would otherwise
-- write P&L, paper capital or a customer allocation dated inside a closed
-- period, silently excluded from every reward run. Such writes now fail with
-- SQLSTATE 40001 (serialization_failure), which the application already
-- retries in a fresh transaction (with a new, later timestamp).
-- reward posting takes the strategy and pool row locks, so in-flight writers
-- either finish first (and are reconciled) or hit this guard.
-- ---------------------------------------------------------------------------
CREATE FUNCTION reward_period_open_guard(p_strategy UUID, p_at TIMESTAMPTZ) RETURNS void AS $$
DECLARE
  v_end TIMESTAMPTZ;
BEGIN
  SELECT max(period_end) INTO v_end FROM reward_runs WHERE pool_strategy_id = p_strategy AND status = 'posted';
  IF v_end IS NOT NULL AND p_at < v_end THEN
    RAISE EXCEPTION 'reward period of pool % is posted up to %; a write dated % must be retried', p_strategy, v_end, p_at
      USING ERRCODE = '40001';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION strategy_trades_period_guard() RETURNS trigger AS $$
BEGIN
  PERFORM reward_period_open_guard(NEW.strategy_id, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER strategy_trades_period_guard_trg BEFORE INSERT ON strategy_trades
  FOR EACH ROW EXECUTE FUNCTION strategy_trades_period_guard();

CREATE FUNCTION pool_allocations_period_guard() RETURNS trigger AS $$
BEGIN
  PERFORM reward_period_open_guard(NEW.pool_strategy_id, LEAST(NEW.effective_from, now()));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pool_allocations_period_guard_trg BEFORE INSERT ON pool_allocations
  FOR EACH ROW EXECUTE FUNCTION pool_allocations_period_guard();

CREATE FUNCTION strategy_capital_period_guard() RETURNS trigger AS $$
DECLARE
  v_purpose TEXT;
  v_strategy UUID;
BEGIN
  SELECT purpose, owner_strategy_id INTO v_purpose, v_strategy FROM ledger_accounts WHERE id = NEW.account_id;
  IF v_purpose = 'strategy_capital' THEN
    PERFORM reward_period_open_guard(v_strategy, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_postings_capital_period_guard BEFORE INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION strategy_capital_period_guard();

-- ---------------------------------------------------------------------------
-- A posted run must reference exactly the ledger entries its figures require.
-- ---------------------------------------------------------------------------
ALTER TABLE reward_runs ADD CONSTRAINT reward_runs_posted_entries CHECK (
  status <> 'posted' OR (
    (eligible_profit = 0) = (distribution_entry_id IS NULL)
    AND (reserve_applied = 0) = (reserve_release_entry_id IS NULL)
  )
);

-- ---------------------------------------------------------------------------
-- A reward line can only be released (once) after its run is posted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reward_run_lines_guard() RETURNS trigger AS $$
DECLARE
  v_status TEXT;
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
  IF NEW.released_entry_id IS NOT NULL THEN
    SELECT status INTO v_status FROM reward_runs WHERE id = NEW.run_id;
    IF v_status IS DISTINCT FROM 'posted' THEN
      RAISE EXCEPTION 'reward line % cannot be released: run % is not posted (%)', OLD.id, NEW.run_id, v_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
