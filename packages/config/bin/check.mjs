#!/usr/bin/env node
/**
 * Boot-time config check, runnable standalone.
 *
 * Every service calls loadConfig() at startup; this exposes the same check to
 * CI and to a human, so "is my environment right?" never requires starting a
 * server and making a request.
 */
import {loadConfig} from '../dist/index.js';

try {
  const config = loadConfig();
  const ids = Object.keys(config.chains);
  console.log(`\u2713 Pactora config OK \u2014 ${ids.length} chain(s) enabled\n`);
  for (const id of ids) {
    const c = config.chain(id);
    const star = c.chainId === config.defaultChainId ? ' (default)' : '';
    console.log(`  ${c.name} [${c.chainId}]${star}`);
    console.log(`    rpc        ${c.rpcUrl}`);
    console.log(`    blocks     ${c.blockSource.kind === 'neardata' ? c.blockSource.url : 'rpc'}`);
    console.log(`    testnet    ${c.testnet}`);
    console.log(`    startBlock ${c.startBlock}`);
    console.log(`    fastPath   ${c.formatToken(c.params.fastPathMax)}`);
    console.log(`    minStake   ${c.formatToken(c.params.minStake)}`);
    console.log(`    fee        ${c.params.protocolFeeBps / 100}%`);
    for (const [name, account] of Object.entries(c.contracts)) {
      console.log(`    ${name.padEnd(20)} ${account}`);
    }
    console.log('');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
