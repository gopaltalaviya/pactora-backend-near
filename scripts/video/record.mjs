#!/usr/bin/env node
/**
 * Records the Pactora demo video: one continuous browser session over the real
 * site, a real held demo stack on Monad testnet, and three HTML cards.
 * Writes artifacts/video/raw.webm + marks.json (scene start times, seconds).
 * Then `node scripts/video/make-video.mjs` cuts and encodes agentx-docs/docs/video/agentx-demo.mp4.
 *
 * Prerequisites (see agentx-docs: docs/video/README.md):
 *   1. the interface built with NEXT_PUBLIC_API_URL=http://127.0.0.1:8098 and
 *      served on SITE (default http://127.0.0.1:13300);
 *   2. `DEMO_HOLD=ui CORS_ORIGINS=<SITE> AGENT_MODE=cached node scripts/demo.mjs`
 *      holding fresh agents — the recorded run must be their first.
 * Playwright is resolved from the sibling agentx-interface checkout.
 */
/* global window, document -- page.evaluate callbacks run in the browser */
import {readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {director, overlayScript, sleep} from './overlay.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(SCRIPTS, '..', '..');
const require = createRequire(join(BACKEND, '..', 'agentx-interface', 'package.json'));
const {chromium} = require('@playwright/test');

const CARDS = join(SCRIPTS, 'cards');
const HERE = join(BACKEND, 'artifacts', 'video');
const SITE = process.env.SITE ?? 'http://127.0.0.1:13300';
const hold = JSON.parse(readFileSync(join(BACKEND, 'artifacts', 'demo-hold.json'), 'utf8'));
const ESCROW = JSON.parse(
  readFileSync(join(BACKEND, 'chain', 'deployments', '10143.json'), 'utf8'),
).contracts.TaskEscrow.toLowerCase();
const W = 1600;
const H = 900;
mkdirSync(`${HERE}/rec`, {recursive: true});
mkdirSync(`${HERE}/cards`, {recursive: true});

// Static cards are served from scripts/video/cards; the receipt card is generated per run.
const card = (name) =>
  pathToFileURL(name === 'receipt' ? `${HERE}/cards/receipt.html` : `${CARDS}/${name}.html`).href;
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: {width: W, height: H},
  recordVideo: {dir: `${HERE}/rec`, size: {width: W, height: H}},
});
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: SITE});
await ctx.addInitScript(overlayScript({width: W, height: H}));
const page = await ctx.newPage();
const t0 = Date.now();
const marks = [];
const mark = (name) => {
  marks.push({name, t: (Date.now() - t0) / 1000});
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${name}`);
};
const {caption, hideCursor, moveTo, click, glideTo} = director(page, t0);

// ── 1. Title ─────────────────────────────────────────────────────────────
mark('title');
await page.goto(card('title'));
await hideCursor();
await sleep(6500);

// ── 2. Problem ───────────────────────────────────────────────────────────
mark('problem');
await page.goto(card('problem'));
await hideCursor();
await sleep(9000);

// ── 3. Landing ───────────────────────────────────────────────────────────
mark('landing');
await page.goto(SITE + '/', {waitUntil: 'networkidle'});
await caption('Pactora — agents hire other agents and pay them through escrow on Monad');
await sleep(4200);
await glideTo(page.getByText('Jobs settled on chain'), 260, 1600);
await caption('Every figure here is read live from the chain — and every contract links to the explorer');
await sleep(4200);
await glideTo(page.locator('#how'), 140, 2000);
await caption('One sentence in. Plan → hire into escrow → judge → settle and score.');
await sleep(4500);

// ── 4. Live run ──────────────────────────────────────────────────────────
mark('demo');
await page.goto(SITE + '/demo', {waitUntil: 'networkidle'});
await caption('Give an orchestrator agent one sentence');
await sleep(1500);
await click(page.getByRole('button', {name: /Use example: Research ETH\/USDC/}));
await sleep(900);
const key = page.getByLabel('Orchestrator API key');
await moveTo(key);
await caption('…and its API key. It spends through an AgentAccount whose caps the chain enforces.');
await key.fill(hold.apiKey);
await sleep(2200);
mark('run');
await caption('Run — everything from here happens on Monad testnet');
await click(page.getByRole('button', {name: 'Run', exact: true}));
await page.getByRole('region', {name: 'This run'}).waitFor({timeout: 30000});
await sleep(600);
await glideTo(page.getByRole('region', {name: 'This run'}), 90, 1200);
await hideCursor();
const trace = page.getByRole('list', {name: 'Run trace'});
await trace.getByText('planned').waitFor({timeout: 120000});
await caption('The orchestrator plans four subtasks, then picks each agent — and says why');
await trace.getByText('hired').first().waitFor({timeout: 120000});
await caption('Hired: payment is locked in escrow first. Every on-chain line links to its transaction.');
await trace.getByText('judged').first().waitFor({timeout: 120000});
await caption('A judge reads the work before any money moves');
await trace.getByText('settled').first().waitFor({timeout: 120000});
await caption('Settled — and only now is the worker’s ERC-8004 reputation written');
// Keep the newest lines in view while the rest streams in.
const follow = setInterval(() => {
  page
    .evaluate(() => {
      const lines = document.querySelectorAll('[aria-label="Run trace"] > li');
      lines[lines.length - 1]?.scrollIntoView({behavior: 'smooth', block: 'center'});
    })
    .catch(() => {});
}, 1500);
await sleep(9000);
await caption('Four hires, four judgements, four settlements — about a minute, no human in the loop');
await page.getByText('finished', {exact: true}).first().waitFor({timeout: 400000});
clearInterval(follow);
mark('finished');
await sleep(1500);
await glideTo(page.getByRole('heading', {name: 'Answer'}), 160, 1500);
await caption('The answer — and what each step cost, and why');
await sleep(5000);

// ── 5. Proof: the settlement's receipt, read from the chain ─────────────
// (The public explorer shows a bot check to an automated browser, so the
// same facts are read straight from the Monad RPC and shown as a card.)
const txHref = await trace.locator('a[href*="/tx/0x"]').last().getAttribute('href');
const txHash = txHref.split('/tx/')[1];
const rpc = async (method, params) =>
  (
    await (
      await fetch('https://testnet-rpc.monad.xyz', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
      })
    ).json()
  ).result;
const rc = await rpc('eth_getTransactionReceipt', [txHash]);
const blk = await rpc('eth_getBlockByNumber', [rc.blockNumber, false]);
const when = new Date(Number(blk.timestamp) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const row = (k, v, cls = '') => `<div class="r"><span>${k}</span><b class="${cls}">${v}</b></div>`;
writeFileSync(
  `${HERE}/cards/receipt.html`,
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(CARDS, 'base.css')).href}">
<style>.box{width:1180px;margin:0 auto;padding:40px 48px;border:1px solid #232833;border-radius:22px;background:rgba(15,18,25,.92);text-align:left}
.r{display:flex;justify-content:space-between;gap:30px;padding:16px 0;border-bottom:1px solid #232833;font-size:24px}.r:last-child{border:0}
.r span{color:#8b94a7}.r b{font-family:"Cascadia Code",Consolas,monospace;font-weight:500;word-break:break-all;text-align:right}
.ok{color:#3fd68c}.h{font-size:30px;font-weight:600;margin-bottom:10px;display:flex;align-items:center;gap:14px}
.src{margin-top:18px;font-size:19px;color:#8b94a7}</style></head><body><div class="grid"></div>
<div class="wrap"><div class="box in d1"><div class="h"><span style="color:#3fd68c">●</span> Settlement transaction — Monad testnet (chain 10143)</div>
${row('Transaction', txHash)}${row('Status', rc.status === '0x1' ? 'Success' : rc.status, 'ok')}${row('Block', String(Number(rc.blockNumber)))}
${row('Time', when)}${row('Signed by (orchestrator’s session key)', rc.from.slice(0, 10) + '…' + rc.from.slice(-8))}${row('Sent to (orchestrator’s AgentAccount)', rc.to.slice(0, 10) + '…' + rc.to.slice(-8))}${row('Which called TaskEscrow v2', ESCROW.slice(0, 10) + '…' + ESCROW.slice(-8) + ' · ' + rc.logs.filter((l) => l.address.toLowerCase() === ESCROW).length + ' escrow event(s)')}</div>
<p class="src in d2">Read live from the Monad testnet RPC with eth_getTransactionReceipt — anyone can check it.</p></div></body></html>`,
);
mark('receipt');
await page.goto(card('receipt'));
await hideCursor();
await sleep(1200);
await caption('Not a log line: the settlement is a real transaction on Monad — anyone can look it up');
await sleep(7500);

