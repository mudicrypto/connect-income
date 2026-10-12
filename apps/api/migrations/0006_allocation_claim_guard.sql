-- 0006: a customer's pool participation can never exceed the investment it comes from
-- (audit finding D7, docs/milestone-3-audit.md).
--   * amount = principal x weight exactly, same owner as the investment
--   * total weight across all of an investment's allocations <= 1
--   * the allocation lies within the investment's term
CREATE FUNCTION pool_allocations_claim_guard() RETURNS trigger AS $$
DECLARE
  v_inv RECORD;
  v_weight NUMERIC;
BEGIN
  SELECT user_id, principal, start_at, maturity_at INTO v_inv FROM investments WHERE id = NEW.investment_id FOR UPDATE;
  IF NEW.user_id <> v_inv.user_id THEN
    RAISE EXCEPTION 'allocation owner must be the investment owner';
  END IF;
  IF NEW.amount <> v_inv.principal * NEW.weight THEN
    RAISE EXCEPTION 'allocation amount % must equal principal % x weight %', NEW.amount, v_inv.principal, NEW.weight;
  END IF;
  IF NEW.effective_from < v_inv.start_at OR NEW.effective_to > v_inv.maturity_at THEN
    RAISE EXCEPTION 'allocation must lie within the investment term';
  END IF;
  SELECT COALESCE(sum(weight), 0) INTO v_weight FROM pool_allocations WHERE investment_id = NEW.investment_id;
  IF v_weight + NEW.weight > 1 THEN
    RAISE EXCEPTION 'investment % would be allocated % (> 100%% of principal)', NEW.investment_id, v_weight + NEW.weight;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pool_allocations_claim_guard_trg BEFORE INSERT ON pool_allocations
  FOR EACH ROW EXECUTE FUNCTION pool_allocations_claim_guard();
