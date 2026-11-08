import {describe, expect, it} from 'vitest';
import {crc32} from 'node:zlib';
import {cleanImage, detectImage} from '../src/images.js';
import {GPS_MARK, JPEG_SCAN, exifWithGps, jpeg, png, webp} from './helpers/images.js';

/**
 * Evidence photos lose their metadata before they are stored (docs/26 F6):
 * the GPS position a phone writes into EXIF is the obvious leak, but XMP,
 * comments, PNG text chunks and bytes after the image end can carry the
 * same, so the containers are rebuilt from an allow-list.
 */

const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, 'latin1'));

describe('detectImage', () => {
  it('reads the type from the first bytes only', () => {
    expect(detectImage(png())).toBe('image/png');
    expect(detectImage(jpeg())).toBe('image/jpeg');
    expect(detectImage(webp())).toBe('image/webp');
    expect(detectImage(Buffer.from('GIF89a\x01\0\x01\0', 'latin1'))).toBeNull();
    expect(detectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImage(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(detectImage(Buffer.alloc(0))).toBeNull();
  });

  it('refuses anything else with 422, whatever it claims to be', () => {
    expect(() => cleanImage(Buffer.from('GIF89a', 'latin1'))).toThrow(/not a PNG, JPEG or WebP/);
  });
});

describe('cleanImage: PNG', () => {
  it('drops eXIf, tEXt and trailing bytes, keeps the pixels and colour chunks', () => {
    const dirty = png({exif: true, text: true, trailing: true});
    expect(has(dirty, GPS_MARK)).toBe(true);
    const out = cleanImage(dirty);
    expect(out.mime).toBe('image/png');
    expect(has(out.bytes, GPS_MARK)).toBe(false);
    expect(has(out.bytes, 'eXIf')).toBe(false);
    expect(out.removed).toEqual(expect.arrayContaining(['eXIf', 'tEXt', 'trailing data']));
    // What is left is exactly the clean image.
    expect(Buffer.from(out.bytes).equals(png())).toBe(true);
  });

  it('refuses a chunk whose CRC does not match, a missing IEND, and an unknown critical chunk', () => {
    const bad = Buffer.from(png());
    bad[bad.length - 1]! ^= 0xff; // IEND's CRC
    expect(() => cleanImage(bad)).toThrow(/malformed/);
    const noEnd = png().subarray(0, png().length - 12);
    expect(() => cleanImage(noEnd)).toThrow(/malformed/);
    const t = Buffer.from('ABCD', 'latin1');
    const crit = Buffer.concat([Buffer.alloc(4), t, Buffer.alloc(4)]);
    crit.writeUInt32BE(crc32(t), 8);
    const p = png();
    const withCrit = Buffer.concat([p.subarray(0, 33), crit, p.subarray(33)]);
    expect(() => cleanImage(withCrit)).toThrow(/malformed/);
  });
});

describe('cleanImage: JPEG', () => {
  it('removes EXIF (with its GPS IFD), XMP, comments and post-EOI bytes, and copies the scan untouched', () => {
    const dirty = jpeg({exif: true, xmp: true, comment: true, trailing: true});
    expect(has(dirty, GPS_MARK)).toBe(true);
    expect(has(dirty, 'Exif\0\0')).toBe(true);
    const out = cleanImage(dirty);
    expect(out.mime).toBe('image/jpeg');
    expect(has(out.bytes, GPS_MARK)).toBe(false);
    expect(has(out.bytes, 'Exif')).toBe(false);
    // The GPS IFD pointer tag (0x8825, little endian) is gone with it.
    expect(Buffer.from(out.bytes).includes(Buffer.from([0x25, 0x88]))).toBe(false);
    expect(out.removed).toEqual(expect.arrayContaining(['EXIF', 'XMP/APP1', 'COM', 'trailing data']));
    expect(Buffer.from(out.bytes).equals(jpeg())).toBe(true);
    expect(Buffer.from(out.bytes).includes(JPEG_SCAN)).toBe(true);
  });

  it('refuses a JPEG with no EOI or a segment running past the end', () => {
    const j = jpeg();
    expect(() => cleanImage(j.subarray(0, j.length - 2))).toThrow(/malformed/);
    expect(() => cleanImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x40, 0x00, 1, 2]))).toThrow(/malformed/);
  });
});

describe('cleanImage: WebP', () => {
  it('removes EXIF and XMP chunks and clears their VP8X flags', () => {
    const dirty = webp({exif: true, xmp: true});
    const out = cleanImage(dirty);
    expect(out.mime).toBe('image/webp');
    expect(has(out.bytes, GPS_MARK)).toBe(false);
    expect(out.removed).toEqual(['EXIF', 'XMP']);
    expect(Buffer.from(out.bytes).equals(webp())).toBe(true);
    // RIFF size is the file length less 8.
    expect(Buffer.from(out.bytes).readUInt32LE(4)).toBe(out.bytes.length - 8);
  });

  it('refuses a WebP with no image chunk or a RIFF size past the end', () => {
    const noImage = Buffer.concat([Buffer.from('RIFF\x04\0\0\0WEBP', 'latin1')]);
    expect(() => cleanImage(noImage)).toThrow(/malformed/);
    const w = Buffer.from(webp());
    w.writeUInt32LE(w.length * 2, 4);
    expect(() => cleanImage(w)).toThrow(/malformed/);
  });
});

it('the EXIF fixture really carries a GPS IFD', () => {
  const e = exifWithGps();
  expect(e.subarray(0, 6).toString('latin1')).toBe('Exif\0\0');
  expect(e.includes(Buffer.from([0x25, 0x88]))).toBe(true);
});
