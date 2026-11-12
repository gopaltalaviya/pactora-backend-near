import type {z} from 'zod';
import {PactoraClient} from '@pactora/sdk';
import {ChainId, X402Scheme, X402_SCHEME, assertNoUnsupportedEnv} from '@pactora/shared';
import {buildBrain} from './factory.js';
import {serveX402} from './x402.js';
import {Worker, type WorkerEvent} from './worker.js';

/**
 * The boilerplate every worker process shares.
 *
 * A bot should be its capability, its output schema and a sentence about what
 * it does — nothing else. Wiring, logging and shutdown are identical across
 * all of them, and repeating them three times is three places to get shutdown
 * subtly wrong.
 */

export interface RunWorkerConfig<T> {
  capability: string;
  role: string;
  output: z.ZodType<T>;
  env?: NodeJS.ProcessEnv;
  /** Overridable so a test can run the loop without a server. */
  client?: PactoraClient;
}

/** `WORKER_MAX_JOBS_PER_DAY`: a positive whole number, or unset for no cap. */
function maxJobsPerDay(raw: string | undefined): {maxJobsPerDay?: number} {
  if (raw === undefined || raw === '') return {};
  if (!/^[1-9]\d{0,5}$/.test(raw))
    throw new Error(`WORKER_MAX_JOBS_PER_DAY must be a positive whole number, not "${raw}"`);
  return {maxJobsPerDay: Number(raw)};
}

export async function runWorker<T>(config: RunWorkerConfig<T>): Promise<void> {
  const env = config.env ?? process.env;
  assertNoUnsupportedEnv(env);
  const apiKey = env['PACTORA_API_KEY'];

  if (!apiKey && !config.client) {
    throw new Error(
      `${config.capability}: PACTORA_API_KEY is not set — register this agent and export its key`,
    );
  }

  const client =
    config.client ??
    new PactoraClient({
      baseUrl: env['PACTORA_API_URL'] ?? 'http://127.0.0.1:8080',
      apiKey: apiKey!,
      ...(env['PACTORA_CHAIN_ID'] ? {chainId: env['PACTORA_CHAIN_ID']} : {}),
    });

  const worker = new Worker({
    client,
    brain: buildBrain({role: 'worker', env}),
    capability: config.capability,
    role: config.role,
    output: config.output,
    log: logEvent(config.capability),
    ...maxJobsPerDay(env['WORKER_MAX_JOBS_PER_DAY']),
  });

  // One controller for both signals: a demo that leaves three worker
  // processes running after Ctrl-C is a demo that fails its second rehearsal.
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => controller.abort());
  }
  // A rejection nobody awaited used to be logged by Node and ignored, leaving
  // a worker polling in a state nobody had reasoned about. Stop cleanly
  // instead; the platform restarts it.
  process.on('unhandledRejection', (err) => {
    log(
      `${config.capability}: unhandled rejection — stopping: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    controller.abort();
  });

  const network = await client.network().catch(() => null);
  log(
    `${config.capability} ready` +
      (network ? ` — ${network.name}${network.testnet ? ' (testnet)' : ' (REAL FUNDS)'}` : ''),
  );

  // Optional: a paid HTTP endpoint beside the job loop. Off unless asked for,
  // because it is a listening port, and a worker that only polls has none.
  const x402Port = env['X402_PORT'];
  if (x402Port) {
    const agentId = Number(env['PACTORA_AGENT_ID']);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      throw new Error(`${config.capability}: X402_PORT needs PACTORA_AGENT_ID — the id the facilitator pays`);
    }
    const [agent, net] = await Promise.all([client.getAgent(agentId), client.network()]);
    const token = net.paymentToken.accountId;
    if (!token) throw new Error(`${config.capability}: this network has no payment token`);
    const schemes = X402Scheme.array()
      .min(1)
      .parse((env['X402_SCHEMES'] ?? X402_SCHEME).split(',').map((s) => s.trim()));
    const server = await serveX402({
      worker,
      client,
      port: Number(x402Port),
      host: env['X402_HOST'] ?? '127.0.0.1',
      publicUrl: env['X402_PUBLIC_URL'] ?? `http://127.0.0.1:${x402Port}`,
      agentId,
      price: agent.pricePerTask,
      payTo: agent.walletAddress,
      asset: token,
      // CAIP-2: the x402 network is the chain id itself (docs/NEAR-WIRE.md §1).
      network: ChainId.parse(net.chainId),
      schemes,
      log: (e) => log(`x402 ${e.kind} ${JSON.stringify(e)}`),
    });
    log(`${config.capability} x402 endpoint at ${server.url} — ${agent.priceDisplay} a request`);
    controller.signal.addEventListener('abort', () => void server.close());
  }

  await worker.run({
    intervalMs: Number(env['WORKER_POLL_MS'] ?? 1_000),
    signal: controller.signal,
  });

  log(`${config.capability} stopped`);
}

/**
 * One line per event, on stderr.
 *
 * stderr because a worker may later be run as an MCP stdio server, where
 * stdout is the transport. Deciding that once, here, is cheaper than
 * discovering it during a demo.
 */
function logEvent(capability: string): (event: WorkerEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'offer':
        return log(`[${capability}] offer ${event.jobId}`);
      case 'declined':
        return log(
          `[${capability}] declined ${event.jobId} (${event.structural ? 'cannot produce' : 'judgement'}): ${event.reason}`,
        );
      case 'accepted':
        return log(`[${capability}] accepted ${event.jobId}`);
      case 'delivered':
        return log(`[${capability}] delivered ${event.jobId} via ${event.provider} in ${event.latencyMs}ms`);
      case 'drafted':
        return log(
          `[${capability}] drafted ${event.jobId} round ${event.round} via ${event.provider} in ${event.latencyMs}ms`,
        );
      case 'retrying':
        return log(`[${capability}] retrying ${event.stage} of ${event.jobId}: ${event.reason}`);
      case 'failed':
        return log(`[${capability}] FAILED ${event.jobId} at ${event.stage}: ${event.reason}`);
    }
  };
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}
