-- docs/26 F11, F12. Hand-written; sorts after the generated 0021_channels.

ALTER TABLE channel_links
  ADD CONSTRAINT channel_links_channel_known CHECK (channel IN ('telegram', 'email')),
  ADD CONSTRAINT channel_links_address_len CHECK (char_length(address) BETWEEN 1 AND 320);

ALTER TABLE link_codes
  ADD CONSTRAINT link_codes_channel_known CHECK (channel IN ('telegram', 'email')),
  -- 8 characters, none of 0 O 1 I (read aloud or typed, they are confused).
  ADD CONSTRAINT link_codes_code_alphabet CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  ADD CONSTRAINT link_codes_secret_digits CHECK (secret ~ '^[0-9]{4,6}$'),
  ADD CONSTRAINT link_codes_tries_range CHECK (tries BETWEEN 0 AND 3);

ALTER TABLE channel_failures
  ADD CONSTRAINT channel_failures_nonneg CHECK (failures >= 0);

ALTER TABLE channel_outbox
  ADD CONSTRAINT channel_outbox_channel_known CHECK (channel IN ('telegram', 'email')),
  ADD CONSTRAINT channel_outbox_status_known CHECK (status IN ('pending', 'sent', 'dropped', 'failed')),
  -- Once sent, the text is gone: only the fact that something was sent stays.
  ADD CONSTRAINT channel_outbox_scrubbed CHECK (status = 'pending' OR body = ''),
  ADD CONSTRAINT channel_outbox_body_len CHECK (char_length(body) <= 4096);
