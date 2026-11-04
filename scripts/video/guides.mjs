#!/usr/bin/env node
/**
 * Records and encodes the how-to guides shown on the site's /docs/guides:
 * six short clips over the real site and a real held demo stack on Monad
 * testnet, 1280×720, captions burned in AND as a WebVTT track.
 *
 *   node scripts/video/guides.mjs record [slug…]   # → artifacts/video/guides/<slug>.webm + .json
 *   FFMPEG=… node scripts/video/guides.mjs encode [slug…]
 *                                                  # → agentx-interface/public/guides/<slug>.mp4/.vtt/.jpg
 *
 * Prerequisites — the same as record.mjs (see agentx-docs: docs/video/README.md): the site
 * on SITE (default http://127.0.0.1:13300) built against the demo's API, and
 * `DEMO_HOLD=ui … node scripts/demo.mjs` holding FRESH agents — "first-run"
 * must be their first run (a cached replay only matches that one), so record
 * it first; the others read what it left behind.
 */
/* global window, document -- page.evaluate callbacks run in the browser */
import {execFileSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {director, overlayScript, sleep, toVtt} from './overlay.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(SCRIPTS, '..', '..');
const INTERFACE = join(BACKEND, '..', 'agentx-interface');
const RAW = join(BACKEND, 'artifacts', 'video', 'guides');
const OUT = join(INTERFACE, 'public', 'guides');
const SITE = process.env.SITE ?? 'http://127.0.0.1:13300';
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const W = 1280;
const H = 720;

const holdFile = join(BACKEND, 'artifacts', 'demo-hold.json');
const hold = () => {
  if (!existsSync(holdFile))
    throw new Error('no artifacts/demo-hold.json — start a held demo (DEMO_HOLD=ui)');
  return JSON.parse(readFileSync(holdFile, 'utf8'));
};

/**
 * Each guide: what it shows, and the steps. `fast` names a marked stretch
 * played at 2× (the live run); everything else is real time.
 */
const GUIDES = [
  {
    slug: 'first-run',
    poster: 'settled',
    async steps({page, d, mark}) {
      const {apiKey} = hold();
      await page.goto(`${SITE}/demo`, {waitUntil: 'networkidle'});
      await d.caption('Start a run: give an orchestrator agent one sentence');
      await sleep(1200);
      await d.click(page.getByRole('button', {name: /Use example: Research ETH\/USDC/}));
      await sleep(800);
      const key = page.getByLabel('Orchestrator API key');
      await d.caption('Paste its API key — used for this request only, never stored');
      await d.moveTo(key);
      await key.fill(apiKey);
      await sleep(1800);
      await d.caption('Run. Everything from here happens on Monad testnet.');
      await d.click(page.getByRole('button', {name: 'Run', exact: true}));
      await page.getByRole('region', {name: 'This run'}).waitFor({timeout: 30_000});
      await d.glideTo(page.getByRole('region', {name: 'This run'}), 80, 1000);
      await d.hideCursor();
      mark('fast');
      const trace = page.getByRole('list', {name: 'Run trace'});
      await trace.getByText('planned').waitFor({timeout: 120_000});
      await d.caption('First a plan, then each subtask is matched to an agent — with the reason');
      await trace.getByText('hired').first().waitFor({timeout: 120_000});
      await d.caption('Hired: the payment is locked in escrow before any work starts');
      await trace.getByText('settled').first().waitFor({timeout: 180_000});
      mark('settled');
      await d.caption('A judge reads the work; only then is it settled and the score written');
      const follow = setInterval(() => {
        page
          .evaluate(() => {
            const lines = document.querySelectorAll('[aria-label="Run trace"] > li');
            lines[lines.length - 1]?.scrollIntoView({behavior: 'smooth', block: 'center'});
          })
          .catch(() => {});
      }, 1500);
      const hired = trace.getByText('hired', {exact: true});
      await hired.nth(1).waitFor({timeout: 240_000});
      await d.caption('Then the next subtask — the same loop: hire, judge, settle');
      await hired.nth(2).waitFor({timeout: 240_000});
      await d.caption('Each agent is paid only for work that passed the judge');
      await hired.nth(3).waitFor({timeout: 240_000});
      await d.caption('Four hires, four verdicts, four settlements — no human in the loop');
      await page.getByText('finished', {exact: true}).first().waitFor({timeout: 400_000});
      clearInterval(follow);
      mark('fast-end');
      await sleep(1000);
      await d.glideTo(page.getByRole('heading', {name: 'Answer'}), 140, 1400);
      await d.caption('The answer, and what each step cost. Every on-chain line links to its transaction.');
      await sleep(4500);
    },
  },
  {
    slug: 'run-record',
    poster: 'steps',
    async steps({page, d, mark}) {
      const {apiKey} = hold();
      await page.goto(`${SITE}/runs`, {waitUntil: 'networkidle'});
      await d.caption('Every run is kept. Paste the orchestrator’s key to list its runs.');
      const key = page.getByLabel('Orchestrator API key');
      await d.moveTo(key);
      await key.fill(apiKey);
      await sleep(1200);
      await page.keyboard.press('Enter');
      const first = page.getByRole('region', {name: 'Runs'}).getByRole('link').first();
      await first.waitFor({timeout: 20_000});
      await sleep(1200);
      await d.caption('Open one for the full record');
      await d.click(first);
      await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
      await page.waitForLoadState('networkidle');
      await d.caption('The summary: steps settled, what was spent, how long it took');
      await sleep(3500);
      await d.glideTo(page.getByRole('heading', {name: 'Steps'}), 100, 1600);
      mark('steps');
      await d.caption('Each step: the agent hired, the price, the verdict — and the settlement transaction');
      await sleep(4500);
      await d.glideTo(page.getByRole('heading', {name: 'Trace', exact: true}), 90, 1800);
      await d.caption('Below it, the full trace, line by line, exactly as it streamed');
      await sleep(3500);
      await d.caption('The link is public and permanent: copy it to share the record');
      await page.evaluate(() => window.scrollTo({top: 0, behavior: 'smooth'}));
      await sleep(900);
      await d.click(page.getByRole('button', {name: 'Copy link to this run'}));
      await sleep(3000);
    },
  },
  {
    slug: 'find-agents',
    poster: 'profile',
    async steps({page, d, mark}) {
      await page.goto(`${SITE}/agents`, {waitUntil: 'networkidle'});
      await d.caption('The marketplace: every score was written by a settled payment');
      await sleep(3200);
      await d.caption('Rank by what you value');
      await d.click(page.getByRole('button', {name: 'Quality', exact: true}));
      await sleep(1600);
      await d.click(page.getByRole('button', {name: 'Cheapest', exact: true}));
      await sleep(1600);
      await d.click(page.getByRole('button', {name: 'Balanced', exact: true}));
      await sleep(1000);
      // The capability chips: toggle buttons named by a kebab-case capability.
      const filter = page.getByRole('button', {name: /^[a-z0-9]+(-[a-z0-9]+)+$/, pressed: false}).first();
      if (await filter.count()) {
        await d.caption('Filter by what an agent can do');
        await d.click(filter);
        await sleep(2200);
      }
      await d.caption('Open a profile to see what its score is made of');
      await d.click(page.getByText('View profile').first());
      await page.waitForLoadState('networkidle');
      mark('profile');
      await sleep(2500);
      await d.caption('Jobs, disputes, price — and its ERC-8004 identity, on chain');
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('h2')]
          .find((h) => h.textContent === 'On-chain')
          ?.closest('section');
        if (!card) return;
        const r = card.getBoundingClientRect();
        window.scrollBy({top: Math.max(0, r.bottom - window.innerHeight + 120), behavior: 'smooth'});
      });
      await sleep(5000);
    },
  },
  {
    slug: 'system-health',
    poster: 'components',
    async steps({page, d, mark}) {
      await page.goto(`${SITE}/status`, {waitUntil: 'networkidle'});
      await d.caption('Is Pactora working right now? The status page is public.');
      await sleep(3200);
      await d.glideTo(page.getByRole('listitem').filter({hasText: 'Database'}).first(), 160, 1400);
      mark('components');
      await d.caption('Each part, in words: API, database, signer, chain connection, indexer');
      await sleep(4500);
      await d.glideTo(page.getByText('How closely this site follows the chain'), 220, 1600);
      await d.caption('How closely the site follows the chain: the indexer’s block and its lag');
      await sleep(4000);
      await page.evaluate(() => window.scrollTo({top: 0, behavior: 'smooth'}));
      await sleep(900);
      await d.caption('It refreshes itself every 15 seconds — or now');
      await d.click(page.getByRole('button', {name: 'Refresh'}));
      await sleep(2800);
    },
  },
  {
    slug: 'register-agent',
    poster: 'form',
    async steps({page, d, mark}) {
      await page.goto(`${SITE}/register`, {waitUntil: 'networkidle'});
      await d.caption('Register an agent: what it does, what it charges, where it is paid');
      await sleep(2600);
      await d.type(page.getByLabel('Name', {exact: true}), 'SummaryBot');
      await d.type(page.getByLabel('What it does'), 'Summarises long documents into five bullet points.', 30);
      mark('form');
      await d.caption('Capabilities are how orchestrators find it');
      await page.getByLabel('Capabilities').fill('');
      await d.type(page.getByLabel('Capabilities'), 'summarization, research');
      await sleep(900);
      await d.caption('The form refuses what the escrow would — before anything is signed');
      const price = page.getByLabel(/Price per task/);
      await price.fill('');
      await d.type(price, '500');
      await sleep(2800);
      await d.caption('Prices are in base units: 20000 is 0.02 USDC — or pick one');
      await d.click(page.getByRole('button', {name: /^Set the price to/}).nth(1));
      await sleep(2000);
      await d.glideTo(page.getByRole('button', {name: 'Register', exact: true}), 300, 1200);
      await d.caption('Your wallet signs one transaction: the agent’s ERC-8004 identity');
      await d.moveTo(page.getByRole('button', {name: /Connect wallet/}));
      await sleep(3200);
      await d.caption('Then the API key appears once — keep it; it is how the agent works and gets paid');
      await d.moveTo(page.getByRole('complementary', {name: 'Registration steps'}));
      await sleep(4200);
    },
  },
  {
    slug: 'search-docs',
    poster: 'results',
    async steps({page, d, mark}) {
      await page.goto(`${SITE}/docs`, {waitUntil: 'networkidle'});
      await d.caption('Search everything: press Ctrl K (⌘ K on a Mac), anywhere on the site');
      await sleep(1800);
      await page.keyboard.press('Control+k');
      const box = page.getByRole('combobox', {name: 'Search the docs, pages and agents'});
      await box.waitFor();
      await sleep(900);
      await d.caption('A typo is fine — it still finds the right section');
      await box.pressSequentially('dipsute timeout', {delay: 90});
      mark('results');
      await sleep(2600);
      await d.caption('Arrow keys to choose, Enter to jump straight to it');
      await page.keyboard.press('ArrowDown');
      await sleep(700);
      await page.keyboard.press('ArrowUp');
      await sleep(700);
      await page.keyboard.press('Enter');
      await page.waitForURL(/#/);
      await sleep(2800);
      await d.caption('Pages, quick actions and live agents are in the same search');
      await page.keyboard.press('Control+k');
      await box.waitFor();
      await box.pressSequentially('register', {delay: 90});
      await sleep(2400);
      await box.fill('');
      await box.pressSequentially('research', {delay: 90});
      await sleep(2800);
      await page.keyboard.press('Escape');
      await sleep(900);
    },
  },
];

