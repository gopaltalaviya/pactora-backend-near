import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  checkTarget,
  isPublicAddress,
  open,
  parseSecretKey,
  postPinned,
  seal,
  UnsafeTargetError,
  type Resolver,
} from '../src/index.js';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped
    '::ffff:7f00:1', // the same, in hex
    '::ffff:a9fe:a9fe', // 169.254.169.254, mapped
    '64:ff9b::10.0.0.1', // NAT64 to a private address
    '2001:db8::1',
    'not-an-ip',
  ])('refuses %s', (a) => {
    expect(isPublicAddress(a)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::8.8.8.8',
  ])('allows %s', (a) => {
    expect(isPublicAddress(a)).toBe(true);
  });
});

const resolving =
  (table: Record<string, string[]>): Resolver =>
  async (host) => {
    const addrs = table[host];
    if (!addrs) throw new Error('ENOTFOUND');
    return addrs.map((address) => ({address, family: address.includes(':') ? 6 : 4}));
  };

describe('checkTarget', () => {
  const resolver = resolving({
    'hooks.example.com': ['93.184.216.34'],
    'sneaky.example.com': ['93.184.216.34', '10.0.0.5'],
    'internal.example.com': ['169.254.169.254'],
    'v6.example.com': ['::ffff:127.0.0.1'],
  });

  it('accepts a public https name and pins its address', async () => {
    const t = await checkTarget('https://hooks.example.com/pactora?x=1', {resolver});
    expect(t.address).toBe('93.184.216.34');
    expect(t.url.pathname).toBe('/pactora');
  });

  it.each([
    ['http://hooks.example.com/', /https/],
    ['ftp://hooks.example.com/', /https/],
    ['https://user:pw@hooks.example.com/', /credentials/],
    ['https://sneaky.example.com/', /non-public.*10\.0\.0\.5/], // one bad address is enough
    ['https://internal.example.com/', /non-public/],
    ['https://v6.example.com/', /non-public/],
    ['https://127.0.0.1/', /non-public/],
    ['https://[::1]/', /non-public/],
    ['https://2130706433/', /non-public/], // 127.0.0.1 as a decimal integer, normalised by URL
    ['https://0x7f.1/', /non-public/],
    ['https://nowhere.example.com/', /does not resolve/],
    ['not a url', /not a URL/],
  ])('refuses %s', async (raw, why) => {
    await expect(checkTarget(raw, {resolver})).rejects.toThrow(UnsafeTargetError);
    await expect(checkTarget(raw, {resolver})).rejects.toThrow(why);
  });

  it('allows http and private only when the policy says so (local development)', async () => {
    const t = await checkTarget('http://127.0.0.1:9/x', {allowHttp: true, allowPrivate: true});
    expect(t.address).toBe('127.0.0.1');
  });
});

describe('postPinned', () => {
  let server: Server;
  let port: number;
  const seen: {headers: Record<string, unknown>; body: string; url: string}[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({headers: req.headers, body, url: req.url ?? ''});
        if (req.url === '/redirect') {
          res.writeHead(302, {location: 'http://169.254.169.254/latest/meta-data'});
          return res.end();
        }
        if (req.url === '/slow') return; // never answers
        if (req.url === '/big') return res.end('x'.repeat(100_000));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // The name resolves to a public address at check time; the pin must win over a rebind.
  it('connects to the pinned address, whatever the name resolves to at connect time', async () => {
    const target = await checkTarget(`http://rebind.test:${port}/hook`, {
      allowHttp: true,
      allowPrivate: true,
      resolver: resolving({'rebind.test': ['127.0.0.1']}),
    });
    // rebind.test does not exist in real DNS: reaching the server proves the pin was used.
    const res = await postPinned(target, '{"a":1}', {'content-type': 'application/json', 'x-test': 'yes'});
    expect(res.status).toBe(204);
    const last = seen.at(-1)!;
    expect(last.body).toBe('{"a":1}');
    expect(last.headers['x-test']).toBe('yes');
    expect(last.headers['host']).toBe(`rebind.test:${port}`);
  });

  it('does not follow a redirect', async () => {
    const target = await checkTarget(`http://127.0.0.1:${port}/redirect`, {
      allowHttp: true,
      allowPrivate: true,
    });
    const before = seen.length;
    const res = await postPinned(target, '{}', {});
    expect(res.status).toBe(302);
    expect(seen.length).toBe(before + 1);
  });

  it('times out a silent endpoint', async () => {
    const target = await checkTarget(`http://127.0.0.1:${port}/slow`, {allowHttp: true, allowPrivate: true});
    await expect(postPinned(target, '{}', {}, {timeoutMs: 300})).rejects.toThrow(/timed out/);
  });

  it('keeps at most maxBodyBytes of the answer', async () => {
    const target = await checkTarget(`http://127.0.0.1:${port}/big`, {allowHttp: true, allowPrivate: true});
    const res = await postPinned(target, '{}', {}, {maxBodyBytes: 100});
    expect(res.body).toHaveLength(100);
  });
});

describe('secretbox', () => {
  const key = parseSecretKey('ab'.repeat(32));

  it('round-trips, with a fresh IV each time', () => {
    const a = seal(key, 'whsec_abc', 'hook-1');
    const b = seal(key, 'whsec_abc', 'hook-1');
    expect(a).not.toBe(b);
    expect(open(key, a, 'hook-1')).toBe('whsec_abc');
  });

  it('refuses another key, another row, a changed byte, or another format', () => {
    const sealed = seal(key, 'whsec_abc', 'hook-1');
    expect(() => open(parseSecretKey('cd'.repeat(32)), sealed, 'hook-1')).toThrow();
    expect(() => open(key, sealed, 'hook-2')).toThrow();
    const parts = sealed.split('.');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    expect(() => open(key, [...parts.slice(0, 3), ct.toString('base64url')].join('.'), 'hook-1')).toThrow();
    expect(() => open(key, 'v0.a.b.c')).toThrow(/not a sealed secret/);
  });

  it('takes a key as 64 hex or 44 base64 characters, and nothing weaker', () => {
    expect(parseSecretKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
    expect(parseSecretKey(Buffer.alloc(32, 7).toString('base64url'))).toHaveLength(32);
    for (const bad of [
      '',
      'short',
      'ab'.repeat(31),
      'zz'.repeat(32),
      'a passphrase that is long enough to look ok',
    ])
      expect(() => parseSecretKey(bad)).toThrow(/32 random bytes/);
  });
});
