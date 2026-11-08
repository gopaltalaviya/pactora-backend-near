import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@pactora/db';
import {
  listingMatches,
  listingMatchesSql,
  locationMatches,
  locationMatchesSql,
  skillsMatch,
  skillsMatchSql,
  textArray,
} from '../src/matching.js';

/**
 * docs/26 F18: the matching rule exists twice — a TypeScript function and a
 * SQL predicate the board query uses — and the two must agree on every
 * input. Each fixture is fed to both, and each must equal what the rule says.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});

/** [listing location, worker location, matches?] */
const LOCATIONS: [string, string, boolean][] = [
  ['', '', true],
  ['', 'Berlin', true],
  ['Berlin', '', true],
  ['Berlin', 'Berlin', true],
  ['Berlin', 'berlin', true],
  ['  Berlin ', 'Berlin', true],
  ['Berlin', 'Paris', false],
  ['Berlin, DE', 'Berlin', true],
  ['Berlin', 'Berlin, DE', true],
  ['Berlin, DE', 'Berlin, de', true],
  ['Berlin, DE', 'Berlin,DE', true],
  ['Springfield, IL', 'Springfield, MO', false],
  ['Springfield, IL', 'Springfield', true],
  ['Paris, FR', 'Paris, Texas, US', false],
  ['Paris, Texas, US', 'Paris, Texas, US', true],
  [', Region', 'Anywhere', true],
  ['Rome', 'Roma', false],
];

/** [listing skills, worker skills, matches?] */
const SKILLS: [string[], string[], boolean][] = [
  [[], [], true],
  [[], ['photography'], true],
  [['photography'], [], false],
  [['photography'], ['photography'], true],
  [['photography', 'driving'], ['driving'], true],
  [['photography'], ['video'], false],
  [['data entry'], ['data entry', 'typing'], true],
];

async function sqlBool(predicate: ReturnType<typeof sql>): Promise<boolean> {
  const rows = (await db.execute(sql`SELECT ${predicate} AS m`)) as unknown as {m: boolean}[];
  return rows[0]!.m;
}

describe('location: city first', () => {
  it.each(LOCATIONS)('%j vs %j → %s, in TypeScript and in SQL', async (listing, worker, expected) => {
    expect(locationMatches(listing, worker)).toBe(expected);
    expect(await sqlBool(locationMatchesSql(sql`${listing}::text`, sql`${worker}::text`))).toBe(expected);
  });
});

describe('skills overlap', () => {
  it.each(SKILLS)('%j vs %j → %s, in TypeScript and in SQL', async (listing, worker, expected) => {
    expect(skillsMatch(listing, worker)).toBe(expected);
    expect(await sqlBool(skillsMatchSql(textArray(listing), textArray(worker)))).toBe(expected);
  });
});

describe('both together', () => {
  it('agrees on every combination of the fixtures', async () => {
    for (const [ls, ws] of SKILLS) {
      for (const [ll, wl] of LOCATIONS) {
        const ts = listingMatches({skills: ls, location: ll}, {skills: ws, location: wl});
        const inSql = await sqlBool(
          listingMatchesSql(
            {skills: textArray(ls), location: sql`${ll}::text`},
            {skills: textArray(ws), location: sql`${wl}::text`},
          ),
        );
        expect(inSql, `${JSON.stringify([ls, ws, ll, wl])}`).toBe(ts);
      }
    }
  });
});
