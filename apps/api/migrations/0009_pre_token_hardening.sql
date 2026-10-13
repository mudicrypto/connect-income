-- Pre-token audit hardening (docs/pre-token-audit.md). Forward-only; rewrites no row.
-- Every rule below already holds for every row the application writes; these
-- triggers make the database refuse anything else (defence in depth).

-- ---------------------------------------------------------------------------
-- L3/L4: which accounts each entry type may touch, and in which direction.
-- Derived from the posting code (ledger/ledger.ts callers); a new entry shape
-- needs a new row here, i.e. a reviewed migration.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entry_rules (
  entry_type TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  PRIMARY KEY (entry_type, purpose, direction)
);
INSERT INTO ledger_entry_rules (entry_type, purpose, direction) VALUES
  ('simulated_deposit',           'platform_sim_custody',   'debit'),
  ('simulated_deposit',           'user_available',         'credit'),
  ('investment_open',             'user_available',         'debit'),
  ('investment_open',             'user_invested',          'credit'),
  ('investment_mature',           'user_invested',          'debit'),
  ('investment_mature',           'user_available',         'credit'),
  ('strategy_capital_allocation', 'strategy_cash',          'debit'),
  ('strategy_capital_allocation', 'strategy_capital',       'credit'),
  ('strategy_trade',              'strategy_cash',          'debit'),
  ('strategy_trade',              'strategy_cash',          'credit'),
  ('strategy_trade',              'strategy_position',      'debit'),
  ('strategy_trade',              'strategy_position',      'credit'),
  ('strategy_trade',              'strategy_fees',          'debit'),
  ('strategy_trade',              'strategy_realised_gain', 'credit'),
  ('strategy_trade',              'strategy_realised_loss', 'debit'),
  ('reward_distribution',         'strategy_distributions', 'debit'),
  ('reward_distribution',         'strategy_cash',          'credit'),
  ('reward_distribution',         'platform_sim_custody',   'debit'),
  ('reward_distribution',         'user_reward_pending',    'credit'),
  ('reward_distribution',         'pool_reserve',           'credit'),
  ('reward_reserve_release',      'pool_reserve',           'debit'),
  ('reward_reserve_release',      'platform_sim_custody',   'credit'),
  ('reward_reserve_release',      'strategy_cash',          'debit'),
  ('reward_reserve_release',      'strategy_distributions', 'credit'),
  ('reward_release',              'user_reward_pending',    'debit'),
  ('reward_release',              'user_available',         'credit'),
  ('reserve_settlement',          'pool_reserve',           'debit'),
  ('reserve_settlement',          'user_available',         'credit');
CREATE TRIGGER ledger_entry_rules_append_only BEFORE UPDATE OR DELETE ON ledger_entry_rules
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entry_rules_no_truncate BEFORE TRUNCATE ON ledger_entry_rules
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Posting trigger: shape rule, asset scale, then the balance update under the
-- account row lock. L5: the posting id is drawn AFTER that lock is held, so for
-- every account the id order equals the order in which balance_after was
-- computed (a concurrent writer blocked on the lock gets a later id).
CREATE OR REPLACE FUNCTION ledger_apply_posting() RETURNS trigger AS $$
DECLARE
  v_normal  TEXT;
  v_purpose TEXT;
  v_type    TEXT;
  v_scale   INT;
  v_delta   NUMERIC(38, 18);
