import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {PactoraClient} from '@pactora/sdk';
import {serveMcpHttp, type McpHttpServer} from '../src/http.js';
import {TESTNET} from './fixtures.js';

/**
 * The remote transport (2026-11-09): the same 31 tools over streamable
 * HTTP, the caller's API key as the bearer, an Origin check and a per-key
 * limit. A real MCP client drives a tool call over a real socket; the
 * Pactora API behind it is a fake, so nothing is spent.
 */

const KEY = `ax_${'1'.repeat(16)}_${'a'.repeat(32)}`;
const OTHER = `ax_${'2'.repeat(16)}_${'b'.repeat(32)}`;
let networkReads = 0;
const fake = {
  network: async () => {
    networkReads++;
    return TESTNET;
  },
  budget: async () => ({dailyRemainingDisplay: '0.30 USDC', maxSingleSpend: '50000'}),
  discover: async () => [],
  getJob: async () => ({jobId: '7', state: 'submitted', result: {summary: 'ok'}}),
} as unknown as PactoraClient;

let served: McpHttpServer;
beforeAll(async () => {
  served = await serveMcpHttp({
    port: 0,
    baseUrl: 'http://unused',
    clientFor: () => fake,
    allowedOrigins: ['http://localhost:3000'],
    rateLimitPerMinute: 5,
  });
});
afterAll(async () => {
  await served.close();
});

async function connect(key = KEY, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({name: 'remote-test', version: '0'});
  // The SDK's transport types predate exactOptionalPropertyTypes; the object is the right one.
  const transport = new StreamableHTTPClientTransport(new URL(served.url), {
    requestInit: {headers: {authorization: `Bearer ${key}`, ...headers}},
  });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

describe('MCP over streamable HTTP', () => {
  it('lists the same twenty-eight tools and answers a tool call, with the bearer as the agent key', async () => {
    const client = await connect();
    const {tools} = await client.listTools();
    expect(tools).toHaveLength(31);
    const res = await client.callTool({name: 'get_network', arguments: {}});
    const text = (res.content as {type: string; text: string}[])[0]!.text;
    expect(JSON.parse(text).chainId).toBe('near:testnet');
    expect(client.getInstructions()).toMatch(/TESTNET/);
    await client.close();
    // The network was read once for the key, not once per request.
    expect(networkReads).toBe(1);
  });

  it('refuses a request without a Pactora API key (401), and any browser origin not allowed (403)', async () => {
    const body = {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}};
    const headers = {'content-type': 'application/json', accept: 'application/json, text/event-stream'};
    const noKey = await fetch(served.url, {method: 'POST', headers, body: JSON.stringify(body)});
    expect(noKey.status).toBe(401);
    expect(noKey.headers.get('www-authenticate')).toMatch(/Bearer/);
    const sessionToken = await fetch(served.url, {
      method: 'POST',
      headers: {...headers, authorization: `Bearer ps_${'1'.repeat(16)}_${'a'.repeat(32)}`},
      body: JSON.stringify(body),
    });
    expect(sessionToken.status).toBe(401);
    const badOrigin = await fetch(served.url, {
      method: 'POST',
      headers: {...headers, authorization: `Bearer ${OTHER}`, origin: 'https://evil.example'},
      body: JSON.stringify(body),
    });
    expect(badOrigin.status).toBe(403);
    const goodOrigin = await fetch(served.url, {
      method: 'POST',
      headers: {...headers, authorization: `Bearer ${OTHER}`, origin: 'http://localhost:3000'},
      body: JSON.stringify(body),
    });
    expect(goodOrigin.status).toBe(200);
    // Stateless: nothing to GET or DELETE.
    expect((await fetch(served.url, {headers: {authorization: `Bearer ${OTHER}`}})).status).toBe(405);
    expect((await fetch(served.url.replace('/mcp', '/health'))).status).toBe(200);
  });

  it('limits each key to its requests per minute, independently of other keys', async () => {
    const third = `ax_${'3'.repeat(16)}_${'c'.repeat(32)}`;
    const body = {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}};
    const headers = {'content-type': 'application/json', accept: 'application/json, text/event-stream'};
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push(
        (
          await fetch(served.url, {
            method: 'POST',
            headers: {...headers, authorization: `Bearer ${third}`},
            body: JSON.stringify(body),
          })
        ).status,
      );
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    const fourth = `ax_${'4'.repeat(16)}_${'d'.repeat(32)}`;
    expect(
      (
        await fetch(served.url, {
          method: 'POST',
          headers: {...headers, authorization: `Bearer ${fourth}`},
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(200);
  });
});
