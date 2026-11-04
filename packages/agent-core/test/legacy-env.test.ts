import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {runWorker} from '../src/run.js';

// A worker's hosted `.env` written before 2026-11-01 says AGENTX_API_URL.
// It must refuse by name, not report a missing key or poll the default URL.
describe('a worker started with a pre-rename AGENTX_* variable', () => {
  it('refuses and names the PACTORA_* replacement', async () => {
    await expect(
      runWorker({
        capability: 'market-research',
        role: 'test',
        output: z.object({}),
        env: {AGENTX_API_URL: 'http://127.0.0.1:1'},
      }),
    ).rejects.toThrow(/AGENTX_API_URL.*renamed.*PACTORA_API_URL/);
  });
});
