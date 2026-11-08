import {createHash} from 'node:crypto';
import type {ListEntry} from './match.js';

/**
 * Sanctions list parsers and the guards a refresh must pass (docs/26 F14).
 *
 * Built against the files as published on 2026-11-08 (OFAC SDN.CSV 19,563
 * entries and ALT.CSV 20,232 aliases; UN consolidated.xml 733 individuals
 * and 274 entities). No network here: a refresh script fetches, these
 * functions only read text.
 *
 * Not covered yet, and said so: the UK and EU lists. Their files were not
 * inspected for this version, and a parser written blind is worse than
 * none.
 */

/** RFC 4180 CSV with OFAC's habits: quoted fields, and `-0-` meaning empty. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((f) => (f.trim() === '-0-' ? '' : f.trim())));
}

/**
 * OFAC: SDN.CSV (ent_num, name, type, program, title, …, remarks) and
 * ALT.CSV (ent_num, alt_num, type, alt_name, remarks). An individual's
 * name is "LAST, First"; it is turned into "First LAST" too, so either
 * order matches. Digital currency addresses come from the remarks.
 */
export function parseOfac(sdnCsv: string, altCsv = ''): ListEntry[] {
  const byRef = new Map<string, ListEntry>();
  const orders = (name: string) => {
    const comma = name.indexOf(',');
    return comma > 0 ? [name, `${name.slice(comma + 1).trim()} ${name.slice(0, comma).trim()}`] : [name];
  };
  for (const r of parseCsv(sdnCsv)) {
    const [ref, name, type, , , , , , , , , remarks = ''] = r;
    if (!ref || !/^\d+$/.test(ref) || !name) continue;
    const kind = type === 'individual' ? 'individual' : type === '' ? 'entity' : 'other';
    const addresses = [...remarks.matchAll(/Digital Currency Address - ([A-Z0-9]+) ([^;]+);?/g)].map((m) => ({
      ticker: m[1]!,
      address: m[2]!.trim(),
    }));
    byRef.set(ref, {
      source: 'ofac',
      ref,
      kind,
      names: kind === 'individual' ? orders(name) : [name],
      ...(addresses.length ? {addresses} : {}),
    });
  }
  for (const r of parseCsv(altCsv)) {
    const [ref, , , alt] = r;
    const e = ref ? byRef.get(ref) : undefined;
    if (e && alt)
      for (const n of e.kind === 'individual' ? orders(alt) : [alt])
        if (!e.names.includes(n)) e.names.push(n);
  }
  return [...byRef.values()];
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const tag = (block: string, name: string): string => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decode(m[1]!).trim() : '';
};

/**
 * UN consolidated.xml: <INDIVIDUAL> and <ENTITY> blocks with FIRST_NAME …
 * FOURTH_NAME and <*_ALIAS><ALIAS_NAME>. The format is flat and fixed by
 * its XSD, so a tag reader is enough; anything unexpected is skipped, and
 * the refresh guards (entry counts) catch a format change.
 */
export function parseUn(xml: string): ListEntry[] {
  const out: ListEntry[] = [];
  for (const [kind, block] of [
    ['individual', 'INDIVIDUAL'],
    ['entity', 'ENTITY'],
  ] as const) {
    for (const m of xml.matchAll(new RegExp(`<${block}>([\\s\\S]*?)</${block}>`, 'g'))) {
      const b = m[1]!;
      const ref = tag(b, 'DATAID');
      const primary = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME']
        .map((t) => tag(b, t))
        .filter(Boolean)
        .join(' ');
      if (!ref || !primary) continue;
      const names = [primary];
      for (const a of b.matchAll(/<ALIAS_NAME>([\s\S]*?)<\/ALIAS_NAME>/g)) {
        const alias = decode(a[1]!).trim();
        if (alias && !names.includes(alias)) names.push(alias);
      }
      out.push({source: 'un', ref, kind, names});
    }
  }
  return out;
}

export const sha256Text = (s: string) => createHash('sha256').update(s).digest('hex');

/** The fewest entries a copy of each list may have before it is believed. */
export const MIN_ENTRIES: Record<string, number> = {ofac: 5000, un: 500};
/** A new copy smaller than this share of the active one is refused as truncated. */
export const MIN_SHARE_OF_PREVIOUS = 0.7;

export type RefreshDecision =
  | {action: 'skip'; reason: string}
  | {action: 'refuse'; reason: string}
  | {action: 'replace'; entries: number};

/**
 * Whether a freshly fetched copy may replace the active one. Same hash →
 * skip (nothing changed). Too few entries, or fewer than 70 % of what is
 * active → refuse and keep the old copy: a truncated download must never
 * empty the list a screening relies on.
 */
export function refreshDecision(
  source: string,
  fresh: {sha256: string; entries: number},
  active: {sha256: string; entries: number} | null,
): RefreshDecision {
  if (active && active.sha256 === fresh.sha256) return {action: 'skip', reason: 'unchanged'};
  const min = MIN_ENTRIES[source] ?? 1;
  if (fresh.entries < min) {
    return {
      action: 'refuse',
      reason: `${fresh.entries} entries, below the ${min} a ${source} copy must have`,
    };
  }
  if (active && fresh.entries < active.entries * MIN_SHARE_OF_PREVIOUS) {
    return {
      action: 'refuse',
      reason: `${fresh.entries} entries is below 70% of the active copy's ${active.entries}; kept the old copy`,
    };
  }
  return {action: 'replace', entries: fresh.entries};
}
