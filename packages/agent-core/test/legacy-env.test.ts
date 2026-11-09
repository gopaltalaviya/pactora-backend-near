import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {runWorker} from '../src/run.js';

// A worker whose `.env` carries an unsupported variable (AGENTX_API_URL) must
// refuse by name, not report a missing key or poll the default URL.
describe('a worker started with an unsupported variable', () => {
  it('refuses and names the variable to use', async () => {
    await expect(
      runWorker({
        capability: 'market-research',
        role: 'test',
        output: z.object({}),
        env: {AGENTX_API_URL: 'http://127.0.0.1:1'},
      }),
    ).rejects.toThrow(/AGENTX_API_URL.*unsupported.*PACTORA_API_URL/);
  });
});
