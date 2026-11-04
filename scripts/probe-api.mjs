#!/usr/bin/env node
/**
 * Hostile HTTP against a running Pactora API. Nothing it sends can spend:
 * every write is one the API must refuse (bad body, bad key, bad id).
 *
 *   node scripts/probe-api.mjs http://127.0.0.1:8080
 *
 * Optional, for the checks that need a known setup:
 *   PROBE_RUN_ID=<uuid>        a run whose live stream can be opened (the stream cap)
 *   PROBE_MAX_STREAMS=<n>      the API's SSE_MAX_STREAMS — opens n, expects the next to get 503
 *   PROBE_RATE_LIMIT=<n>       the API's RATE_LIMIT_PER_MINUTE — runs LAST, expects 429 past it
 *   PROBE_ALLOWED_ORIGIN=<url> an origin in CORS_ORIGINS (default http://localhost:3300)
 *
 * What it asserts, for every request:
 *   - never a 5xx unless the check expects one (a 500 is a bug, always);
 *   - every error is RFC 7807 (`application/problem+json`, `status`, `code`);
 *   - no response leaks a stack trace, a filesystem path, a connection string
 *     or an internal hostname.
 *
 * Exit 0 when every check passes; 1 otherwise.
 */

const [apiArg] = process.argv.slice(2);
if (!apiArg) {
  console.error('usage: node scripts/probe-api.mjs <API_URL>');
  process.exit(2);
}
const API = apiArg.replace(/\/$/, '');
const RUN_ID = process.env.PROBE_RUN_ID;
const MAX_STREAMS = Number(process.env.PROBE_MAX_STREAMS ?? 0);
const RATE_LIMIT = Number(process.env.PROBE_RATE_LIMIT ?? 0);
const ALLOWED_ORIGIN = process.env.PROBE_ALLOWED_ORIGIN ?? 'http://localhost:3300';

let failed = 0;
let requests = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  failed++;
  console.log(`  ✗ ${m}`);
};
const section = (m) => console.log(`\n${m}`);