BEGIN
  SELECT a.normal_balance, a.purpose, s.scale INTO v_normal, v_purpose, v_scale
    FROM ledger_accounts a JOIN assets s ON s.code = a.asset WHERE a.id = NEW.account_id;
  IF v_normal IS NULL THEN
    RAISE EXCEPTION 'ledger account % not found', NEW.account_id;
  END IF;
  SELECT entry_type INTO v_type FROM journal_entries WHERE id = NEW.entry_id;
  IF NOT EXISTS (SELECT 1 FROM ledger_entry_rules r
                  WHERE r.entry_type = v_type AND r.purpose = v_purpose AND r.direction = NEW.direction) THEN
    RAISE EXCEPTION 'posting not allowed: % entry may not % a % account', v_type, NEW.direction, v_purpose;
  END IF;
  IF NEW.amount <> round(NEW.amount, v_scale) THEN
    RAISE EXCEPTION 'posting amount % exceeds the asset scale (% decimals)', NEW.amount, v_scale;
  END IF;
  v_delta := CASE WHEN NEW.direction = v_normal THEN NEW.amount ELSE -NEW.amount END;
  UPDATE ledger_accounts
     SET balance = balance + v_delta, version = version + 1
   WHERE id = NEW.account_id
   RETURNING balance INTO NEW.balance_after;
  NEW.id := nextval(pg_get_serial_sequence('ledger_postings', 'id'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- L4: an entry may touch the accounts of at most one strategy (sub-ledger
-- accounts and its pool reserve). Checked with the balance at COMMIT.
CREATE OR REPLACE FUNCTION ledger_check_entry_balanced(p_entry_id UUID) RETURNS void AS $$
DECLARE
  v_count INT;
  v_bad   TEXT;
  v_strategies INT;
BEGIN
  SELECT count(*) INTO v_count FROM ledger_postings WHERE entry_id = p_entry_id;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'journal entry % must have at least two postings (has %)', p_entry_id, v_count;
  END IF;
  SELECT asset INTO v_bad
    FROM ledger_postings
   WHERE entry_id = p_entry_id
   GROUP BY asset
  HAVING sum(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'journal entry % is unbalanced for asset %', p_entry_id, v_bad;
  END IF;
  SELECT count(DISTINCT a.owner_strategy_id) INTO v_strategies
    FROM ledger_postings p JOIN ledger_accounts a ON a.id = p.account_id
   WHERE p.entry_id = p_entry_id AND a.owner_strategy_id IS NOT NULL;
  IF v_strategies > 1 THEN
    RAISE EXCEPTION 'journal entry % touches the accounts of more than one strategy', p_entry_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- L6: account rows. New accounts start empty and match their purpose's
-- category and normal balance; flags that change the meaning of a balance
-- (allow_negative, code, category) are immutable like the identity fields.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger_purpose_spec(p_purpose TEXT, OUT category TEXT, OUT normal_balance TEXT) AS $$
  SELECT s.category, s.normal_balance FROM (VALUES
    ('user_available', 'liability', 'credit'), ('user_invested', 'liability', 'credit'),
    ('user_reward_pending', 'liability', 'credit'), ('platform_sim_custody', 'asset', 'debit'),
    ('pool_reserve', 'liability', 'credit'), ('strategy_capital', 'equity', 'credit'),
    ('strategy_cash', 'asset', 'debit'), ('strategy_position', 'asset', 'debit'),
    ('strategy_realised_gain', 'revenue', 'credit'), ('strategy_realised_loss', 'expense', 'debit'),
    ('strategy_fees', 'expense', 'debit'), ('strategy_distributions', 'equity', 'debit')
  ) AS s(purpose, category, normal_balance) WHERE s.purpose = p_purpose;
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION ledger_accounts_insert_guard() RETURNS trigger AS $$
DECLARE
  v_spec RECORD;
BEGIN
  IF NEW.balance <> 0 OR NEW.version <> 0 THEN
    RAISE EXCEPTION 'a new ledger account must start with a zero balance';
  END IF;
  IF NEW.allow_negative THEN
    RAISE EXCEPTION 'ledger accounts may not allow a negative balance';
  END IF;
  SELECT * INTO v_spec FROM ledger_purpose_spec(NEW.purpose);
  IF v_spec.category IS DISTINCT FROM NEW.category OR v_spec.normal_balance IS DISTINCT FROM NEW.normal_balance THEN
    RAISE EXCEPTION 'account purpose % requires category % and normal balance %', NEW.purpose, v_spec.category, v_spec.normal_balance;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_accounts_insert_guard BEFORE INSERT ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_accounts_insert_guard();

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
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.allow_negative IS DISTINCT FROM OLD.allow_negative
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.category IS DISTINCT FROM OLD.category THEN
    RAISE EXCEPTION 'ledger account identity fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- R7: the v2 columns of a calculated run are frozen like every other figure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reward_runs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reward runs cannot be deleted'; END IF;
  IF OLD.status <> 'calculated' THEN RAISE EXCEPTION 'reward run % is final (%)', OLD.id, OLD.status; END IF;
  IF (NEW.pool_strategy_id, NEW.policy_id, NEW.policy_version, NEW.period_start, NEW.period_end, NEW.source_trade_count,
      NEW.gross_gains, NEW.gross_losses, NEW.fees, NEW.net_realised, NEW.capital_integral, NEW.allocation_integral,
      NEW.customer_fraction, NEW.attributable, NEW.cf_open, NEW.cf_recovered, NEW.cf_close, NEW.reserve_open,
      NEW.reserve_applied, NEW.eligible_profit, NEW.reserve_contribution, NEW.rounding_residual, NEW.distributable,
      NEW.total_rewards, NEW.created_at, NEW.loss_model, NEW.attribution_residual)
     IS DISTINCT FROM
     (OLD.pool_strategy_id, OLD.policy_id, OLD.policy_version, OLD.period_start, OLD.period_end, OLD.source_trade_count,
      OLD.gross_gains, OLD.gross_losses, OLD.fees, OLD.net_realised, OLD.capital_integral, OLD.allocation_integral,
      OLD.customer_fraction, OLD.attributable, OLD.cf_open, OLD.cf_recovered, OLD.cf_close, OLD.reserve_open,
      OLD.reserve_applied, OLD.eligible_profit, OLD.reserve_contribution, OLD.rounding_residual, OLD.distributable,
      OLD.total_rewards, OLD.created_at, OLD.loss_model, OLD.attribution_residual) THEN
    RAISE EXCEPTION 'reward run calculation fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- A9/A10: legacy transition reconciliation also requires each attributed
-- allocation to have participated in a posted pool_v1 run of the pool, and no
-- v2 run of the pool at all (not just one created before the transition).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION legacy_loss_transition_check(p_transition UUID) RETURNS void AS $$
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
     AND (pa.pool_strategy_id <> t.pool_strategy_id OR pa.investment_id <> l.investment_id OR pa.user_id <> l.user_id
          OR NOT EXISTS (SELECT 1 FROM reward_run_lines rl JOIN reward_runs r ON r.id = rl.run_id
                          WHERE rl.allocation_id = l.allocation_id AND r.pool_strategy_id = t.pool_strategy_id
                            AND r.status = 'posted' AND r.loss_model = 'pool_v1' AND rl.weighted_allocation > 0));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'legacy transition %: a line does not match a participating allocation of this pool', p_transition;
  END IF;
  SELECT loss_model, transition_required INTO v_model, v_flag FROM reward_pools WHERE strategy_id = t.pool_strategy_id;
  IF v_model <> 'investment_v2' OR v_flag THEN
    RAISE EXCEPTION 'legacy transition %: pool must move to investment_v2 in the same transaction', p_transition;
  END IF;
  -- Fires at the COMMIT of the transition's own transaction: no v2 run may exist yet.
  SELECT count(*) INTO v_v2 FROM reward_runs WHERE pool_strategy_id = t.pool_strategy_id AND loss_model = 'investment_v2';
  IF v_v2 > 0 THEN
    RAISE EXCEPTION 'legacy transition %: v2 runs already exist before the transition', p_transition;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- A9: pin the search_path of every function in this schema, so a session
-- cannot shadow a table (e.g. with a temporary table) inside a trigger.
-- ---------------------------------------------------------------------------
DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.prokind = 'f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_catalog, pg_temp', f.sig, current_schema());
  END LOOP;
END;
$$;
