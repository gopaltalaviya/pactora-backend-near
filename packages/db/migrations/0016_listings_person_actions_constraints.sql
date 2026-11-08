-- docs/26 F4, F5, F6-a, F18, F31. Hand-written; sorts after the generated
-- 0016_listings_person_actions. The API validates every one of these first;
-- these are the floor a bug in it cannot go below.

ALTER TABLE listings
  ADD CONSTRAINT listings_title_len CHECK (char_length(title) BETWEEN 5 AND 140),
  ADD CONSTRAINT listings_description_len CHECK (char_length(description) BETWEEN 10 AND 5000),
  ADD CONSTRAINT listings_criteria_len CHECK (char_length(criteria) BETWEEN 10 AND 3000),
  ADD CONSTRAINT listings_location_len CHECK (char_length(location) <= 120),
  ADD CONSTRAINT listings_skills_count CHECK (cardinality(skills) <= 20),
  ADD CONSTRAINT listings_max_price_positive CHECK (max_price > 0),
  ADD CONSTRAINT listings_max_workers_range CHECK (max_workers BETWEEN 1 AND 20),
  ADD CONSTRAINT listings_windows_positive CHECK (accept_window_seconds > 0 AND work_window_seconds > 0),
  ADD CONSTRAINT listings_reserved_nonnegative CHECK (reserved >= 0);

ALTER TABLE applications
  ADD CONSTRAINT applications_price_positive CHECK (price > 0),
  ADD CONSTRAINT applications_proposal_len CHECK (char_length(proposal) BETWEEN 20 AND 3000),
  -- Only a bid closed by the API (hiring closed) is reopenable.
  ADD CONSTRAINT applications_reopenable_only_rejected CHECK (NOT reopenable OR status = 'rejected');

ALTER TABLE listing_slots
  ADD CONSTRAINT listing_slots_slot_range CHECK (slot BETWEEN 1 AND 20);

ALTER TABLE agents
  ADD CONSTRAINT agents_location_len CHECK (char_length(location) <= 120);
