import {describe, expect, it} from 'vitest';
import {
  foldName,
  jaroWinkler,
  matchNames,
  parseCsv,
  parseOfac,
  parseUn,
  refreshDecision,
  screenName,
  sha256Text,
} from '../src/index.js';

/**
 * Fixtures copy the structure of the files as published on 2026-11-08 (OFAC
 * SDN.CSV / ALT.CSV, UN consolidated.xml); the parsers were also run on the
 * full real files (19,563 OFAC entries, 1,007 UN), see docs/04 §5.1h.
 */

const SDN = [
  '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  '2674,"ABBAS, Abu","individual","SDGT","Director of PALESTINE LIBERATION FRONT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 10 Dec 1948; POB Baghdad, Iraq."',
  '9001,"KARIMOV, Rustam","individual","CYBER2",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Digital Currency Address - XBT 1AbcDEF; Digital Currency Address - ETH 0xdeadBEEF; alt. Digital Currency Address - ETH 0x1234;"',
  '9002,"OCEAN STAR","vessel","IRAN",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Vessel ""quoted"" name."',
].join('\r\n');
const ALT = [
  '2674,12,"aka","ZAYDAN, Muhammad",-0- ',
  '36,13,"aka","AERO-CARIBBEAN",-0- ',
  '9999,14,"aka","ORPHAN",-0- ',
].join('\n');

const UN = `<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST><INDIVIDUALS>
  <INDIVIDUAL><DATAID>6907993</DATAID><FIRST_NAME>ERIC</FIRST_NAME><SECOND_NAME>BADEGE</SECOND_NAME>
    <INDIVIDUAL_ALIAS><QUALITY/><ALIAS_NAME/></INDIVIDUAL_ALIAS></INDIVIDUAL>
  <INDIVIDUAL><DATAID>6908000</DATAID><FIRST_NAME>FRANK</FIRST_NAME><SECOND_NAME>KAKOLELE</SECOND_NAME><THIRD_NAME>BWAMBALE</THIRD_NAME>
    <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>FRANK KAKORERE</ALIAS_NAME></INDIVIDUAL_ALIAS>
    <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>O&apos;BRIEN &amp; SONS</ALIAS_NAME></INDIVIDUAL_ALIAS></INDIVIDUAL>
</INDIVIDUALS><ENTITIES>
  <ENTITY><DATAID>6908402</DATAID><FIRST_NAME>ADF</FIRST_NAME></ENTITY>
  <ENTITY><DATAID></DATAID><FIRST_NAME>NO ID</FIRST_NAME></ENTITY>
</ENTITIES></CONSOLIDATED_LIST>`;

describe('foldName', () => {
  it('folds accents, case, punctuation and digits to plain words', () => {
    expect(foldName('José  María Ñúñez-López')).toEqual(['jose', 'maria', 'nunez', 'lopez']);
    expect(foldName("O'Brien")).toEqual(['obrien']);
    expect(foldName('Straße Øster Łódź İzmir')).toEqual(['strasse', 'oster', 'lodz', 'izmir']);
    expect(foldName('  2nd. ')).toEqual(['nd']);
    expect(foldName('محمد')).toEqual([]);
  });
});

describe('jaroWinkler', () => {
  it('matches the textbook values', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 2);
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.813, 3);
    expect(jaroWinkler('abc', 'abc')).toBe(1);
    expect(jaroWinkler('', '')).toBe(0);
    expect(jaroWinkler('abc', '')).toBe(0);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });
});

describe('matchNames', () => {
  it('matches in any order, across accents and punctuation', () => {
    expect(matchNames('Eric Badege', 'BADEGE, Eric')?.score).toBe(1);
    expect(matchNames('josé lópez', 'LOPEZ, Jose')?.pass).toBe('words');
  });

  it('tolerates a small spelling difference in a long word (≥ 0.92)', () => {
    expect(matchNames('Muhammad Zaydan', 'Mohammad Zaydan')).not.toBeNull();
    expect(matchNames('Kakolele Bwambale', 'Kakolele Bwambalé')).not.toBeNull();
  });

  it('needs short words (≤ 3 letters) to be exact', () => {
    expect(matchNames('Ali Hassan', 'Ali Hassan')).not.toBeNull();
    expect(matchNames('Ali Hassan', 'Ari Hassan')).toBeNull();
    expect(matchNames('Al Rahman', 'El Rahman')).toBeNull();
  });

  it('a single common word does not match a longer name; a joined spelling does', () => {
    expect(matchNames('Ali', 'Ali Hassan Mahmoud')).toBeNull();
    expect(matchNames('Abdulrahman Saleh', 'Abdul Rahman Saleh')?.pass).toBe('joined');
  });

  it('two words out of five is not the same person', () => {
    expect(matchNames('Ali Hassan', 'Ali Hassan Mahmoud Abdel Karim')).toBeNull();
    expect(matchNames('Ali Hassan Mahmoud Karim', 'Ali Hassan Mahmoud Abdel Karim')).not.toBeNull();
  });

  // Measured on the real lists: a one-letter change in a short first name
  // ("eric"/"erik", 0.88) is below the per-word threshold the plan set. A
  // known gap, documented in docs/04 §5.1h for the owner to weigh.
  it('KNOWN GAP: a one-letter change in a 4-letter word is not caught at 0.92', () => {
    expect(jaroWinkler('eric', 'erik')).toBeLessThan(0.92);
    expect(matchNames('Erik Badege', 'Eric Badege')).toBeNull();
  });

  it('names with no letters match nothing', () => {
    expect(matchNames('123', 'ABBAS, Abu')).toBeNull();
    expect(matchNames('Abu Abbas', '---')).toBeNull();
  });
});

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, CRLF, and -0- as empty', () => {
    expect(parseCsv('1,"a, b","say ""hi""",-0- \r\n2,x,,y\n\n')).toEqual([
      ['1', 'a, b', 'say "hi"', ''],
      ['2', 'x', '', 'y'],
    ]);
  });
});

