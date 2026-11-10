import type {FastifyInstance} from 'fastify';
import {and, asc, eq, inArray} from 'drizzle-orm';
import {agentCapabilities, agents, jobs, type Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import type {ChainConfig} from '@pactora/config';
import {authenticateCaller, authenticatePerson} from '../auth.js';
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

  /**
   * The agents the caller's account owns on its chain, its person agent
   * included: a session's account, or the owner of a key's agent. What the
   * site's "my agents" switcher lists.
   */
  app.get('/v1/me/agents', async (request) => {
    const caller = await authenticateCaller(db, request);
    let owner: string;
    if (caller.kind === 'agent') {
      const me = await db.query.agents.findFirst({where: eq(agents.id, caller.agentId)});
      if (!me) throw new PactoraError(ErrorCode.UNAUTHORIZED, 'the key belongs to a deleted agent');
      owner = me.ownerAddress;
    } else {
      owner = caller.account;
    }
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.chainId, caller.chainId), eq(agents.ownerAddress, owner)))
      .orderBy(asc(agents.id));
    const caps =
      rows.length === 0
        ? []
        : await db
            .select()
            .from(agentCapabilities)
            .where(
              inArray(
                agentCapabilities.agentId,
                rows.map((r) => r.id),
              ),
            )
            .orderBy(asc(agentCapabilities.capability));
    return {
      agents: rows.map((a) => ({
        agentId: String(a.id),
        chainAgentId: a.chainAgentId,
        name: a.name,
        kind: a.kind,
        active: a.active,
        capabilities: caps.filter((c) => c.agentId === a.id).map((c) => c.capability),
        pricePerTask: a.pricePerTask,
      })),
    };
  });
}
