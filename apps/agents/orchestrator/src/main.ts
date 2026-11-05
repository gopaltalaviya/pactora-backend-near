import {PactoraClient} from '@pactora/sdk';
import {
  Orchestrator,
  assertNoLegacyEnv,
  buildBrain,
  describeBrain,
  type OrchestratorEvent,
} from '@pactora/agent-core';

/**
 * orchestrator — the client side, as a process.
 *
 *   node dist/main.js "find the deepest ETH/USDC venue on Monad and tell me whether to trade"
 *
 * Prints the trace as it happens. Every on-chain action carries its explorer
 * link on the line where it happens, because a payment nobody can verify is
 * indistinguishable from a console.log.
 */

const goal = process.argv.slice(2).join(' ').trim();
if (!goal) {
  process.stderr.write('usage: orchestrator "<what you want done>"\n');
  process.exit(1);
}

try {
  assertNoLegacyEnv();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

const apiKey = process.env['PACTORA_API_KEY'];
if (!apiKey) {
  process.stderr.write('PACTORA_API_KEY is not set — register this agent and export its key\n');
  process.exit(1);
}

const client = new PactoraClient({
  baseUrl: process.env['PACTORA_API_URL'] ?? 'http://127.0.0.1:8080',
  apiKey,
  ...(process.env['PACTORA_CHAIN_ID'] ? {chainId: process.env['PACTORA_CHAIN_ID']} : {}),
});

const brain = buildBrain({role: 'orchestrator'});
const network = await client.network();
const budget = await client.budget();

console.log(`\nPactora orchestrator — ${network.name}${network.testnet ? ' (testnet)' : ' — REAL FUNDS'}`);
console.log(`  brain    ${await describeBrain(brain)}`);
console.log(`  budget   ${budget.dailyRemainingDisplay} today, ${budget.maxSingleSpendDisplay} per hire`);
console.log(`  goal     ${goal}\n`);

const orchestrator = new Orchestrator({client, brain, log: print});
const report = await orchestrator.run(goal);

console.log(`\n── result ──`);
for (const [i, step] of report.steps.entries()) {
  const line = `  ${i + 1}. ${step.capability}: ${step.status} — ${step.detail}`;
  console.log(step.explorerUrl ? `${line}\n     ${step.explorerUrl}` : line);
}
console.log(`\n  spent ${report.spent} base units across ${report.steps.length} step(s)\n`);

if (report.answer) console.log(`${report.answer}\n`);

// A run where nothing settled is not a crash, but it is not a success either,
// and a demo script needs to be able to tell the difference.
process.exit(report.delivered ? 0 : 2);

function print(event: OrchestratorEvent): void {
  switch (event.kind) {
    case 'planned':
      return console.log(`  plan      ${event.subtasks} subtask(s) — ${event.reasoning}`);
    case 'plan-failed':
      return console.log(`  plan      FAILED — ${event.reason}`);
    case 'discovered':
      return console.log(`  discover  ${event.capability}: ${event.candidates} candidate(s)`);
    case 'excluded':
      return console.log(`  exclude   agent ${event.agentId}: ${event.verdict} — ${event.reason}`);
    case 'selected':
      return console.log(`  select    agent ${event.agentId} at ${event.price} — ${event.reason}`);
    case 'hired':
      return console.log(
        `  hire      job ${event.jobId} for ${event.amount}\n            ${event.explorerUrl}`,
      );
    case 'judged':
      return console.log(
        `  judge     job ${event.jobId}: ${event.accept ? 'accept' : 'reject'} (quality ${event.quality})` +
          (event.injectionAttempted ? '  ⚠ INJECTION ATTEMPT IN RESULT' : ''),
      );
    case 'settled':
      return console.log(`  settle    job ${event.jobId} paid\n            ${event.explorerUrl}`);
    case 'disputed':
      return console.log(`  dispute   job ${event.jobId}: ${event.reason}`);
    case 'retrying':
      return console.log(`  retry     job ${event.jobId}: ${event.reason} — asking another agent`);
    case 'skipped':
      return console.log(`  skip      ${event.capability}: ${event.status} — ${event.detail}`);
  }
}
