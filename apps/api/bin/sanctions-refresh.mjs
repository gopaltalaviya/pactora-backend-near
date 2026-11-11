#!/usr/bin/env node
/**
 * Fetch the sanctions lists and store them, if the guards allow
 * (docs/26 F14). Run it daily (cron, or the host's scheduler):
 *
 *   DATABASE_URL=... pnpm sanctions:refresh                       # from the repo, every list
 *   DATABASE_URL=... pnpm sanctions:refresh uk                    # only the ones named
 *   docker compose ... run --rm --no-deps api node bin/sanctions-refresh.mjs
 *                                                                 # on a server: the api image carries it
 *
 * It lives in the api package (2026-11-11) so the production image has it: a
 * server holds the images, not the repo, and its database is not reachable
 * from the host. A fresh production database has no list, so screening (on,
 * as production requires) has nothing to match: run it once at install.
 *
 * Each list is fetched from its publisher, parsed, and handed to storeList,
 * which skips an unchanged copy, refuses one that is too small or under 70 %
 * of the active one (keeping the old), and otherwise switches to the new copy
 * in one transaction. A failed fetch changes nothing. Exit code 0 when every
 * list is current (replaced or unchanged), 1 when any was refused or failed.
 *
 * Sources (checked 2026-11-08): OFAC SDN.CSV and ALT.CSV from the Sanctions
 * List Service, the UN consolidated XML, and (since 2026-11-08) the UK
 * Sanctions List XML from the FCDO. The EU list is not covered yet: its file
 * needs a token (docs/04 §5.1h).
 */
import {createDb, closeDb} from '@pactora/db';
import {parseOfac, parseUk, parseUn} from '@pactora/compliance';
import {storeList} from '../dist/compliance.js';

const SOURCES = {
  ofac: {
    sdn:
      process.env.OFAC_SDN_URL ??
      'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV',
    alt:
      process.env.OFAC_ALT_URL ??
      'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV',
  },
  un: {xml: process.env.UN_LIST_URL ?? 'https://scsanctions.un.org/resources/xml/en/consolidated.xml'},
  uk: {xml: process.env.UK_LIST_URL ?? 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml'},
};
const wanted = process.argv.slice(2);
const unknown = wanted.filter((s) => !(s in SOURCES));
if (unknown.length) {
  console.error(`unknown list(s): ${unknown.join(', ')} — the lists are ${Object.keys(SOURCES).join(', ')}`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — refusing to guess which database to write');
  process.exit(2);
}

async function fetchText(u) {
  const res = await fetch(u, {
    signal: AbortSignal.timeout(120_000),
    headers: {'user-agent': 'Pactora sanctions refresh'},
  });
  if (!res.ok) throw new Error(`${u} answered ${res.status}`);
  return res.text();
}

const db = createDb(url, {max: 2});
let bad = 0;
try {
  for (const source of /** @type {('ofac' | 'un' | 'uk')[]} */ (
    wanted.length ? wanted : Object.keys(SOURCES)
  )) {
    try {
      let raw;
      let entries;
      if (source === 'ofac') {
        const [sdn, alt] = await Promise.all([fetchText(SOURCES.ofac.sdn), fetchText(SOURCES.ofac.alt)]);
        raw = `${sdn}\n--alt--\n${alt}`;
        entries = parseOfac(sdn, alt);
      } else {
        raw = await fetchText(SOURCES[source].xml);
        entries = source === 'uk' ? parseUk(raw) : parseUn(raw);
      }
      const decision = await storeList(db, source, raw, entries);
      const counts = entries.reduce((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {});
      console.log(
        `${source}: ${decision.action}${decision.reason ? ` (${decision.reason})` : ''} — ${entries.length} entries ${JSON.stringify(counts)}`,
      );
      if (decision.action === 'refuse') bad++;
    } catch (err) {
      bad++;
      console.error(
        `${source}: failed, nothing changed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
} finally {
  await closeDb(db);
}
process.exit(bad ? 1 : 0);