async function record(guide) {
  const require = createRequire(join(INTERFACE, 'package.json'));
  const {chromium} = require('@playwright/test');
  const tmp = join(RAW, `rec-${guide.slug}`);
  rmSync(tmp, {recursive: true, force: true});
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: {width: W, height: H},
    recordVideo: {dir: tmp, size: {width: W, height: H}},
    reducedMotion: 'no-preference',
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: SITE});
  await ctx.addInitScript(overlayScript({width: W, height: H, scale: 0.8}));
  const page = await ctx.newPage();
  const t0 = Date.now();
  const d = director(page, t0);
  const marks = {};
  const mark = (name) => (marks[name] = d.now());
  console.log(`  recording ${guide.slug}…`);
  try {
    await guide.steps({page, d, mark});
  } finally {
    mark('end');
    await page.close();
    await ctx.close();
    await browser.close();
  }
  const file = readdirSync(tmp).find((f) => f.endsWith('.webm'));
  renameSync(join(tmp, file), join(RAW, `${guide.slug}.webm`));
  rmSync(tmp, {recursive: true, force: true});
  writeFileSync(join(RAW, `${guide.slug}.json`), JSON.stringify({marks, captions: d.captionLog()}, null, 2));
  console.log(`  ✓ ${guide.slug}: ${marks.end.toFixed(1)} s raw`);
}

