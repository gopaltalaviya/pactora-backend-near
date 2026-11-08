import type {FastifyRequest} from 'fastify';
import {and, asc, eq} from 'drizzle-orm';
import {agents, type Db} from '@pactora/db';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {authenticateCaller, type AgentCaller, type PersonCaller} from './auth.js';

/**
 * The on-chain agent a request acts as (docs/26 F2).
 *
 * An agent key names its agent. A person's session names an account, and the
 * account acts through its person agent — the `agents` row of kind `person`
 * whose owner (= wallet) is the account, on the session's chain. Everything
 * the protocol knows about a party is keyed by that agent, so routes either
 * kind may call work on `agent` alone and ask `via` only where the two differ:
 * who signs (the signer for an agent, the browser for a person).
 */
export type AgentRow = typeof agents.$inferSelect;

export interface Actor {
  via: 'agent' | 'person';
  agent: AgentRow;
  chainId: string;
  caller: AgentCaller | PersonCaller;
}

/** The person agent of a signed-in account on a chain, if it registered one (POST /v1/people). */
export async function personAgentOf(db: Db, account: string, chainId: string): Promise<AgentRow | undefined> {
  return db.query.agents.findFirst({
    where: and(eq(agents.chainId, chainId), eq(agents.kind, 'person'), eq(agents.ownerAddress, account)),
    orderBy: [asc(agents.id)],
  });
}

/** Authenticate either credential; a person without a person agent is refused, saying how to get one. */
export async function actorOf(db: Db, request: FastifyRequest): Promise<Actor> {
  const actor = await actorFor(db, await authenticateCaller(db, request));
  if ('account' in actor) {
    throw new PactoraError(
      ErrorCode.FORBIDDEN,
      `${actor.account} has no person agent on ${actor.chainId} — register on chain, then POST /v1/people`,
    );
  }
  return actor;
}

/** The actor behind an authenticated caller, or the person's caller itself when it has no person agent. */
async function actorFor(db: Db, caller: AgentCaller | PersonCaller): Promise<Actor | PersonCaller> {
  if (caller.kind === 'agent') {
    const agent = await db.query.agents.findFirst({where: eq(agents.id, caller.agentId)});
    if (!agent) throw new PactoraError(ErrorCode.UNAUTHORIZED, 'the key belongs to a deleted agent');
    return {via: 'agent', agent, chainId: caller.chainId, caller};
  }
  const agent = await personAgentOf(db, caller.account, caller.chainId);
  return agent ? {via: 'person', agent, chainId: caller.chainId, caller} : caller;
}

/**
 * The bearer, if any was sent, for routes that are public but say more to a
 * known caller. A bad credential is still refused (401); a signed-in person
 * who has no person agent yet is a party to nothing, and sees what anyone
 * sees — refusing them (403) hid every listing from a new user.
 */
export async function optionalActorOf(db: Db, request: FastifyRequest): Promise<Actor | null> {
  if (!request.headers.authorization) return null;
  const actor = await actorFor(db, await authenticateCaller(db, request));
  return 'account' in actor ? null : actor;
}
