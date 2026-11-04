#!/usr/bin/env node
/**
 * Keep `chain/` — the chain facts an image carries — equal to agentx-contracts.
 *
 *   node scripts/sync-chain-facts.mjs           # copy from ../agentx-contracts
 *   node scripts/sync-chain-facts.mjs --check   # exit 1 if chain/ has drifted
 *
 * A hosted build (Railway) clones ONE repository, so it cannot be handed the
 * sibling agentx-contracts checkout the Dockerfile used to read networks,
 * parameters, deployed addresses and ABIs from. `chain/` is a committed copy of
 * exactly those files, and the Dockerfile's default. agentx-contracts stays the
 * source of truth: this script is the only writer, and CI runs `--check`
 * against a fresh checkout, so a redeploy that is not synced here fails the
 * build instead of shipping an image that talks to the old contracts.
 */

import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'chain');
const SRC = process.env.PACTORA_CONTRACTS_ROOT ?? join(here, '..', '..', 'agentx-contracts');
const CHECK = process.argv.includes('--check');

/** What the config loader reads, and nothing else. */
const DIRS = ['config', 'deployments', join('export', 'abis')];

if (!existsSync(join(SRC, 'config', 'networks.json'))) {
  console.error(`sync-chain-facts: no agentx-contracts checkout at ${SRC} — set PACTORA_CONTRACTS_ROOT`);
  process.exit(2);
}

const listJson = (root) =>
  DIRS.flatMap((d) =>
    existsSync(join(root, d))
      ? readdirSync(join(root, d))
          .filter((f) => f.endsWith('.json'))
          .map((f) => join(d, f))
      : [],
  ).sort();

// Byte-exact, apart from line endings: a Windows checkout must not read as drift.
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const want = listJson(SRC);
const have = listJson(OUT);

if (CHECK) {
  const problems = [
    ...want.filter((f) => !have.includes(f)).map((f) => `missing  chain/${f}`),
    ...have.filter((f) => !want.includes(f)).map((f) => `extra    chain/${f}`),
    ...want
      .filter((f) => have.includes(f) && read(join(SRC, f)) !== read(join(OUT, f)))
      .map((f) => `differs  chain/${f}`),
  ];
  if (problems.length) {
    console.error(`chain/ has drifted from agentx-contracts (${relative(process.cwd(), SRC) || SRC}):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('run: node scripts/sync-chain-facts.mjs, and commit chain/');
    process.exit(1);
  }
  console.log(`chain/ matches agentx-contracts — ${want.length} files`);
  process.exit(0);
}

rmSync(OUT, {recursive: true, force: true});
for (const f of want) {
  mkdirSync(dirname(join(OUT, f)), {recursive: true});
  writeFileSync(join(OUT, f), read(join(SRC, f)));
}
console.log(`chain/ ← agentx-contracts: ${want.length} files`);
