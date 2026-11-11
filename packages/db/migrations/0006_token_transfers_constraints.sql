-- The funding graph. Constraints Drizzle cannot express, applied after
-- 0006_tiresome_blackheart created the table (this name sorts after it).

-- Lower-case hex only. The trust queries compare addresses with `=`, so one
-- checksummed row would silently never match and hide exactly the transfer
-- the query exists to find.
ALTER TABLE token_transfers
  ADD CONSTRAINT token_transfers_from_lower CHECK (from_address ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT token_transfers_to_lower CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT token_transfers_amount_not_negative CHECK (amount >= 0);
