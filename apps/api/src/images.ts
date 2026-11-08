import {crc32} from 'node:zlib';
import {ErrorCode, PactoraError} from '@pactora/shared';

/**
 * Evidence photos (docs/26 F6): what a file IS is read from its first bytes,
 * never from the name or the Content-Type the client sent, and its metadata
 * is removed before a byte is stored.
 *
 * Metadata is where a phone photo carries the place it was taken (EXIF GPS),
 * the device's serial number and the owner's name. None of it is needed to
 * judge the work, and every photo is shown to the other party and, in a
 * dispute, to the arbiter. So it goes — by rewriting the container with an
 * allow-list of the parts an image needs to be drawn, which drops EXIF, XMP,
 * IPTC, comments and anything unknown, rather than by hunting for the GPS
 * tag and hoping nothing else was there.
 *
 * Hand-written, not `sharp`: ~250 lines of container parsing with no native
 * code and no dependency, which keeps `pnpm audit --prod` clean and makes
 * the whole thing readable in one sitting. The pixels are copied untouched
 * (no re-encode, no quality loss); a file whose structure does not parse is
 * refused, not passed through.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface CleanImage {
  mime: ImageMime;
  /** The file extension for that type. */
  ext: 'png' | 'jpg' | 'webp';
  /** The bytes to store: the image with its metadata removed. */
  bytes: Uint8Array;
  /** What was taken out, by name (EXIF, XMP, tEXt…), for the log. */
  removed: string[];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The type the bytes say they are, or null for anything that is not one of the three. */
export function detectImage(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    return 'image/webp';
  return null;
}

/** Detect, then strip. Refuses (422) anything that is not a well-formed PNG, JPEG or WebP. */
export function cleanImage(bytes: Uint8Array): CleanImage {
  const mime = detectImage(bytes);
  if (!mime) {
    throw new PactoraError(
      ErrorCode.SCHEMA_MISMATCH,
      'not a PNG, JPEG or WebP image (the type is read from the file itself, not its name or Content-Type)',
    );
  }
  switch (mime) {
    case 'image/png':
      return {mime, ext: 'png', ...stripPng(bytes)};
    case 'image/jpeg':
      return {mime, ext: 'jpg', ...stripJpeg(bytes)};
    case 'image/webp':
      return {mime, ext: 'webp', ...stripWebp(bytes)};
  }
}

function malformed(what: string): never {
  throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, `the ${what} is malformed and was not stored`);
}

