-- NEAR port (docs/NEAR-PORT.md §1–2). Hand-written; sorts before the
-- generated 0011_near_network_keys, which turns every chain_id into text.

-- 1. This database must not hold EVM rows. Their chain_id (10143, 31337)
--    would become the text '10143' — a key no NEAR service ever asks for —
--    and their 0x addresses would fail the checks below in a confusing way.
--    A NEAR deployment starts from an empty database; say so plainly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents) OR EXISTS (SELECT 1 FROM jobs) OR EXISTS (SELECT 1 FROM token_transfers) THEN
    RAISE EXCEPTION 'this database holds EVM (Monad) rows; the NEAR build needs an empty database (see docs/NEAR-PORT.md)';
  END IF;
END $$;

-- 2. Accounts are NEAR account ids, not 0x addresses: 2–64 characters,
--    nearcore's rule. Lower case is part of the rule, which keeps the trust
--    queries' `=` comparisons sound, as the 0x checks did.
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