/** Anything here in a response body means something internal escaped. */
const LEAKS = [
  [/\bat [\w.<>]+ \(?[\w:/\\.-]+:\d+:\d+\)?/, 'a stack frame'],
  [/[A-Z]:\\[\w\\]+|\/(?:app|home|usr|opt|srv)\/[\w/]+\.(?:m?js|ts)/, 'a filesystem path'],
  [/postgres(?:ql)?:\/\/|redis:\/\//i, 'a connection string'],
  [/\b(?:ECONNREFUSED|ENOTFOUND)\b[^"]*\d+\.\d+\.\d+\.\d+/, 'an internal address'],
  // `<secret>` is the key-format hint (ax_<id>_<secret>), not a value.
  [/password|(?<!<)secret(?!>)|private[_ ]?key/i, 'a secret-looking word'],
];

async function call(path, init = {}) {
  requests++;
  try {
    const res = await fetch(`${API}${path}`, {...init, signal: init.signal ?? AbortSignal.timeout(15_000)});
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return {res, text, json};
  } catch (err) {
    return {error: err.cause?.code ?? err.message};
  }
}

/**
 * One hostile request: the status must be one of `expect`, an error must be a
 * problem document (with `code` when given), and nothing may leak.
 */
async function probe(label, path, init, expect, code) {
  const r = await call(path, init);
  if (r.error) return bad(`${label}: no answer (${r.error})`);
  const {res, text, json} = r;
  const want = Array.isArray(expect) ? expect : [expect];
  const problems = [];
  if (!want.includes(res.status)) problems.push(`status ${res.status}, wanted ${want.join('/')}`);
  // /health and /ready answer with their own {ok, checks} document, read by load balancers.
  if (res.status >= 400 && !/^\/(health|ready)$/.test(path)) {
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/problem+json')) problems.push(`content-type "${type}"`);
    if (!json || typeof json.code !== 'string' || json.status !== res.status) problems.push('not RFC 7807');
    if (code && json?.code !== code) problems.push(`code ${json?.code}, wanted ${code}`);
  }
  for (const [re, what] of LEAKS) if (re.test(text)) problems.push(`leaks ${what}: ${text.match(re)[0]}`);
  if (problems.length) bad(`${label} → ${problems.join('; ')}`);
  else ok(`${label} → ${res.status}${json?.code ? ` ${json.code}` : ''}`);
  return r;
}

const JSON_HEADERS = {'content-type': 'application/json'};
const post = (body, headers = JSON_HEADERS) => ({method: 'POST', headers, body});
const authed = (key) => ({...JSON_HEADERS, authorization: key});
const validRegister = {
  name: 'probe',
  description: 'probe',
  capabilities: ['research'],
  endpointUrl: 'https://example.com/a2a',
  priceBaseUnits: '1000',
};

// ── 1. Health surfaces must not leak ───────────────────────────────────────
section('Health and status: answer, and leak nothing');
await probe('GET /health', '/health', {}, 200);
await probe('GET /ready', '/ready', {}, [200, 503]);
await probe('GET /v1/status', '/v1/status', {}, [200, 503]);
await probe('GET /v1/network', '/v1/network', {}, 200);

// ── 2. Bodies the parser must refuse ────────────────────────────────────────
section('Malformed bodies: 4xx, never 500');
await probe('malformed JSON', '/v1/agents', post('{"name": "x",'), 400, 'FST_ERR_CTP_INVALID_JSON_BODY');
await probe('empty JSON body', '/v1/agents', post(''), 400);
await probe('JSON null', '/v1/agents', post('null'), [400, 422]);
await probe('JSON array', '/v1/agents', post('[1,2,3]'), [400, 422]);
await probe('a bare string', '/v1/agents', post('"hello"'), [400, 422]);
await probe('text/plain body', '/v1/agents', post('name=x', {'content-type': 'text/plain'}), [415, 422]);
await probe(
  'form-encoded body',
  '/v1/agents',
  post('name=x', {'content-type': 'application/x-www-form-urlencoded'}),
  415,
);
await probe('2 MB body', '/v1/agents', post(JSON.stringify({name: 'x'.repeat(2_000_000)})), 413);
await probe('deeply nested JSON', '/v1/agents', post('['.repeat(5000) + ']'.repeat(5000)), [400, 413, 422]);
await probe(
  '__proto__ pollution',
  '/v1/agents',
  post('{"__proto__":{"admin":true},"name":"x"}'),
  [400, 401, 422],
);

// ── 3. Hostile field values ─────────────────────────────────────────────────
section('Hostile field values: refused by validation (422), never stored, never 500');
const INVALID_PRICES = ['-1', '1.5', '1e18', '0x10', '1'.repeat(40), '', ' 1', 'NaN', '٣'];
for (const p of INVALID_PRICES) {
  await probe(
    `price ${JSON.stringify(p)}`,
    '/v1/agents',
    post(JSON.stringify({...validRegister, priceBaseUnits: p})),
    [401, 422],
  );
}
const HOSTILE_TEXT = [
  "'; DROP TABLE agents; --",
  "' OR '1'='1",
  '\u0000nul byte',
  '\ud800 lone surrogate',
  '‮RTL override',
  '<script>alert(1)</script>',
  '😀'.repeat(100),
];
for (const t of HOSTILE_TEXT) {
  // Over-long description so validation must refuse it whatever the name: an invalid write only.
  await probe(
    `name ${JSON.stringify(t).slice(0, 30)}`,
    '/v1/agents',
    post(JSON.stringify({...validRegister, name: t, description: 'x'.repeat(1001)})),
    [401, 422],
  );
}
await probe(
  '65-char name',
  '/v1/agents',
  post(JSON.stringify({...validRegister, name: 'n'.repeat(65)})),
  [401, 422],
);
await probe(
  '17 capabilities',
  '/v1/agents',
  post(JSON.stringify({...validRegister, capabilities: Array(17).fill('a')})),
  [401, 422],
);
await probe(
  'endpoint javascript:',
  '/v1/agents',
  post(JSON.stringify({...validRegister, endpointUrl: 'javascript:alert(1)', description: 'x'.repeat(1001)})),
  [401, 422],
);

// ── 4. Query strings ────────────────────────────────────────────────────────
section('Query strings: validated, never reach Postgres raw');
await probe(
  'capability SQL injection',
  `/v1/agents?capability=${encodeURIComponent("x' OR 1=1--")}`,
  {},
  [200, 422],
);
await probe('limit=abc', '/v1/agents?limit=abc', {}, 422, 'SCHEMA_MISMATCH');
await probe('limit=-1', '/v1/agents?limit=-1', {}, 422);
await probe('limit=1e309', '/v1/agents?limit=1e309', {}, 422);
await probe('minScore=999', '/v1/agents?minScore=999', {}, 422);
await probe('rank=../../etc', '/v1/agents?rank=../../etc', {}, 422);
await probe('maxPrice=-5', '/v1/agents?maxPrice=-5', {}, 422);
await probe('chainId=1 (not enabled)', '/v1/agents?chainId=1', {}, [400, 404, 422]);
await probe('repeated param', '/v1/agents?limit=1&limit=2', {}, [200, 422]);
await probe('invalid UTF-8 %FF', '/v1/agents?capability=%FF', {}, [200, 400, 422]);
await probe('emoji capability', `/v1/agents?capability=${encodeURIComponent('🤖')}`, {}, [200, 422]);
await probe('10 KB query string', `/v1/agents?capability=${'a'.repeat(10_000)}`, {}, [414, 422, 431]);

// ── 5. Ids and paths ────────────────────────────────────────────────────────
section('Ids and paths: unknown or malformed ids are 4xx, never 500');
for (const id of [
  'abc',
  '-1',
  '0',
  '1.5',
  '99999999999999999999999',
  '1e3',
  '%00',
  '..%2F..%2Fetc%2Fpasswd',
  "1'--",
]) {
  await probe(`GET /v1/agents/${id}`, `/v1/agents/${id}`, {}, [400, 404, 422]);
}
for (const id of ['1', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', '..%2F..%2Fetc', '%E2%80%AE']) {
  await probe(`GET /v1/runs/${id}`, `/v1/runs/${id}`, {}, 404, 'NOT_FOUND');
  await probe(`GET /v1/jobs/${id}`, `/v1/jobs/${id}`, {}, [401, 404]);
}
await probe('serial job events', '/v1/jobs/1/events', {}, [401, 404]);
await probe('unknown route', '/v1/nope', {}, 404);
await probe('path traversal', '/../../etc/passwd', {}, 404);
await probe('DELETE an agent', '/v1/agents/1', {method: 'DELETE'}, [404, 405]);
await probe('PUT method', '/v1/agents', {method: 'PUT'}, [404, 405]);

// ── 6. Authentication ───────────────────────────────────────────────────────
section('Authentication: every bad key is 401, the same way');
const KEYS = {
  'no key': undefined,
  'empty Bearer': 'Bearer ',
  'garbage key': 'Bearer not-a-key',
  'right shape, wrong key': `Bearer agx_${'0'.repeat(48)}`,
  'Basic auth': `Basic ${Buffer.from('a:b').toString('base64')}`,
  'SQL in key': "Bearer ' OR '1'='1",
  'key with newline': 'Bearer abc%0d%0aX-Injected: 1',
  '8 KB key': `Bearer ${'k'.repeat(8_000)}`,
};
for (const [label, key] of Object.entries(KEYS)) {
  const headers = key === undefined ? JSON_HEADERS : authed(key);
  await probe(
    `POST /v1/runs, ${label}`,
    '/v1/runs',
    post(JSON.stringify({goal: 'probe'}), headers),
    [401, 431],
  );
}
await probe('GET /v1/runs, no key', '/v1/runs', {}, 401);
await probe('GET /v1/budget, no key', '/v1/budget', {}, 401);
await probe(
  'PATCH /v1/agents/1, no key',
  '/v1/agents/1',
  {method: 'PATCH', headers: JSON_HEADERS, body: '{}'},
  [401, 404],
);
await probe('x402 settle, junk', '/v1/x402/settle', post('{"payment":"junk"}'), [400, 401, 402, 422]);
await probe('x402 verify, junk', '/v1/x402/verify', post('{}'), [400, 401, 402, 422]);
await probe('x402 redeem, junk', '/v1/x402/redeem', post('{"token":"junk"}'), [400, 401, 402, 404, 422]);

// ── 7. CORS ─────────────────────────────────────────────────────────────────
section('CORS: the site is let in; a foreign origin is not; no credentials');
{
  const evil = await call('/v1/agents', {
    method: 'OPTIONS',
    headers: {origin: 'https://evil.example', 'access-control-request-method': 'POST'},
  });
  const allow = evil.res?.headers.get('access-control-allow-origin');
  if (allow === 'https://evil.example') bad('a foreign origin is echoed back as allowed');
  else
    ok(
      `foreign origin preflight → allow-origin ${allow ?? '(none)'}${allow === '*' ? ' (CORS_ORIGINS unset: bearer-only, no cookies)' : ''}`,
    );
  const site = await call('/v1/agents', {
    method: 'OPTIONS',
    headers: {origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST'},
  });
  const siteAllow = site.res?.headers.get('access-control-allow-origin');
  if (siteAllow === ALLOWED_ORIGIN || siteAllow === '*') ok(`${ALLOWED_ORIGIN} preflight → allowed`);
  else bad(`${ALLOWED_ORIGIN} preflight → allow-origin ${siteAllow}`);
  if (site.res?.headers.get('access-control-allow-credentials') === 'true') bad('credentials are allowed');
  else ok('credentials are never allowed');
}

// ── 8. Security headers ─────────────────────────────────────────────────────
section('Security headers on a JSON response');
{
  const {res} = await call('/v1/agents');
  for (const [h, want] of [
    ['content-security-policy', /default-src 'none'/],
    ['x-content-type-options', /nosniff/],
    ['x-frame-options', /./],
  ]) {
    const v = res?.headers.get(h);
    if (v && want.test(v)) ok(`${h}: ${v.slice(0, 50)}`);
    else bad(`${h} missing or wrong (${v})`);
  }
  if (res?.headers.get('x-powered-by')) bad(`x-powered-by is sent: ${res.headers.get('x-powered-by')}`);
  else ok('no x-powered-by');
}

// ── 9. The live-stream cap ──────────────────────────────────────────────────
if (RUN_ID && MAX_STREAMS > 0) {
  section(`Live streams: ${MAX_STREAMS} open, the next is refused (503), the server stays up`);
  const held = [];
  for (let i = 0; i < MAX_STREAMS; i++) {
    const ac = new AbortController();
    const res = await fetch(`${API}/v1/runs/${RUN_ID}/events`, {signal: ac.signal});
    held.push({ac, res});
    if (res.status !== 200) bad(`stream ${i + 1} → ${res.status}`);
  }
  ok(`${held.length} streams open`);
  await probe(`stream ${MAX_STREAMS + 1}`, `/v1/runs/${RUN_ID}/events`, {}, 503, 'UPSTREAM_UNAVAILABLE');
  {
    const {res} = await call(`/v1/runs/${RUN_ID}/events`, {signal: AbortSignal.timeout(5_000)});
    if (res?.headers.get('retry-after'))
      ok(`the refusal says when to retry (retry-after ${res.headers.get('retry-after')})`);
    else bad('the refusal has no retry-after');
  }
  await probe('the API still serves while streams are full', '/v1/agents', {}, 200);
  for (const h of held) h.ac.abort();
  await new Promise((r) => setTimeout(r, 500));
  const again = await fetch(`${API}/v1/runs/${RUN_ID}/events`, {signal: AbortSignal.timeout(3_000)}).catch(
    (e) => e,
  );
  if (again.status === 200) ok('closed streams free their slots: a new one opens');
  else bad(`after closing, a new stream → ${again.status ?? again.message}`);
  // Close it, or the process waits on an open stream. An error result has no body.
  await again.body?.cancel().catch(() => undefined);
} else {
  section('Live streams: skipped (set PROBE_RUN_ID and PROBE_MAX_STREAMS)');
}

// ── 10. Rate limit (last: it uses up this IP's budget for a minute) ────────
if (RATE_LIMIT > 0) {
  section(`Rate limit: ${RATE_LIMIT}/min per IP, then 429 with retry-after`);
  let first429;
  const budget = RATE_LIMIT + 20;
  for (let i = 0; i < budget && !first429; i += 25) {
    const batch = await Promise.all(Array.from({length: 25}, () => call('/v1/rank-modes')));
    first429 = batch.find((r) => r.res?.status === 429);
    if (batch.some((r) => r.res?.status >= 500)) bad('a 5xx under load');
  }
  if (!first429) bad(`no 429 after ${budget} requests`);
  else {
    const {res, json} = first429;
    if (json?.code === 'RATE_LIMITED' && res.headers.get('content-type')?.includes('problem+json'))
      ok('429 RATE_LIMITED, as a problem document');
    else bad(`429 body: ${JSON.stringify(json)}`);
    if (res.headers.get('retry-after')) ok(`retry-after: ${res.headers.get('retry-after')}`);
    else bad('429 without retry-after');
  }
  for (const path of ['/health', '/ready']) {
    const {res} = await call(path);
    if (res?.status === 429) bad(`${path} is rate limited: a load balancer would drop a healthy instance`);
    else ok(`${path} is exempt from the limit (${res?.status})`);
  }
} else {
  section('Rate limit: skipped (set PROBE_RATE_LIMIT)');
}

console.log(`\n${requests} requests, ${failed ? `${failed} FAILED` : 'all checks passed'}.`);
process.exit(failed ? 1 : 0);
