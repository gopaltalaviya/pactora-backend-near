import {sql, type SQL} from 'drizzle-orm';

/**
 * Who a listing is for (docs/26 F18): skills overlap, and a city-first
 * location rule. Implemented twice — once in TypeScript for one listing in
 * hand, once as a SQL predicate for the board query — and
 * apps/api/test/matching.test.ts feeds the same fixtures to both, so the two
 * cannot drift.
 *
 * Location is "City" or "City, Region" (the region is everything after the
 * first comma). Compared case-insensitively, with the parts trimmed:
 *
 * - an empty location on either side matches everything;
 * - different cities never match;
 * - the same city matches when at least one side gave no region;
 * - the same city with two different regions does not match
 *   ("Springfield, IL" is not "Springfield, MO").
 *
 * Skills: a listing that names none is open to anyone; otherwise the worker
 * must have at least one of them. Skills are stored lower-case.
 */

/** City and region of a location, lower-case and trimmed; '' when absent. */
export function parseLocation(location: string): {city: string; region: string} {
  const at = location.indexOf(',');
  const city = (at === -1 ? location : location.slice(0, at)).trim().toLowerCase();
  const region =
    at === -1
      ? ''
      : location
          .slice(at + 1)
          .trim()
          .toLowerCase();
  return {city, region};
}

export function locationMatches(listing: string, worker: string): boolean {
  const a = parseLocation(listing);
  const b = parseLocation(worker);
  if (a.city === '' || b.city === '') return true;
  if (a.city !== b.city) return false;
  return a.region === '' || b.region === '' || a.region === b.region;
}

export function skillsMatch(listingSkills: readonly string[], workerSkills: readonly string[]): boolean {
  if (listingSkills.length === 0) return true;
  const have = new Set(workerSkills.map((s) => s.toLowerCase()));
  return listingSkills.some((s) => have.has(s.toLowerCase()));
}

export function listingMatches(
  listing: {skills: readonly string[]; location: string},
  worker: {skills: readonly string[]; location: string},
): boolean {
  return skillsMatch(listing.skills, worker.skills) && locationMatches(listing.location, worker.location);
}

// ── the same rules, in SQL ───────────────────────────────────────────────

/** Spaces only are trimmed — inputs are normalised to single spaces before they are stored (see listings.ts). */
const city = (loc: SQL) => sql`lower(btrim(split_part(${loc}, ',', 1)))`;
const region = (loc: SQL) =>
  sql`(CASE WHEN strpos(${loc}, ',') > 0 THEN lower(btrim(substr(${loc}, strpos(${loc}, ',') + 1))) ELSE '' END)`;

export function locationMatchesSql(listing: SQL, worker: SQL): SQL {
  return sql`(${city(listing)} = '' OR ${city(worker)} = '' OR (${city(listing)} = ${city(worker)} AND (${region(listing)} = '' OR ${region(worker)} = '' OR ${region(listing)} = ${region(worker)})))`;
}

/** `workerSkills` is a lower-case text[] expression. */
export function skillsMatchSql(listingSkills: SQL, workerSkills: SQL): SQL {
  return sql`(cardinality(${listingSkills}) = 0 OR ${listingSkills} && ${workerSkills})`;
}

export function listingMatchesSql(
  listing: {skills: SQL; location: SQL},
  worker: {skills: SQL; location: SQL},
): SQL {
  return sql`(${skillsMatchSql(listing.skills, worker.skills)} AND ${locationMatchesSql(listing.location, worker.location)})`;
}

/** A JS string array as a Postgres text[] parameter. */
export function textArray(values: readonly string[]): SQL {
  return sql`${`{${values.map((v) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(',')}}`}::text[]`;
}
