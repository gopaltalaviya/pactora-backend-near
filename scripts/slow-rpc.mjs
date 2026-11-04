#!/usr/bin/env node
/**
 * A bad network between Pactora and its chain — the "phone hotspot" chaos item.
 *
 *   node scripts/slow-rpc.mjs                      # :8599 → Monad testnet, 600–1800 ms, 5% failures
 *   SLOW_RPC_DELAY=1500 SLOW_RPC_JITTER=2000 SLOW_RPC_FAIL=0.1 node scripts/slow-rpc.mjs
 *   SLOW_RPC_FAIL_SEND=0.3 node scripts/slow-rpc.mjs   # broadcasts fail more often
 *
 * Then point everything at it: RPC_URL_10143=http://127.0.0.1:8599
 *
 * Every JSON-RPC request is held for DELAY + random(JITTER) ms before being
 * forwarded, and a FAIL fraction are answered with a 503 instead — the two
 * things a tethered laptop actually does. What it tests is that nothing in the
 * system has a timeout that silently assumes a fast link: the demo must still
 * settle, just slower.
 *
 * Reads are most of the traffic and viem retries them itself, so a run at
 * 20% can pass without a single broadcast failing. SLOW_RPC_FAIL_SEND sets a
 * separate rate for eth_sendRawTransaction, so the path where the SIGNER must
 * report a retryable outage is exercised on purpose, not by luck.
 *
 * It counts what it did and prints a line per 50 requests, so a run can say
 * how hostile the network actually was.
 */

import {createServer} from 'node:http';

const PORT = Number(process.env.SLOW_RPC_PORT ?? 8599);
const UPSTREAM = process.env.SLOW_RPC_UPSTREAM ?? 'https://testnet-rpc.monad.xyz';
const DELAY = Number(process.env.SLOW_RPC_DELAY ?? 600);
const JITTER = Number(process.env.SLOW_RPC_JITTER ?? 1200);
const FAIL = Number(process.env.SLOW_RPC_FAIL ?? 0.05);
const FAIL_SEND = Number(process.env.SLOW_RPC_FAIL_SEND ?? FAIL);

const stats = {requests: 0, failed: 0, sends: 0, sendsFailed: 0, slowestMs: 0, totalDelayMs: 0};

/** Whether a JSON-RPC body (single or batch) carries a broadcast. */
function isSend(body) {
  try {
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).some((r) => r?.method === 'eth_sendRawTransaction');
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    stats.requests++;
    const wait = DELAY + Math.floor(Math.random() * JITTER);
    stats.totalDelayMs += wait;
    stats.slowestMs = Math.max(stats.slowestMs, wait);
    await sleep(wait);

    const send = isSend(body);
    if (send) stats.sends++;
    if (Math.random() < (send ? FAIL_SEND : FAIL)) {
      stats.failed++;
      if (send) stats.sendsFailed++;
      res.writeHead(503, {'content-type': 'text/plain'});
      res.end('upstream unavailable (injected)');
    } else {
      try {
        const up = await fetch(UPSTREAM, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body,
        });
        res.writeHead(up.status, {'content-type': 'application/json'});
        res.end(await up.text());
      } catch (err) {
        stats.failed++;
        res.writeHead(502, {'content-type': 'text/plain'});
        res.end(`upstream error: ${err.message}`);
      }
    }

    if (stats.requests % 50 === 0) {
      console.log(
        `slow-rpc: ${stats.requests} requests, ${stats.failed} failed, ` +
          `${stats.sendsFailed}/${stats.sends} broadcasts failed, ` +
          `avg delay ${Math.round(stats.totalDelayMs / stats.requests)} ms, slowest ${stats.slowestMs} ms`,
      );
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(
    `slow-rpc on :${PORT} → ${UPSTREAM}, ${DELAY}+${JITTER} ms, ${FAIL * 100}% failures, ${FAIL_SEND * 100}% on broadcasts`,
  );
});
