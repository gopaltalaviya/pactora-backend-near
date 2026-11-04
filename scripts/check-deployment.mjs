#!/usr/bin/env node
/**
 * Is a hosted Pactora deployment actually right? Read-only; needs no key.
 *
 *   node scripts/check-deployment.mjs https://<api>.up.railway.app https://<site>.vercel.app
 *   node scripts/check-deployment.mjs http://127.0.0.1:8080          # API only
 *
 * "It deployed" and "it works" are different claims. This checks the second
 * from the outside, the way a judge's browser will meet it:
 *
 *   - the API serves the chain and the escrow this repo was built for
 *     (chain/deployments/<id>.json), and is READY — database and signer both;
 *   - jobs and runs are not enumerable by serial id;
 *   - CORS lets the site in and nobody else, and security headers are on;
 *   - the site answers, its CSP lets it reach this API, and bad ids are 404s.
 *
 * Exit 0 when every check passes; 1 otherwise. Warnings (no orchestrator, an
 * http URL) do not fail it, but are printed.
 */

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const [apiArg, siteArg] = process.argv.slice(2);
if (!apiArg) {
  console.error('usage: node scripts/check-deployment.mjs <API_URL> [SITE_URL]');
  process.exit(2);
}
const API = apiArg.replace(/\/$/, '');
const SITE = siteArg?.replace(/\/$/, '');
const CHAIN_ID = Number(process.env.CHECK_CHAIN_ID ?? 10143);
const here = dirname(fileURLToPath(import.meta.url));
const deployment = JSON.parse(
  readFileSync(join(here, '..', 'chain', 'deployments', `${CHAIN_ID}.json`), 'utf8'),
);
const ESCROW = deployment.contracts.TaskEscrow.toLowerCase();

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  failed++;
  console.log(`  ✗ ${m}`);
};
const warn = (m) => console.log(`  ! ${m}`);

async function get(url, init = {}) {
  try {
    const res = await fetch(url, {...init, signal: AbortSignal.timeout(15_000), redirect: 'manual'});
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

console.log(`\nPactora deployment check — chain ${CHAIN_ID}, escrow ${ESCROW}\n\nAPI ${API}`);
if (!API.startsWith('https://')) warn('the API is not https — fine locally, not for a submission');

const health = await get(`${API}/health`);
if (health.error || !health.res.ok) {
  bad(`/health unreachable: ${health.error ?? health.res.status}`);
} else {
  await checkReachable(health);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll deployment checks passed.');
// exitCode, not exit(): exiting while fetch sockets close aborts Node on Windows.
process.exitCode = failed ? 1 : 0;

async function checkReachable(health) {
  const chain = health.json?.chains?.find((c) => c.chainId === CHAIN_ID);
  if (!chain) bad(`/health does not serve chain ${CHAIN_ID}`);
  else if (chain.escrow?.toLowerCase() !== ESCROW)
    bad(`API escrow is ${chain.escrow}, this repo's deployment is ${ESCROW} — stale image or wrong chain/`);
  else ok(`serves chain ${CHAIN_ID} with the deployed escrow`);
  if (health.json?.orchestrator) ok('orchestrator available — the site can start runs');
  else warn('no orchestrator (no model reachable) — the site can browse but not start a run');

  const ready = await get(`${API}/ready`);
  if (ready.res?.ok) ok('/ready — database and signer both reachable');
  else {
    const checks = ready.json?.checks ?? {};
    const down = Object.entries(checks)
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => `${k} (${v.error ?? 'down'})`);
    bad(`/ready is ${ready.res?.status ?? ready.error}: ${down.join(', ') || 'no detail'}`);
  }

  const network = await get(`${API}/v1/network?chainId=${CHAIN_ID}`);
  if (network.res?.ok) ok('/v1/network answers');
  else bad(`/v1/network is ${network.res?.status ?? network.error}`);

  const agents = await get(`${API}/v1/agents?chainId=${CHAIN_ID}`);
  if (agents.res?.ok && agents.json) ok('/v1/agents answers with JSON');
  else bad(`/v1/agents is ${agents.res?.status ?? agents.error}`);

  for (const kind of ['jobs', 'runs']) {
    const r = await get(`${API}/v1/${kind}/1`);
    if (r.res?.status === 404 || r.res?.status === 400)
      ok(`/v1/${kind}/1 is ${r.res.status} — not enumerable by serial id`);
    else bad(`/v1/${kind}/1 answered ${r.res?.status ?? r.error} — ids should be unguessable`);
  }

  const nosniff = health.res.headers.get('x-content-type-options');
  if (nosniff === 'nosniff') ok('security headers present');
  else bad('no x-content-type-options: nosniff — helmet is not on');

  const preflight = (origin) =>
    get(`${API}/v1/agents`, {
      method: 'OPTIONS',
      headers: {Origin: origin, 'Access-Control-Request-Method': 'GET'},
    });
  const foreign = await preflight('https://not-pactora.example');
  if (foreign.res?.headers.get('access-control-allow-origin')) bad('CORS allows an arbitrary origin');
  else ok('CORS refuses an arbitrary origin');

  if (SITE) {
    const origin = new URL(SITE).origin;
    const allowed = await preflight(origin);
    if (allowed.res?.headers.get('access-control-allow-origin') === origin)
      ok(`CORS allows the site (${origin})`);
    else bad(`CORS does not allow ${origin} — set CORS_ORIGINS on the API to exactly that, and redeploy`);

    console.log(`\nSite ${SITE}`);
    const home = await get(`${SITE}/`);
    if (!home.res?.ok) bad(`/ is ${home.res?.status ?? home.error}`);
    else {
      ok('/ answers');
      const csp = home.res.headers.get('content-security-policy') ?? '';
      const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src')) ?? '';
      if (connect.includes(new URL(API).origin)) ok('CSP connect-src includes the API');
      else
        bad(
          `CSP connect-src does not include ${new URL(API).origin} — NEXT_PUBLIC_API_URL was wrong at build time`,
        );
    }
    for (const path of ['/agents', '/runs', '/register']) {
      const r = await get(`${SITE}${path}`);
      if (r.res?.ok) ok(`${path} answers`);
      else bad(`${path} is ${r.res?.status ?? r.error}`);
    }
    const missing = await get(`${SITE}/runs/not-a-run`);
    if (missing.res?.status === 404) ok('an unknown run is a real 404');
    else bad(`/runs/not-a-run answered ${missing.res?.status ?? missing.error}, not 404`);
  }
}
