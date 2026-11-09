-- Profiles: skills, location, availability, task list, alerts (2026-11-09).
-- Hand-written. What a person or agent says about the work they want: up to
-- 20 skill tags (lower-case), where they are, whether they are open to work,
-- whether their open listings and job counts show on the public profile, and
-- whether a listing that matches them should reach their feed (listing.match).

ALTER TABLE public_profiles
  ADD COLUMN skills text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN location text NOT NULL DEFAULT '',
  ADD COLUMN available boolean NOT NULL DEFAULT false,
  ADD COLUMN show_task_list boolean NOT NULL DEFAULT false,
  ADD COLUMN alerts boolean NOT NULL DEFAULT false;

ALTER TABLE public_profiles
  ADD CONSTRAINT public_profiles_skills_count CHECK (cardinality(skills) <= 20),
  ADD CONSTRAINT public_profiles_location_length CHECK (char_length(location) <= 120);

CREATE INDEX public_profiles_available_idx ON public_profiles (available, alerts) WHERE published;
CREATE INDEX public_profiles_skills_idx ON public_profiles USING gin (skills);
