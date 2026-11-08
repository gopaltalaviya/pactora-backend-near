/**
 * Name screening (docs/26 F14): does a person's name match an entry on a
 * sanctions list?
 *
 * Names arrive in every script and spelling, so both sides are folded to
 * plain lowercase ASCII words first. Then two passes, either of which is a
 * match:
 *
 * 1. Word by word: every word of the shorter name finds a word in the
 *    longer one, in any order, with Jaro-Winkler similarity ≥ 0.92. A word
 *    of 3 letters or fewer must match EXACTLY, because short words are
 *    alike by accident ("al" and "el", "li" and "le").
 * 2. Joined: the whole names, spaces removed, with similarity ≥ 0.97. That
 *    catches a name written as one word on one side ("abdulrahman") and
 *    two on the other ("abdul rahman").
 *
 * A single-word query matches only a single-word entry name, or by the
 * joined pass: one common first name must never match half a list.
 *
 * This finds candidates for a person to review. It never decides: a match
 * opens a case (compliance.ts), and only reviewers clear or confirm it.
 */

export const WORD_THRESHOLD = 0.92;
export const JOINED_THRESHOLD = 0.97;
export const SHORT_WORD = 3;

/** Lowercase ASCII words: accents removed, punctuation and digits to spaces. */
export function foldName(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .replace(/[đĐ]/g, 'd')
    .replace(/[ıİ]/g, 'i')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

/** Jaro-Winkler similarity, 0..1 (prefix scale 0.1, up to 4 characters). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

const wordsMatch = (x: string, y: string) =>
  x.length <= SHORT_WORD || y.length <= SHORT_WORD ? x === y : jaroWinkler(x, y) >= WORD_THRESHOLD;

export interface NameMatch {
  /** 0..1: the weakest word similarity (pass 1) or the joined similarity (pass 2). */
  score: number;
  pass: 'words' | 'joined';
}

/** Whether two names match, and how strongly; null if they do not. */
export function matchNames(query: string, candidate: string): NameMatch | null {
  const q = foldName(query);
  const c = foldName(candidate);
  if (q.length === 0 || c.length === 0) return null;

  const joinedScore = jaroWinkler(q.join(''), c.join(''));
  const joined: NameMatch | null =
    joinedScore >= JOINED_THRESHOLD ? {score: joinedScore, pass: 'joined'} : null;

  // Word pass: the shorter name's words each find a distinct partner in the longer one.
  const [short, long] = q.length <= c.length ? [q, c] : [c, q];
  if (short.length === 1 && long.length > 1) return joined;
  const used = new Set<number>();
  let weakest = 1;
  for (const w of short) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < long.length; i++) {
      if (used.has(i) || !wordsMatch(w, long[i]!)) continue;
      const s = w === long[i] ? 1 : jaroWinkler(w, long[i]!);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    if (best < 0) return joined;
    used.add(best);
    weakest = Math.min(weakest, bestScore);
  }
  // Two of three words is not the same person: the shorter name must be at
  // least two-thirds as long as the longer, so "ali hassan" does not match
  // every five-part name that contains both.
  if (short.length * 3 < long.length * 2) return joined;
  const words: NameMatch = {score: weakest, pass: 'words'};
  return joined && joined.score > words.score ? joined : words;
}

export interface ListEntry {
  source: string;
  /** The list's own id for the entry (OFAC ent_num, UN DATAID). */
  ref: string;
  kind: 'individual' | 'entity' | 'other';
  /** The primary name first, then aliases. */
  names: string[];
  /** Digital currency addresses the list gives, by ticker (OFAC). */
  addresses?: {ticker: string; address: string}[];
}

export interface ScreeningHit {
  entry: ListEntry;
  matchedName: string;
  score: number;
  pass: 'words' | 'joined';
}

/** Every entry one of whose names matches; strongest first. Only individuals are screened against a person. */
export function screenName(
  name: string,
  entries: Iterable<ListEntry>,
  opts: {kinds?: ListEntry['kind'][]} = {},
): ScreeningHit[] {
  const kinds = opts.kinds ?? ['individual'];
  const hits: ScreeningHit[] = [];
  for (const entry of entries) {
    if (!kinds.includes(entry.kind)) continue;
    let best: ScreeningHit | null = null;
    for (const n of entry.names) {
      const m = matchNames(name, n);
      if (m && (!best || m.score > best.score)) best = {entry, matchedName: n, score: m.score, pass: m.pass};
    }
    if (best) hits.push(best);
  }
  return hits.sort((a, b) => b.score - a.score);
}
