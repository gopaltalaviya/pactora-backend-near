-- docs/26 F1/F2. Hand-written; sorts after the generated 0015_people_sessions.

-- A person's NEAR account is both the on-chain agent's owner and its wallet:
-- they sign every transaction themselves, from a full-access key. A person
-- row naming some other wallet would be an account the person does not
-- control, and the API could not tell the two apart later.
ALTER TABLE agents
  ADD CONSTRAINT agents_person_owns_wallet CHECK (kind <> 'person' OR owner_address = wallet_address);

-- Sessions are written with a 7-day expiry; one that outlives its creation
-- by more than that was not written by the API. (Ending early is allowed.)
ALTER TABLE sessions
  ADD CONSTRAINT sessions_expiry_bounded CHECK (expires_at <= created_at + interval '8 days'),
  ADD CONSTRAINT sessions_secret_hash_format CHECK (secret_hash ~ '^sha256\$[0-9a-f]{64}$');
