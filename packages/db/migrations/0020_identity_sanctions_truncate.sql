-- A row trigger does not fire on TRUNCATE, which would empty the audit trail
-- in one statement. Refused too. (Tests never truncate this table; they
-- read it by agent.)
CREATE TRIGGER compliance_audit_no_truncate BEFORE TRUNCATE ON compliance_audit
  FOR EACH STATEMENT EXECUTE FUNCTION pactora_audit_append_only();
