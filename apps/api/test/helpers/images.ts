import {crc32, deflateSync} from 'node:zlib';

/**
 * Small, structurally valid images for the evidence tests, built byte by
 * byte so each test knows exactly which metadata it carries: a GPS position
 * in EXIF, a text comment, an XMP packet. The "photos" are 1×1 pixels.
 */

const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u16be = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** The GPS position every fixture hides: 52°31'N 13°24'E (Berlin). */
export const GPS_MARK = 'GPS-52.5200N-13.4050E';

/**
 * A little-endian TIFF/EXIF block with an IFD0 whose only entry is the GPS
 * IFD pointer (tag 0x8825), and a GPS IFD holding GPSLatitudeRef 'N' and an
 * ASCII GPSAreaInformation carrying GPS_MARK.
 */
export function exifWithGps(): Buffer {
  const mark = Buffer.from(`${GPS_MARK}\0`, 'latin1');
  // Offsets are from the TIFF header start.
  const ifd0At = 8;
  const gpsAt = ifd0At + 2 + 12 + 4; // one entry + next-IFD
  const dataAt = gpsAt + 2 + 2 * 12 + 4; // two entries + next-IFD
  const entry = (tag: number, type: number, count: number, value: Buffer) =>
    Buffer.concat([Buffer.from([tag & 0xff, tag >> 8, type & 0xff, type >> 8]), u32le(count), value]);
  const tiff = Buffer.concat([
    Buffer.from('II*\0', 'latin1'),
    u32le(ifd0At),
    Buffer.from([1, 0]),
    entry(0x8825, 4, 1, u32le(gpsAt)),
    u32le(0),
    Buffer.from([2, 0]),
    entry(0x0001, 2, 2, Buffer.from('N\0\0\0', 'latin1')),
    entry(0x001c, 2, mark.length, u32le(dataAt)),
    u32le(0),
    mark,
  ]);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'latin1');
  return Buffer.concat([u32be(data.length), t, data, u32be(crc32(Buffer.concat([t, data])))]);
}

/** A 1×1 RGBA PNG. `idatPad` adds that many bytes of IDAT payload (to reach an exact size). */
export function png(
  opts: {exif?: boolean; text?: boolean; idatPad?: number; trailing?: boolean} = {},
): Buffer {
  const ihdr = Buffer.concat([u32be(1), u32be(1), Buffer.from([8, 6, 0, 0, 0])]);
  const pixels = deflateSync(Buffer.from([0, 200, 30, 30, 255]));
  const parts: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('sRGB', Buffer.from([0])),
  ];
  if (opts.text) parts.push(pngChunk('tEXt', Buffer.from(`Comment\0taken at ${GPS_MARK}`, 'latin1')));
  if (opts.exif) parts.push(pngChunk('eXIf', exifWithGps().subarray(6)));
  parts.push(pngChunk('IDAT', pixels));
  if (opts.idatPad) parts.push(pngChunk('IDAT', Buffer.alloc(opts.idatPad, 7)));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  if (opts.trailing) parts.push(Buffer.from(`trailer ${GPS_MARK}`, 'latin1'));
  return Buffer.concat(parts);
}

/** A PNG of exactly `size` bytes (padding in a second IDAT chunk). */
export function pngOfSize(size: number): Buffer {
  const base = png().length + 12; // the padding chunk's own framing
  return png({idatPad: size - base});
}

function jpegSegment(marker: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker]), u16be(body.length + 2), body]);
}

/** The scan's entropy-coded bytes, including a stuffed 0xFF00 and a restart marker. */
export const JPEG_SCAN = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);

/**
 * A baseline JPEG's structure: JFIF APP0, an EXIF APP1 with a GPS IFD, an
 * XMP APP1, a comment, the tables, one scan and EOI. (The tables are not a
 * decodable image; the stripper copies them without decoding.)
 */
export function jpeg(
  opts: {exif?: boolean; xmp?: boolean; comment?: boolean; trailing?: boolean} = {},
): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  parts.push(jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')));
  if (opts.exif) parts.push(jpegSegment(0xe1, exifWithGps()));
  if (opts.xmp) {
    parts.push(
      jpegSegment(
        0xe1,
        Buffer.from(
          `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPS>${GPS_MARK}</exif:GPS></x:xmpmeta>`,
          'latin1',
        ),
      ),
    );
  }
  if (opts.comment) parts.push(jpegSegment(0xfe, Buffer.from(`shot at ${GPS_MARK}`, 'latin1')));
  parts.push(jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])));
  parts.push(jpegSegment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])));
  parts.push(jpegSegment(0xc4, Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0), Buffer.from([0])])));
  parts.push(jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])));
  parts.push(JPEG_SCAN);
  parts.push(Buffer.from([0xff, 0xd9]));
  if (opts.trailing) parts.push(Buffer.from(`after EOI ${GPS_MARK}`, 'latin1'));
  return Buffer.concat(parts);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(type, 'latin1'), u32le(data.length), data, pad]);
}

/** A WebP (VP8X + a lossless VP8L payload) with optional EXIF and XMP chunks announced in its flags. */
export function webp(opts: {exif?: boolean; xmp?: boolean} = {}): Buffer {
  const flags = (opts.exif ? 0x08 : 0) | (opts.xmp ? 0x04 : 0);
  const vp8x = Buffer.concat([Buffer.from([flags, 0, 0, 0]), Buffer.from([0, 0, 0, 0, 0, 0])]);
  const chunks: Buffer[] = [
    riffChunk('VP8X', vp8x),
    riffChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0x10, 0x07, 0x10])),
  ];
  if (opts.exif) chunks.push(riffChunk('EXIF', exifWithGps().subarray(6)));
  if (opts.xmp) chunks.push(riffChunk('XMP ', Buffer.from(`<x:xmpmeta>${GPS_MARK}</x:xmpmeta>`, 'latin1')));
  const body = Buffer.concat(chunks);
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    u32le(4 + body.length),
    Buffer.from('WEBP', 'latin1'),
    body,
  ]);
}

/** A multipart/form-data body with one file part, as a browser's FormData sends it. */
export function multipart(
  bytes: Buffer,
  opts: {filename?: string; contentType?: string; field?: string} = {},
): {payload: Buffer; headers: Record<string, string>} {
  const boundary = `----pactora${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${opts.field ?? 'file'}"; filename="${opts.filename ?? 'photo.png'}"\r\n` +
      `Content-Type: ${opts.contentType ?? 'image/png'}\r\n\r\n`,
    'latin1',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1');
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: {'content-type': `multipart/form-data; boundary=${boundary}`},
  };
}
