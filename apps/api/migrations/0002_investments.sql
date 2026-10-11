-- 0002: fixed-term investment products and positions.
--
-- Products do NOT carry a promised rate. Rewards will be derived from realised
-- simulated strategy performance in a later milestone; until then a matured
-- investment returns principal only.

CREATE TABLE investment_products (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,32}$'),
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL,
  asset                TEXT NOT NULL REFERENCES assets (code),
  -- Term in minutes so short development-only terms are possible; production
  -- products use whole days (multiples of 1440).
  term_minutes         INT NOT NULL CHECK (term_minutes > 0),
  min_amount           NUMERIC(38, 18) NOT NULL CHECK (min_amount > 0),
  max_amount           NUMERIC(38, 18) CHECK (max_amount IS NULL OR max_amount >= min_amount),
  strategy_description TEXT NOT NULL,
  risk_disclosure      TEXT NOT NULL,
  dev_only             BOOLEAN NOT NULL DEFAULT FALSE,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE investments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users (id),
  product_id      UUID NOT NULL REFERENCES investment_products (id),
  asset           TEXT NOT NULL REFERENCES assets (code),
  principal       NUMERIC(38, 18) NOT NULL CHECK (principal > 0),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'matured')),
  start_at        TIMESTAMPTZ NOT NULL,
  maturity_at     TIMESTAMPTZ NOT NULL,
  open_entry_id   UUID NOT NULL UNIQUE REFERENCES journal_entries (id),
  settle_entry_id UUID UNIQUE REFERENCES journal_entries (id),
  settled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT investments_maturity_after_start CHECK (maturity_at > start_at),
  CONSTRAINT investments_settlement_consistent CHECK (
    (status = 'matured') = (settle_entry_id IS NOT NULL AND settled_at IS NOT NULL)
  )
);
CREATE INDEX investments_user_idx ON investments (user_id, created_at DESC);
CREATE INDEX investments_due_idx ON investments (maturity_at) WHERE status = 'active';

-- Only the status transition active -> matured (with its settlement fields) is
-- allowed; principal, dates and ownership are immutable.
CREATE FUNCTION investments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'investments cannot be deleted';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.asset IS DISTINCT FROM OLD.asset
     OR NEW.principal IS DISTINCT FROM OLD.principal
     OR NEW.start_at IS DISTINCT FROM OLD.start_at
     OR NEW.maturity_at IS DISTINCT FROM OLD.maturity_at
     OR NEW.open_entry_id IS DISTINCT FROM OLD.open_entry_id THEN
    RAISE EXCEPTION 'investment terms are immutable';
  END IF;
  IF OLD.status = 'matured' THEN
    RAISE EXCEPTION 'matured investments are final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER investments_guard_trg
  BEFORE UPDATE OR DELETE ON investments
  FOR EACH ROW EXECUTE FUNCTION investments_guard();