/** Output time for input time `t`, given the stretch played at 2×. */
const mapper = (marks) => {
  const a = marks.fast;
  const b = marks['fast-end'];
  if (a === undefined || b === undefined) return (t) => t;
  return (t) => (t <= a ? t : t <= b ? a + (t - a) / 2 : a + (b - a) / 2 + (t - b));
};

function encode(guide) {
  const {marks, captions} = JSON.parse(readFileSync(join(RAW, `${guide.slug}.json`), 'utf8'));
  const start = 0.4; // the first frames are the blank page before the first paint
  const end = marks.end - 0.2;
  const a = marks.fast;
  const b = marks['fast-end'];
  const segs =
    a !== undefined && b !== undefined
      ? [
          [start, a, 1],
          [a, b, 2],
          [b, end, 1],
        ]
      : [[start, end, 1]];
  const parts = segs.map(
    ([s, e, k], n) =>
      `[0:v]trim=${s.toFixed(2)}:${e.toFixed(2)},setpts=(PTS-STARTPTS)/${k},fps=30,setsar=1[v${n}];`,
  );
  const duration = segs.reduce((acc, [s, e, k]) => acc + (e - s) / k, 0);
  const filter =
    parts.join('') +
    segs.map((_, n) => `[v${n}]`).join('') +
    `concat=n=${segs.length}:v=1:a=0[cat];[cat]fade=t=in:st=0:d=0.5,fade=t=out:st=${(duration - 0.8).toFixed(2)}:d=0.8[v]`;
  mkdirSync(OUT, {recursive: true});
  const mp4 = join(OUT, `${guide.slug}.mp4`);
  // No audio track: these play muted inline on the docs, with captions.
  execFileSync(FFMPEG, [
    '-loglevel', 'error', '-y', '-i', join(RAW, `${guide.slug}.webm`),
    '-filter_complex', filter, '-map', '[v]', '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', mp4,
  ]); // prettier-ignore

  const toOut = mapper(marks);
  const shifted = captions.map((c) => ({
    ...c,
    start: toOut(c.start) - start,
    end: Math.min(toOut(c.end), toOut(end)) - start,
  }));
  writeFileSync(join(OUT, `${guide.slug}.vtt`), toVtt(shifted));

  const at = Math.max(0, toOut(marks[guide.poster] ?? marks.end / 2) - start + 1.2);
  execFileSync(FFMPEG, [
    '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', mp4,
    '-frames:v', '1', '-q:v', '4', join(OUT, `${guide.slug}.jpg`),
  ]); // prettier-ignore

  const mb = (statSync(mp4).size / 1e6).toFixed(2);
  console.log(`  ✓ ${guide.slug}.mp4 — ${duration.toFixed(1)} s, ${mb} MB, ${captions.length} captions`);
  return {slug: guide.slug, seconds: Math.round(duration)};
}

const [command = 'all', ...only] = process.argv.slice(2);
const chosen = only.length ? GUIDES.filter((g) => only.includes(g.slug)) : GUIDES;
if (only.length && chosen.length !== only.length) {
  console.error(`unknown guide; one of: ${GUIDES.map((g) => g.slug).join(', ')}`);
  process.exit(2);
}
mkdirSync(RAW, {recursive: true});
if (command === 'record' || command === 'all') for (const g of chosen) await record(g);
if (command === 'encode' || command === 'all') {
  const durations = chosen.map(encode);
  // The site reads durations from here rather than hard-coding them.
  const index = join(OUT, 'guides.json');
  const prior = existsSync(index) ? JSON.parse(readFileSync(index, 'utf8')) : {};
  for (const {slug, seconds} of durations) prior[slug] = {seconds};
  writeFileSync(index, `${JSON.stringify(prior, null, 2)}\n`);
}
