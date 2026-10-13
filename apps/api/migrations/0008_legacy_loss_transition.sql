-- 0008: auditable transition of a legacy pool_v1 pool to investment_v2 by
-- attributing its remaining pool-wide loss carry-forward to the investments
-- responsible for it (founder decision "Option A", docs/rewards-accounting-v2.md §7).
--
-- Forward-only: no historical reward run, line or ledger row is touched. The
-- transition is a new append-only record whose per-investment amounts become the
-- opening loss-recovery balances of those investments under the v2 model.

CREATE TABLE legacy_loss_transitions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_strategy_id     UUID NOT NULL UNIQUE REFERENCES reward_pools (strategy_id),  -- once per pool
  transition_key       TEXT NOT NULL UNIQUE CHECK (length(transition_key) BETWEEN 8 AND 128),
  method               TEXT NOT NULL CHECK (method = 'option_a_responsible_investments'),
  source_run_id        UUID NOT NULL REFERENCES reward_runs (id),  -- last posted v1 run
  source_carry_forward NUMERIC(38, 18) NOT NULL CHECK (source_carry_forward > 0),
  source_reserve       NUMERIC(38, 18) NOT NULL CHECK (source_reserve = 0),
  formula              TEXT NOT NULL,
  evidence             JSONB NOT NULL,
  approval_reference   TEXT NOT NULL CHECK (length(approval_reference) BETWEEN 5 AND 500),
  approved_by          UUID NOT NULL REFERENCES users (id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE legacy_loss_transition_lines (
  transition_id UUID NOT NULL REFERENCES legacy_loss_transitions (id),
  allocation_id UUID NOT NULL UNIQUE REFERENCES pool_allocations (id),
  investment_id UUID NOT NULL REFERENCES investments (id),
  user_id       UUID NOT NULL REFERENCES users (id),
  loss_amount   NUMERIC(38, 18) NOT NULL CHECK (loss_amount > 0),
  evidence      JSONB NOT NULL,
  PRIMARY KEY (transition_id, allocation_id)
);

CREATE TRIGGER legacy_loss_transitions_append_only BEFORE UPDATE OR DELETE ON legacy_loss_transitions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER legacy_loss_transitions_no_truncate BEFORE TRUNCATE ON legacy_loss_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER legacy_loss_transition_lines_append_only BEFORE UPDATE OR DELETE ON legacy_loss_transition_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER legacy_loss_transition_lines_no_truncate BEFORE TRUNCATE ON legacy_loss_transition_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Reconciliation enforced by the database at COMMIT (deferred): the transition
-- must account for the pool's ENTIRE legacy state, exactly, and leave the pool
-- on investment_v2. Fires for the header and for every line (so lines cannot be
-- added later, and nothing partial can commit).
CREATE FUNCTION legacy_loss_transition_check(p_transition UUID) RETURNS void AS $$
DECLARE
  t RECORD;
  v_last RECORD;
  v_sum NUMERIC;
  v_reserve NUMERIC;
  v_bad INT;
  v_model TEXT;
  v_flag BOOLEAN;
  v_v2 INT;
BEGIN
  SELECT * INTO t FROM legacy_loss_transitions WHERE id = p_transition;
  SELECT id, status, loss_model, cf_close INTO v_last FROM reward_runs
   WHERE pool_strategy_id = t.pool_strategy_id AND status = 'posted' ORDER BY period_end DESC LIMIT 1;
  IF v_last.id IS DISTINCT FROM t.source_run_id OR v_last.loss_model <> 'pool_v1' THEN
    RAISE EXCEPTION 'legacy transition %: source run must be the pool''s last posted run and on pool_v1', p_transition;
  END IF;
  IF v_last.cf_close <> t.source_carry_forward THEN
    RAISE EXCEPTION 'legacy transition %: source carry-forward % does not equal the last posted cf_close %', p_transition, t.source_carry_forward, v_last.cf_close;
  END IF;
  SELECT COALESCE(sum(balance), 0) INTO v_reserve FROM ledger_accounts WHERE owner_strategy_id = t.pool_strategy_id AND purpose = 'pool_reserve';
  IF v_reserve <> t.source_reserve THEN
    RAISE EXCEPTION 'legacy transition %: pool reserve % is not the recorded legacy reserve %', p_transition, v_reserve, t.source_reserve;
  END IF;
  SELECT COALESCE(sum(loss_amount), 0) INTO v_sum FROM legacy_loss_transition_lines WHERE transition_id = p_transition;
  IF v_sum <> t.source_carry_forward THEN
    RAISE EXCEPTION 'legacy transition %: attributed % does not reconcile to the carry-forward %', p_transition, v_sum, t.source_carry_forward;
  END IF;
  SELECT count(*) INTO v_bad FROM legacy_loss_transition_lines l
    JOIN pool_allocations pa ON pa.id = l.allocation_id
   WHERE l.transition_id = p_transition
     AND (pa.pool_strategy_id <> t.pool_strategy_id OR pa.investment_id <> l.investment_id OR pa.user_id <> l.user_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'legacy transition %: a line does not match its allocation in this pool', p_transition;
  END IF;
  SELECT loss_model, transition_required INTO v_model, v_flag FROM reward_pools WHERE strategy_id = t.pool_strategy_id;
  IF v_model <> 'investment_v2' OR v_flag THEN
    RAISE EXCEPTION 'legacy transition %: pool must move to investment_v2 in the same transaction', p_transition;
  END IF;
  SELECT count(*) INTO v_v2 FROM reward_runs WHERE pool_strategy_id = t.pool_strategy_id AND loss_model = 'investment_v2' AND created_at < t.created_at;
  IF v_v2 > 0 THEN
    RAISE EXCEPTION 'legacy transition %: v2 runs already exist before the transition', p_transition;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION legacy_loss_transitions_check_trg() RETURNS trigger AS $$
BEGIN
  PERFORM legacy_loss_transition_check(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER legacy_loss_transitions_reconcile
  AFTER INSERT ON legacy_loss_transitions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION legacy_loss_transitions_check_trg();

CREATE FUNCTION legacy_loss_transition_lines_check_trg() RETURNS trigger AS $$
BEGIN
  PERFORM legacy_loss_transition_check(NEW.transition_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER legacy_loss_transition_lines_reconcile
  AFTER INSERT ON legacy_loss_transition_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION legacy_loss_transition_lines_check_trg();
