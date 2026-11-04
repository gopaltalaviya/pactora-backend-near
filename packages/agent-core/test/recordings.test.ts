import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
  JUDGE_SYSTEM,
  PLANNER_SYSTEM,
  SELECTOR_SYSTEM,
  SYNTHESIS_SYSTEM,
  TRIAGE_SYSTEM,
  WORKER_SYSTEM,
  cacheKey,
} from '../src/index.js';

/**
 * The committed model recordings in `.agent-cache/` are what let anyone run
 * the demo with AGENT_MODE=cached and no AI key. A recording is found by a
 * hash of its schema, its system prompt and its prompt — so changing a system
 * prompt silently orphans every recording made with the old one, and the
 * cached demo's workers then "could not reach their model". That happened on
 * 2026-10-08, after the triage prompt was edited. This fails instead.
 */
const SYSTEMS: [string, string][] = [
  ['Plan', PLANNER_SYSTEM],
  ['Selection', SELECTOR_SYSTEM],
  ['Verdict', JUDGE_SYSTEM],
  ['Synthesis', SYNTHESIS_SYSTEM],
  ['TriageDecision', TRIAGE_SYSTEM],
  ['Result', WORKER_SYSTEM],
];

const load = (name: string): Record<string, {fullPrompt: string}> =>
  JSON.parse(readFileSync(new URL(`../../../.agent-cache/${name}.json`, import.meta.url), 'utf8'));

describe('the committed model recordings', () => {
  for (const file of ['orchestrator', 'worker']) {
    it(`${file}: every recording is still reachable with today's prompts`, async () => {
      const cache = load(file);
      const entries = Object.entries(cache);
      expect(entries.length).toBeGreaterThan(0);
      const stale: string[] = [];
      for (const [key, entry] of entries) {
        let found = false;
        for (const [schemaName, system] of SYSTEMS) {
          const k = await cacheKey({schemaName, system, prompt: entry.fullPrompt} as Parameters<
            typeof cacheKey
          >[0]);
          if (k === key) {
            found = true;
            break;
          }
        }
        if (!found) stale.push(`${key} (${entry.fullPrompt.slice(0, 60).replace(/\s+/g, ' ')}…)`);
      }
      // A prompt changed: re-key the recordings (or re-record) — see PROGRESS.
      expect(stale).toEqual([]);
    });
  }
});