function ascii(b: Uint8Array, at: number, n: number): string {
  return String.fromCharCode(...b.subarray(at, at + n));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ─────────────────────────── PNG ───────────────────────────

/**
 * Ancillary chunks a PNG keeps: colour, transparency, density and animation.
 * Text (tEXt, zTXt, iTXt), eXIf, tIME and everything unknown are dropped.
 */
const PNG_KEEP = new Set([
  'tRNS',
  'cHRM',
  'gAMA',
  'sBIT',
  'sRGB',
  'iCCP',
  'cICP',
  'bKGD',
  'pHYs',
  'hIST',
  'sPLT',
  'acTL',
  'fcTL',
  'fdAT',
]);
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

function stripPng(b: Uint8Array): {bytes: Uint8Array; removed: string[]} {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const removed: string[] = [];
  let at = 8;
  let first = true;
  let ended = false;
  while (at < b.length) {
    if (at + 12 > b.length) malformed('PNG');
    const len = view.getUint32(at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + len;
    if (!/^[A-Za-z]{4}$/.test(type) || end > b.length) malformed('PNG');
    // The CRC covers type + data: a chunk that fails it is corrupt or forged.
    if (crc32(b.subarray(at + 4, at + 8 + len)) !== view.getUint32(at + 8 + len)) malformed('PNG');
    if (first && type !== 'IHDR') malformed('PNG');
    first = false;
    const critical = type.charCodeAt(0) < 0x61; // upper case first letter
    if (critical && !PNG_CRITICAL.has(type)) malformed('PNG');
    if (critical || PNG_KEEP.has(type)) parts.push(b.subarray(at, end));
    else removed.push(type);
    at = end;
    if (type === 'IEND') {
      ended = true;
      break; // anything after IEND is not part of the image
    }
  }
  if (!ended) malformed('PNG');
  if (at < b.length) removed.push('trailing data');
  return {bytes: concat(parts), removed};
}

// ─────────────────────────── JPEG ───────────────────────────

function stripJpeg(b: Uint8Array): {bytes: Uint8Array; removed: string[]} {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  const removed: string[] = [];
  let at = 2;
  let ended = false;
  while (at < b.length) {
    if (b[at] !== 0xff) malformed('JPEG');
    // Fill bytes: any number of 0xFF before a marker.
    let m = at + 1;
    while (m < b.length && b[m] === 0xff) m++;
    if (m >= b.length) malformed('JPEG');
    const marker = b[m]!;
    const start = m - 1;
    if (marker === 0xd9) {
      parts.push(b.subarray(start, m + 1));
      at = m + 1;
      ended = true;
      break; // EOI: whatever a camera appends after it is dropped
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xd8) {
      if (marker === 0xd8) malformed('JPEG'); // a second SOI
      parts.push(b.subarray(start, m + 1));
      at = m + 1;
      continue;
    }
    if (m + 3 > b.length) malformed('JPEG');
    const len = (b[m + 1]! << 8) | b[m + 2]!;
    const end = m + 1 + len;
    if (len < 2 || end > b.length) malformed('JPEG');
    const segment = b.subarray(start, end);
    const body = b.subarray(m + 3, end);
    if (keepJpegSegment(marker, body)) parts.push(segment);
    else removed.push(jpegName(marker, body));
    at = end;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data runs to the next real marker.
      // 0xFF00 is a stuffed byte and 0xFFD0-D7 a restart: both are data.
      let s = at;
      while (s < b.length) {
        if (b[s] === 0xff && s + 1 < b.length) {
          const next = b[s + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        s++;
      }
      parts.push(b.subarray(at, s));
      at = s;
    }
  }
  if (!ended) malformed('JPEG');
  if (at < b.length) removed.push('trailing data');
  return {bytes: concat(parts), removed};
}

/**
 * APP0 (JFIF), an ICC colour profile in APP2 and APP14 (Adobe colour
 * transform) are kept because they change how the pixels are drawn. Every
 * other APPn (APP1 is EXIF and XMP, APP13 is IPTC) and comments go.
 */
function keepJpegSegment(marker: number, body: Uint8Array): boolean {
  if (marker === 0xfe) return false; // COM
  if (marker >= 0xe0 && marker <= 0xef) {
    if (marker === 0xe0) return ascii(body, 0, 5) === 'JFIF\0' || ascii(body, 0, 5) === 'JFXX\0';
    if (marker === 0xe2) return ascii(body, 0, 12) === 'ICC_PROFILE\0';
    if (marker === 0xee) return ascii(body, 0, 5) === 'Adobe';
    return false;
  }
  return true; // SOFn, DHT, DQT, DRI, SOS, DNL…: the image itself
}

function jpegName(marker: number, body: Uint8Array): string {
  if (marker === 0xfe) return 'COM';
  if (marker === 0xe1) return ascii(body, 0, 4) === 'Exif' ? 'EXIF' : 'XMP/APP1';
  if (marker === 0xed) return 'IPTC/APP13';
  return `APP${marker - 0xe0}`;
}

// ─────────────────────────── WebP ───────────────────────────

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function stripWebp(b: Uint8Array): {bytes: Uint8Array; removed: string[]} {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riffSize = view.getUint32(4, true);
  const total = 8 + riffSize;
  if (total > b.length || riffSize < 4) malformed('WebP');
  const parts: Uint8Array[] = [];
  const removed: string[] = [];
  let at = 12;
  let vp8x: Uint8Array | null = null;
  let image = false;
  while (at < total) {
    if (at + 8 > total) malformed('WebP');
    const type = ascii(b, at, 4);
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > total) malformed('WebP');
    // Chunks are padded to an even length (a final odd one may omit it).
    const end = Math.min(at + 8 + size + (size % 2), total);
    const chunk = b.slice(at, end);
    if (WEBP_KEEP.has(type)) {
      if (type === 'VP8X') {
        if (size < 10) malformed('WebP');
        vp8x = chunk;
      }
      if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') image = true;
      parts.push(chunk);
    } else {
      removed.push(type.trim());
    }
    at = end;
  }
  if (!image) malformed('WebP');
  // VP8X announces which optional chunks follow: clear the EXIF (bit 3) and
  // XMP (bit 2) flags, so no reader goes looking for what was removed.
  if (vp8x) vp8x[8] = vp8x[8]! & ~0x0c;
  const body = concat(parts);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 4), 0);
  new DataView(header.buffer).setUint32(4, 4 + body.length, true);
  header.set(b.subarray(8, 12), 8);
  if (total < b.length) removed.push('trailing data');
  return {bytes: concat([header, body]), removed};
}
