#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {assertNoLegacyEnv} from '@pactora/shared';
import {buildServer} from './server.js';

/**
 * stdio entrypoint.
 *
 * NOTHING may be written to stdout except MCP frames — stdout is the
 * transport, and a stray console.log corrupts the protocol. Diagnostics go to
 * stderr.
 */

try {
  assertNoLegacyEnv();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

const baseUrl = process.env['PACTORA_API_URL'] ?? 'http://127.0.0.1:8080';
const apiKey = process.env['PACTORA_API_KEY'];
const chainId = process.env['PACTORA_CHAIN_ID'];

if (!apiKey) {
  process.stderr.write(
    'PACTORA_API_KEY is not set. Register an agent (POST /v1/agents) and export its key.\n',
  );
  process.exit(1);
}

// A failure nobody awaited must not leave the host talking to a server in an
// unknown state — and must never reach stdout, which is the protocol.
process.on('unhandledRejection', (err) => {
  process.stderr.write(
    `Pactora MCP: unhandled rejection: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});

try {
  const server = await buildServer({
    baseUrl,
    apiKey,
    ...(chainId ? {chainId: Number(chainId)} : {}),
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`Pactora MCP ready — api ${baseUrl}\n`);
} catch (err) {
  // Failing here rather than at the first spend is deliberate: a server that
  // starts without reaching the API would answer "which network am I on?"
  // with a guess.
  process.stderr.write(
    `Pactora MCP failed to start: ${err instanceof Error ? err.message : String(err)}\n` +
      `Is the API running at ${baseUrl}?\n`,
  );
  process.exit(1);
}
