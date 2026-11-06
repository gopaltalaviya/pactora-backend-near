import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {nearClient} from '../src/index.js';

/**
 * near-api-js reads `retries` as the number of ATTEMPTS: 0 sent no request at
 * all and answered "Exceeded 10 attempts", so /v1/status reported a working
 * chain as down. Our option means retries after a failure.
 */
describe('nearClient retries', () => {
  let hits = 0;
  let fail = false;
  const server = createServer((req, res) => {
    hits++;
    if (fail) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {header: {height: 42, hash: 'h', timestamp_nanosec: '1'}, chunks: []},
      }),
    );
  });
  let url = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('retries: 0 still makes one request', async () => {
    hits = 0;
    fail = false;
    const c = nearClient(url, {timeoutMs: 2_000, retries: 0});
    expect((await c.finalBlock()).height).toBe(42);
    expect(hits).toBe(1);
  });

  it('retries: 1 makes at most two requests', async () => {
    hits = 0;
    fail = true;
    const c = nearClient(url, {timeoutMs: 2_000, retries: 1});
    await expect(c.finalBlock()).rejects.toThrow();
    expect(hits).toBe(2);
  });
});
