import type {FastifyInstance} from 'fastify';
import {and, eq} from 'drizzle-orm';
import {agentCapabilities, jobs, type Db} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import {authenticatePerson} from '../auth.js';
import {personAgentOf} from '../actor.js';
import {feeOf} from '../fees.js';

/**
 * A signed-in person's overview (docs/26 F3): who they are and what they
 * have earned.
 *
 * Earnings count SETTLED jobs only — money the contract released, not money
 * promised. `receivedBaseUnits` is what reached the worker: each job's
 * amount less the protocol fee, which the contract takes from the payout
 * (the indexer's recorded fee, or the same formula when it has not recorded
 * one yet). `spentBaseUnits` is what settled jobs cost the person as a
 * client: the amount, no fee on top. Neither is a wallet balance.
 */
export interface MeRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
}

export async function registerMeRoutes(app: FastifyInstance, deps: MeRouteDeps): Promise<void> {
  const {db, chains} = deps;

  app.get('/v1/me', async (request) => {
    const caller = await authenticatePerson(db, request);
    const chain = chains[caller.chainId];
    const person = await personAgentOf(db, caller.account, caller.chainId);
    const empty = {settledCount: 0, receivedBaseUnits: '0'};
    if (!person) {
      return {
        account: caller.account,
        chainId: caller.chainId,
        person: null,
        earnings: empty,
        spentBaseUnits: '0',
      };
    }

    const [asWorker, asClient, caps] = await Promise.all([
      db
        .select({amount: jobs.amount, fee: jobs.fee})
        .from(jobs)
        .where(and(eq(jobs.workerAgentId, person.id), eq(jobs.state, 'settled'))),
      db
        .select({amount: jobs.amount})
        .from(jobs)
        .where(and(eq(jobs.clientAgentId, person.id), eq(jobs.state, 'settled'))),
      db
        .select({capability: agentCapabilities.capability})
        .from(agentCapabilities)
        .where(eq(agentCapabilities.agentId, person.id)),
    ]);
    const received = asWorker.reduce((sum, j) => {
      const amount = BigInt(j.amount);
      const fee = j.fee !== null ? BigInt(j.fee) : chain ? feeOf(amount, chain.params) : 0n;
      return sum + (amount > fee ? amount - fee : 0n);
    }, 0n);
    const spent = asClient.reduce((sum, j) => sum + BigInt(j.amount), 0n);

    return {
      account: caller.account,
      chainId: caller.chainId,
      person: {
        publicId: person.publicId,
        agentId: String(person.id),
        chainAgentId: person.chainAgentId,
        name: person.name,
        description: person.description,
        location: person.location,
        capabilities: caps.map((c) => c.capability),
      },
      earnings: {settledCount: asWorker.length, receivedBaseUnits: received.toString()},
      spentBaseUnits: spent.toString(),
    };
  });
}
