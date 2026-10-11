-- 0001: users, sessions, double-entry ledger, audit log, idempotency.
--
-- Ledger invariants enforced by the database (not just application code):
--   * journal entries and postings are append-only (no UPDATE/DELETE/TRUNCATE)
--   * every journal entry has >= 2 postings and balances (debits = credits) per asset
--   * account balances are maintained only by the posting trigger
--   * non-negative accounts can never go below zero (overdraft protection)
--   * posting asset must equal account asset

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
  code         TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{2,12}$'),
  name         TEXT NOT NULL,
  scale        SMALLINT NOT NULL CHECK (scale BETWEEN 0 AND 18),
  is_simulated BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO assets (code, name, scale, is_simulated)
VALUES ('USDT', 'Tether USD (simulated)', 6, TRUE);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  display_name  TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- Ledger accounts
-- ---------------------------------------------------------------------------
-- `purpose` is a closed list so that fund segregation is explicit and adding a
-- new kind of account requires a reviewed migration.
CREATE TABLE ledger_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  purpose        TEXT NOT NULL CHECK (purpose IN (
                   'user_available',        -- customer funds free to use (platform liability)
                   'user_invested',         -- customer principal locked in investments (platform liability)
                   'platform_sim_custody'   -- simulated USDT held by the platform (platform asset)
                 )),
  asset          TEXT NOT NULL REFERENCES assets (code),
  owner_user_id  UUID REFERENCES users (id),
  allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
  balance        NUMERIC(38, 18) NOT NULL DEFAULT 0,
  version        BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_no_overdraft CHECK (allow_negative OR balance >= 0),
  CONSTRAINT ledger_accounts_owner_matches_purpose CHECK ((purpose LIKE 'user\_%') = (owner_user_id IS NOT NULL)),
  CONSTRAINT ledger_accounts_id_asset_uq UNIQUE (id, asset)
);
CREATE UNIQUE INDEX ledger_accounts_user_purpose_uq
  ON ledger_accounts (owner_user_id, purpose, asset) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_accounts_platform_purpose_uq
  ON ledger_accounts (purpose, asset) WHERE owner_user_id IS NULL;

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type      TEXT NOT NULL CHECK (entry_type IN ('simulated_deposit', 'investment_open', 'investment_mature')),
  idempotency_key TEXT NOT NULL UNIQUE,
  description     TEXT NOT NULL,
  initiated_by    UUID REFERENCES users (id),
  reference_type  TEXT,
  reference_id    UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_reference_idx ON journal_entries (reference_type, reference_id);

CREATE TABLE ledger_postings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id      UUID NOT NULL REFERENCES journal_entries (id),
  account_id    UUID NOT NULL,
  asset         TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount        NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
  -- Running balance of the account after this posting; set by trigger.
  balance_after NUMERIC(38, 18) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, asset) REFERENCES ledger_accounts (id, asset)
);
CREATE INDEX ledger_postings_entry_idx ON ledger_postings (entry_id);
CREATE INDEX ledger_postings_account_idx ON ledger_postings (account_id, id);

-- Apply a posting to its account's cached balance. The UPDATE takes a row lock,
-- serialising concurrent writers on the same account, and the no-overdraft
-- CHECK on ledger_accounts rejects any posting that would overdraw.
CREATE FUNCTION ledger_apply_posting() RETURNS trigger AS $$
DECLARE
  v_normal TEXT;
  v_delta  NUMERIC(38, 18);
BEGIN
  SELECT normal_balance INTO v_normal FROM ledger_accounts WHERE id = NEW.account_id;
  IF v_normal IS NULL THEN
    RAISE EXCEPTION 'ledger account % not found', NEW.account_id;
  END IF;
  v_delta := CASE WHEN NEW.direction = v_normal THEN NEW.amount ELSE -NEW.amount END;
  UPDATE ledger_accounts
     SET balance = balance + v_delta, version = version + 1
   WHERE id = NEW.account_id
   RETURNING balance INTO NEW.balance_after;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_postings_apply
  BEFORE INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_posting();

-- Balance may only change via the posting trigger above.
CREATE FUNCTION ledger_accounts_guard_balance() RETURNS trigger AS $$
BEGIN
  IF (NEW.balance IS DISTINCT FROM OLD.balance OR NEW.version IS DISTINCT FROM OLD.version)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'ledger account balance can only change through ledger postings';
  END IF;
  IF NEW.asset IS DISTINCT FROM OLD.asset
     OR NEW.normal_balance IS DISTINCT FROM OLD.normal_balance
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'ledger account identity fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_accounts_guard
  BEFORE UPDATE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_accounts_guard_balance();

CREATE FUNCTION ledger_forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger accounts cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_accounts_no_delete
  BEFORE DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_delete();

-- Double-entry check, deferred to COMMIT so all postings of an entry can be
-- inserted first. Fires for both new entries (catches empty entries) and new
-- postings (catches postings appended to an existing entry).
CREATE FUNCTION ledger_check_entry_balanced(p_entry_id UUID) RETURNS void AS $$
DECLARE
  v_count INT;
  v_bad   TEXT;
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
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION journal_entries_check_trg() RETURNS trigger AS $$
BEGIN
  PERFORM ledger_check_entry_balanced(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION ledger_postings_check_trg() RETURNS trigger AS $$
BEGIN
  PERFORM ledger_check_entry_balanced(NEW.entry_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entries_check_trg();

CREATE CONSTRAINT TRIGGER ledger_postings_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_postings_check_trg();

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id UUID REFERENCES users (id),
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip            TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_postings_append_only BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_postings_no_truncate BEFORE TRUNCATE ON ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------
-- A client-supplied key is bound to one user, one operation and one request
-- body. Replays return the stored response; reuse with a different body is
-- rejected.
CREATE TABLE idempotency_keys (
  user_id      UUID NOT NULL REFERENCES users (id),
  key          TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  operation    TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INT,
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
