import type {FastifyInstance} from 'fastify';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {ChainConfig} from '@pactora/config';
import type {Db} from '@pactora/db';
import {jobTitleOf} from '../read-model.js';

/**
 * Public receipts (2026-11-11): the most recent jobs settled on chain
 * between two AGENTS, newest first, each with what a judge needs to check it
 * without an API key: who hired whom, for what, the spec and result hashes,
 * and the transactions. The full receipt is `GET /v1/jobs/:id`.
 *
 * Only agent-to-agent jobs. A person's jobs never appear here, published
 * profile or not: a person's record is shown only as their profile chooses
 * (the 917b232 rule), and a feed that names counterparties would go further
 * than that.
 */

export const ReceiptsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  chainId: z.string().max(64).optional(),
});

interface Row {
  public_id: string;
  chain_id: string;
  chain_job_id: string | null;
  path: 'escrow' | 'direct';
  amount: string;
  spec: unknown;
  spec_hash: string;
  result_hash: string | null;
  settled_at: Date | string;
  client_id: string;
  client_name: string;
  worker_id: string;
  worker_name: string;
  tx_count: string | number;
  settle_tx: string | null;
  judged: boolean;
}

export async function registerReceiptRoutes(
  app: FastifyInstance,
  deps: {db: Db; chains: Record<string, ChainConfig>},
): Promise<void> {
  const {db, chains} = deps;

  app.get('/v1/receipts', async (request) => {
    const {limit, chainId} = ReceiptsQuery.parse(request.query ?? {});
    const enabled = Object.keys(chains);
    const wanted = chainId ? enabled.filter((c) => c === chainId) : enabled;
    if (wanted.length === 0) return {count: 0, receipts: []};

    const rows = (await db.execute(sql`
      SELECT j.public_id, j.chain_id, j.chain_job_id, j.path, j.amount, j.spec, j.spec_hash,
             j.result_hash, j.settled_at,
             c.id AS client_id, c.name AS client_name, w.id AS worker_id, w.name AS worker_name,
             (SELECT count(*) FROM job_events e WHERE e.job_id = j.id AND e.tx_hash IS NOT NULL) AS tx_count,
             (SELECT e.tx_hash FROM job_events e WHERE e.job_id = j.id AND e.tx_hash IS NOT NULL
               ORDER BY e.id DESC LIMIT 1) AS settle_tx,
             EXISTS (SELECT 1 FROM job_events e WHERE e.job_id = j.id AND e.kind = 'job.settled'
                      AND e.payload ? 'judge') AS judged
        FROM jobs j
        JOIN agents c ON c.id = j.client_agent_id AND c.kind = 'agent'
        JOIN agents w ON w.id = j.worker_agent_id AND w.kind = 'agent'
       WHERE j.state = 'settled' AND j.settled_at IS NOT NULL
         AND j.chain_id IN (${sql.join(
           wanted.map((c) => sql`${c}`),
           sql`, `,
         )})
       ORDER BY j.settled_at DESC, j.id DESC
       LIMIT ${limit}`)) as unknown as Row[];

    return {
      count: rows.length,
      receipts: rows.map((r) => {
        const chain = chains[r.chain_id]!;
        return {
          jobId: r.public_id,
          chainJobId: r.chain_job_id,
          chainId: r.chain_id,
          network: chain.name,
          path: r.path,
          title: jobTitleOf(r.spec),
          amount: r.amount,
          amountDisplay: chain.formatToken(BigInt(r.amount)),
          client: {agentId: String(r.client_id), name: r.client_name},
          worker: {agentId: String(r.worker_id), name: r.worker_name},
          specHash: r.spec_hash,
          resultHash: r.result_hash,
          settledAt: new Date(r.settled_at).toISOString(),
          transactions: Number(r.tx_count),
          settleExplorerUrl: r.settle_tx ? chain.explorerTx(r.settle_tx) : null,
          /** The settling approval carried a NEAR AI judge's attestation (shown on GET /v1/jobs/:id). */
          judged: Boolean(r.judged),
        };
      }),
    };
  });
}
