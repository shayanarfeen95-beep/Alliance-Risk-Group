-- ---------------------------------------------------------------------------
-- Database-level guards.
--
-- Spec §10.3: "Enforce immutability at the database level, not only in the
-- interface." Defect 4 exists precisely because the Excel's controls lived in a
-- documented workflow rather than in the system. These are the controls that
-- survive an application bug, a stray migration, or a direct psql session.
--
-- Acceptance Test 7: "A locked forecast version cannot be edited or deleted
-- through the interface or the API. Attempt both."
-- ---------------------------------------------------------------------------

-- A locked forecast row is read-only. Full stop.
CREATE OR REPLACE FUNCTION prevent_locked_forecast_mutation()
RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    IF OLD.is_locked THEN
      RAISE EXCEPTION
        'fact_forecast row is locked and cannot be deleted (version %, % %). A correction creates a new version.',
        OLD.forecast_version_id, OLD.period_month, OLD.division_code
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_locked THEN
    RAISE EXCEPTION
      'fact_forecast row is locked and cannot be modified (version %, % %). A correction creates a new version.',
      OLD.forecast_version_id, OLD.period_month, OLD.division_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fact_forecast_immutable_when_locked
BEFORE UPDATE OR DELETE ON fact_forecast
FOR EACH ROW EXECUTE FUNCTION prevent_locked_forecast_mutation();
--> statement-breakpoint

-- The version header is an accountability record too: once locked, only
-- is_official and supersedes bookkeeping may move. The assumptions, the month,
-- the lock timestamp and the locking user are frozen.
CREATE OR REPLACE FUNCTION prevent_locked_forecast_version_mutation()
RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    IF OLD.is_locked THEN
      RAISE EXCEPTION 'forecast_version % is locked and cannot be deleted.', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_locked AND (
       NEW.period_month   IS DISTINCT FROM OLD.period_month
    OR NEW.scenario_name  IS DISTINCT FROM OLD.scenario_name
    OR NEW.is_locked      IS DISTINCT FROM OLD.is_locked
    OR NEW.locked_at      IS DISTINCT FROM OLD.locked_at
    OR NEW.locked_by      IS DISTINCT FROM OLD.locked_by
  ) THEN
    RAISE EXCEPTION
      'forecast_version % is locked; a correction must create a new version.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER forecast_version_immutable_when_locked
BEFORE UPDATE OR DELETE ON forecast_version
FOR EACH ROW EXECUTE FUNCTION prevent_locked_forecast_version_mutation();
--> statement-breakpoint

-- §10.2: "Exactly one scenario per month is promoted to the official locked
-- forecast." Enforced as a partial unique index rather than by convention.
CREATE UNIQUE INDEX forecast_version_one_official_per_month
ON forecast_version (period_month)
WHERE is_official;
--> statement-breakpoint

-- §5.3: once Westport closes a month, that month's figures are frozen. A later
-- restatement bumps dim_period.restatement_version, which is what unlocks the
-- write; nothing edits a closed month in place.
CREATE OR REPLACE FUNCTION prevent_closed_period_write()
RETURNS trigger AS $$
DECLARE
  v_is_closed boolean;
  v_period    date;
BEGIN
  v_period := COALESCE(NEW.period_month, OLD.period_month);
  SELECT is_closed INTO v_is_closed FROM dim_period WHERE period_month = v_period;

  IF COALESCE(v_is_closed, false)
     AND COALESCE(current_setting('arg.allow_restatement', true), 'off') <> 'on' THEN
    RAISE EXCEPTION
      'period % is closed; write to % rejected. Restate through a new version instead.',
      v_period, TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fact_pl_actual_closed_period_guard
BEFORE INSERT OR UPDATE OR DELETE ON fact_pl_actual
FOR EACH ROW EXECUTE FUNCTION prevent_closed_period_write();
--> statement-breakpoint

CREATE TRIGGER fact_bs_actual_closed_period_guard
BEFORE INSERT OR UPDATE OR DELETE ON fact_bs_actual
FOR EACH ROW EXECUTE FUNCTION prevent_closed_period_write();
--> statement-breakpoint

CREATE TRIGGER fact_gl_balance_closed_period_guard
BEFORE INSERT OR UPDATE OR DELETE ON fact_gl_balance
FOR EACH ROW EXECUTE FUNCTION prevent_closed_period_write();
--> statement-breakpoint

-- Defect 1 / Test 8: "Never wrap a lookup in a silent zero default — a missing
-- figure must surface, not read as $0." An unmapped GL account is a loud error,
-- not an 'other' bucket. dim_account.reporting_line is nullable while the
-- account is being classified, but no balance may reference an unclassified
-- P&L account.
CREATE OR REPLACE FUNCTION reject_unmapped_pl_account()
RETURNS trigger AS $$
DECLARE
  v_type gl_account_type;
  v_line reporting_line;
  v_bs   text;
BEGIN
  SELECT account_type, reporting_line, balance_sheet_line
    INTO v_type, v_line, v_bs
    FROM dim_account WHERE account_id = NEW.account_id;

  IF v_type IS NULL THEN
    RAISE EXCEPTION 'GL account % is not in dim_account. Map it before loading.', NEW.account_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_type IN ('INCOME', 'COGS', 'EXPENSE') AND v_line IS NULL THEN
    RAISE EXCEPTION
      'GL account % has no reporting_line. Loads never default to "other" — map it first.',
      NEW.account_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_type IN ('ASSET', 'LIABILITY', 'EQUITY') AND v_bs IS NULL THEN
    RAISE EXCEPTION
      'GL account % has no balance_sheet_line. Map it before loading.', NEW.account_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fact_gl_balance_requires_mapping
BEFORE INSERT OR UPDATE ON fact_gl_balance
FOR EACH ROW EXECUTE FUNCTION reject_unmapped_pl_account();
