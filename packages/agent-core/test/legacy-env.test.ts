import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {runWorker} from '../src/run.js';

// A worker whose `.env` carries an unsupported variable (DEFAULT_CHAIN_ID) must
// refuse by name, not report a missing key or poll the default URL.
describe('a worker started with an unsupported variable', () => {
  it('refuses and names the variable to use', async () => {
    await expect(
      runWorker({
        capability: 'market-research',
        role: 'test',
        output: z.object({}),
        env: {DEFAULT_CHAIN_ID: '1'},
      }),
    ).rejects.toThrow(/DEFAULT_CHAIN_ID.*unsupported.*DEFAULT_CHAIN/);
  });
});
