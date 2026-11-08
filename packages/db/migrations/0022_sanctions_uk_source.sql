-- docs/26 F14: the UK Sanctions List (FCDO) joins OFAC and UN. Hand-written;
-- widens the CHECK 0020_identity_sanctions_trigger_constraints added.

ALTER TABLE sanctions_list_versions DROP CONSTRAINT sanctions_list_versions_source_known;
ALTER TABLE sanctions_list_versions
  ADD CONSTRAINT sanctions_list_versions_source_known CHECK (source IN ('ofac', 'un', 'uk'));
