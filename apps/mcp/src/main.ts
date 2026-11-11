#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {assertNoUnsupportedEnv} from '@pactora/shared';
import {buildServer} from './server.js';

/**
 * stdio entrypoint.
 *
 * NOTHING may be written to stdout except MCP frames — stdout is the
 * transport, and a stray console.log corrupts the protocol. Diagnostics go to
 * stderr.
 */

try {
  assertNoUnsupportedEnv();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

const baseUrl = process.env['PACTORA_API_URL'] ?? 'http://127.0.0.1:8080';
const apiKey = process.env['PACTORA_API_KEY'];
const chainId = process.env['PACTORA_CHAIN_ID'];

// Remote mode (2026-11-09): MCP_HTTP_PORT serves the same tools over
// streamable HTTP, the caller's API key as the bearer (http.ts). No key of
// our own is needed, and stdout is free: nothing speaks the protocol on it.
const httpPort = process.env['MCP_HTTP_PORT'];
if (httpPort) {
  const port = Number(httpPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write(`MCP_HTTP_PORT must be a port number, got "${httpPort}"\n`);
    process.exit(1);
  }
  const perMinute = Number(process.env['MCP_RATE_LIMIT_PER_MINUTE'] ?? '60');
  if (!Number.isInteger(perMinute) || perMinute < 1) {
    process.stderr.write('MCP_RATE_LIMIT_PER_MINUTE must be a positive integer\n');
    process.exit(1);
  }
  const {serveMcpHttp} = await import('./http.js');
  const served = await serveMcpHttp({
    port,
    host: process.env['MCP_HTTP_HOST'] ?? '127.0.0.1',
    baseUrl,
    ...(chainId ? {chainId} : {}),
    allowedOrigins: (process.env['MCP_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rateLimitPerMinute: perMinute,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stderr.write(`Pactora MCP (streamable HTTP) ready at ${served.url} — api ${baseUrl}\n`);
  const stop = () => void served.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} else if (!apiKey) {
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
  if (!httpPort) {
    const server = await buildServer({
      baseUrl,
      apiKey: apiKey!,
      ...(chainId ? {chainId} : {}),
    });

    await server.connect(new StdioServerTransport());
    process.stderr.write(`Pactora MCP ready — api ${baseUrl}\n`);
  }
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
