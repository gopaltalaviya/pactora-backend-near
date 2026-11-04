import {describe, expect, it} from 'vitest';
/**
 * Live (Groq as the only model): the judge disputed a research step for not
 * containing "a buy recommendation or an execution plan" — the other agents'
 * steps. A step is judged against its own part of the goal.
 */
describe('the judge, on one step of a larger goal', () => {
  it('is told to judge only the commissioned part', async () => {
    const {JUDGE_SYSTEM} = await import('../src/index.js');
    expect(JUDGE_SYSTEM).toMatch(/whole\s+goal/i);
    expect(JUDGE_SYSTEM).toMatch(/other\s+agents/i);
  });
});
