-- NEAR identifiers (docs/NEAR-WIRE.md §1–2). Hand-written; sorts before the
-- generated 0011_near_network_keys, which turns every chain_id into text.

-- 1. This migration needs an empty database. Rows keyed by a numeric
--    chain_id would become text no NEAR service ever asks for, and
--    non-NEAR account ids would fail the checks below in a confusing way.
--    A NEAR deployment starts from an empty database; say so plainly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents) OR EXISTS (SELECT 1 FROM jobs) OR EXISTS (SELECT 1 FROM token_transfers) THEN
    RAISE EXCEPTION 'this database already holds agents, jobs or transfers; the NEAR schema needs an empty database (see docs/NEAR-WIRE.md)';
  END IF;
END $$;

-- 2. Accounts are NEAR account ids, not 0x addresses: 2–64 characters,
--    nearcore's rule. Lower case is part of the rule, which keeps the trust
--    queries' `=` comparisons sound.
ALTER TABLE token_transfers
  DROP CONSTRAINT token_transfers_from_lower,
  DROP CONSTRAINT token_transfers_to_lower,
  ADD CONSTRAINT token_transfers_from_account CHECK (
    length(from_address) BETWEEN 2 AND 64
    AND from_address ~ '^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$'),
  ADD CONSTRAINT token_transfers_to_account CHECK (
    length(to_address) BETWEEN 2 AND 64
    AND to_address ~ '^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$');

ALTER TABLE agents
  ADD CONSTRAINT agents_owner_account CHECK (
    length(owner_address) BETWEEN 2 AND 64
    AND owner_address ~ '^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$'),
  ADD CONSTRAINT agents_wallet_account CHECK (
    length(wallet_address) BETWEEN 2 AND 64
    AND wallet_address ~ '^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$');

-- 3. The CAIP-2 checks on chain_id are at the end of 0011_near_network_keys,
--    after the type change they depend on.
