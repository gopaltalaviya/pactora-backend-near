-- docs/26 F13, F14, F27. Hand-written; sorts after the generated
-- 0020_identity_sanctions_standing.

ALTER TABLE sanctions_list_versions
  ADD CONSTRAINT sanctions_list_versions_source_known CHECK (source IN ('ofac', 'un')),
  ADD CONSTRAINT sanctions_list_versions_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT sanctions_list_versions_count_positive CHECK (entry_count > 0);
-- Exactly one copy of each list is the one screenings read.
CREATE UNIQUE INDEX sanctions_list_versions_one_active ON sanctions_list_versions (source) WHERE active;

ALTER TABLE sanctions_entries
  ADD CONSTRAINT sanctions_entries_kind_known CHECK (kind IN ('individual', 'entity', 'other'));

ALTER TABLE identity_verifications
  ADD CONSTRAINT identity_verifications_status_known
    CHECK (status IN ('screening', 'held', 'pending', 'approved', 'rejected', 'expired')),
  ADD CONSTRAINT identity_verifications_approved_needs_document
    CHECK (status <> 'approved' OR document_verified),
  ADD CONSTRAINT identity_verifications_name_len CHECK (char_length(btrim(legal_name)) BETWEEN 2 AND 200);

ALTER TABLE account_standing
  ADD CONSTRAINT account_standing_known CHECK (standing IN ('clear', 'hold', 'blocked')),
  ADD CONSTRAINT account_standing_reason CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500);

ALTER TABLE compliance_cases
  ADD CONSTRAINT compliance_cases_status_known CHECK (status IN ('open', 'cleared', 'confirmed')),
  ADD CONSTRAINT compliance_cases_strength_known CHECK (strength IN ('strong', 'weak')),
  ADD CONSTRAINT compliance_cases_closed CHECK ((status = 'open') = (closed_at IS NULL));

ALTER TABLE compliance_decisions
  ADD CONSTRAINT compliance_decisions_known CHECK (decision IN ('clear', 'confirm')),
  ADD CONSTRAINT compliance_decisions_reason CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000);

-- The audit trail is append-only: not even the API's own role may change
-- or remove a row. A correction is a new row.
CREATE OR REPLACE FUNCTION pactora_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance_audit is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER compliance_audit_append_only BEFORE UPDATE OR DELETE ON compliance_audit
  FOR EACH ROW EXECUTE FUNCTION pactora_audit_append_only();