describe('parseOfac', () => {
  const list = parseOfac(SDN, ALT);
  const byRef = (r: string) => list.find((e) => e.ref === r)!;

  it('reads entries, their kind, both name orders for individuals, and aliases', () => {
    expect(list).toHaveLength(4);
    expect(byRef('36')).toMatchObject({kind: 'entity', names: ['AEROCARIBBEAN AIRLINES', 'AERO-CARIBBEAN']});
    expect(byRef('2674')).toMatchObject({
      kind: 'individual',
      names: ['ABBAS, Abu', 'Abu ABBAS', 'ZAYDAN, Muhammad', 'Muhammad ZAYDAN'],
    });
    expect(byRef('9002').kind).toBe('other');
  });

  it('reads digital currency addresses from the remarks, by ticker', () => {
    expect(byRef('9001').addresses).toEqual([
      {ticker: 'XBT', address: '1AbcDEF'},
      {ticker: 'ETH', address: '0xdeadBEEF'},
      {ticker: 'ETH', address: '0x1234'},
    ]);
    expect(byRef('2674').addresses).toBeUndefined();
  });

  it('ignores an alias for an entry that is not there', () => {
    expect(list.some((e) => e.names.includes('ORPHAN'))).toBe(false);
  });
});

describe('parseUn', () => {
  const list = parseUn(UN);
  it('joins the name parts, reads aliases (decoding entities), skips empty aliases and entries without an id', () => {
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({source: 'un', ref: '6907993', kind: 'individual', names: ['ERIC BADEGE']});
    expect(list[1]!.names).toEqual(['FRANK KAKOLELE BWAMBALE', 'FRANK KAKORERE', "O'BRIEN & SONS"]);
    expect(list[2]).toMatchObject({kind: 'entity', names: ['ADF']});
  });
});

describe('screenName', () => {
  const all = [...parseOfac(SDN, ALT), ...parseUn(UN)];

  it('finds a person on every list they are on, strongest first, and only individuals by default', () => {
    const hits = screenName('Muhammad Zaydan', all);
    expect(hits.map((h) => `${h.entry.source}:${h.entry.ref}`)).toEqual(['ofac:2674']);
    expect(screenName('Eric Badege', all).map((h) => h.entry.source)).toEqual(['un']);
    expect(screenName('Aerocaribbean Airlines', all)).toEqual([]);
    expect(screenName('Aerocaribbean Airlines', all, {kinds: ['entity']})).toHaveLength(1);
  });

  it('a clean name has no hits', () => {
    expect(screenName('Priya Sharma', all)).toEqual([]);
  });
});

describe('refreshDecision', () => {
  const active = {sha256: 'a'.repeat(64), entries: 19_000};
  it('skips an unchanged copy', () => {
    expect(refreshDecision('ofac', {sha256: 'a'.repeat(64), entries: 19_000}, active).action).toBe('skip');
  });
  it('refuses a copy below the minimum, or below 70% of the active one, keeping the old', () => {
    expect(refreshDecision('ofac', {sha256: 'b'.repeat(64), entries: 4999}, null)).toMatchObject({
      action: 'refuse',
    });
    const shrunk = refreshDecision('ofac', {sha256: 'b'.repeat(64), entries: 13_299}, active);
    expect(shrunk).toMatchObject({action: 'refuse'});
    expect(refreshDecision('ofac', {sha256: 'b'.repeat(64), entries: 13_300}, active).action).toBe('replace');
  });
  it('takes a first copy that is big enough', () => {
    expect(refreshDecision('un', {sha256: sha256Text('x'), entries: 1007}, null)).toEqual({
      action: 'replace',
      entries: 1007,
    });
  });
});