// ── 6. The record, the reputation, the identity ─────────────────────────
mark('record');
const runs = await (
  await fetch(`${hold.api}/v1/runs?limit=1`, {headers: {authorization: `Bearer ${hold.apiKey}`}})
).json();
await page.goto(`${SITE}/runs/${runs.runs[0].runId}`);
await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
await page.waitForLoadState('networkidle');
await caption('Every run is a permanent, shareable record — 4 of 4 steps settled on chain');
await sleep(4500);
await glideTo(page.getByRole('heading', {name: 'Steps'}), 120, 1800);
await sleep(3000);

mark('marketplace');
await page.goto(SITE + '/agents', {waitUntil: 'networkidle'});
await caption('Reputation moved — written by the settlements, never self-reported');
await sleep(3500);
await click(page.getByRole('button', {name: 'Quality', exact: true}));
await caption('Rank by what you value; unproven agents are labelled, never scored');
await sleep(3000);
await click(page.getByText('View profile').first());
await page.waitForLoadState('networkidle');
await sleep(2500);
await caption('Its score, what it is made of, and its ERC-8004 identity on chain');
// A short page: scroll only far enough that the on-chain card sits fully in view
// with the score ring still above it, never into the footer.
await page.evaluate(() => {
  const card = [...document.querySelectorAll('h2')]
    .find((h) => h.textContent === 'On-chain')
    ?.closest('section');
  if (!card) return;
  const r = card.getBoundingClientRect();
  window.scrollBy({top: Math.max(0, r.bottom - window.innerHeight + 150), behavior: 'smooth'});
});
await sleep(1600);
await sleep(4500);

// ── 7. Status ────────────────────────────────────────────────────────────
mark('status');
await page.goto(SITE + '/status', {waitUntil: 'networkidle'});
await caption('Every component’s health is public — nothing hidden');
await sleep(5500);

// ── 8. End ───────────────────────────────────────────────────────────────
mark('end');
await page.goto(card('end'));
await hideCursor();
await sleep(8500);
mark('stop');

await page.close();
await ctx.close();
await browser.close();

const file = readdirSync(`${HERE}/rec`)
  .filter((f) => f.endsWith('.webm'))
  .sort()
  .pop();
renameSync(`${HERE}/rec/${file}`, `${HERE}/raw.webm`);
writeFileSync(`${HERE}/marks.json`, JSON.stringify(marks, null, 2));
console.log('\nwrote raw.webm and marks.json');
