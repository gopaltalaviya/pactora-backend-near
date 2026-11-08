import type {FastifyInstance} from 'fastify';
import {expect} from 'vitest';
import type {BudgetReading, TxEventsReading, TxEventsReader, BudgetReader} from '../../src/chain-reads.js';
import {addr, onChain, signChallenge, signedRegistration} from './register.js';

/**
 * People and agents for tests of the routes either may call, and a fake
 * chain for what a browser signs.
 *
 * A person signs in exactly as the site does (challenge → NEP-413 →
 * session) and records its on-chain agent with POST /v1/people; an agent
 * registers with its owner's signature. Both through the real routes.
 */

let ip = 0;
const nextIp = () => `10.70.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

export const bearer = (token: string) => ({authorization: `Bearer ${token}`});

/** A signed-in person with a person agent: their session token and agent ids. */
export async function person(
  app: FastifyInstance,
  label: string,
  opts: {location?: string; capabilities?: string[]} = {},
): Promise<{token: string; account: string; chainAgentId: string; publicId: string}> {
  const account = addr(label);
  const c = await app.inject({
    method: 'POST',
    url: '/v1/session/challenge',
    payload: {accountId: account},
    remoteAddress: nextIp(),
  });
  expect(c.statusCode).toBe(201);
  const challenge = c.json() as {nonce: string; message: string};
  const signed = await signChallenge(account, challenge);
  const s = await app.inject({
    method: 'POST',
    url: '/v1/session',
    payload: {accountId: account, nonce: challenge.nonce, ...signed},
    remoteAddress: nextIp(),
  });
  expect(s.statusCode).toBe(201);
  const token = (s.json() as {token: string}).token;
  const chainAgentId = onChain({owner: account, wallet: account});
  const p = await app.inject({
    method: 'POST',
    url: '/v1/people',
    headers: bearer(token),
    payload: {
      chainAgentId,
      name: label,
      ...(opts.location !== undefined ? {location: opts.location} : {}),
      ...(opts.capabilities ? {capabilities: opts.capabilities} : {}),
    },
  });
  expect(p.statusCode, p.body).toBe(201);
  return {token, account, chainAgentId, publicId: (p.json() as {publicId: string}).publicId};
}

/** A signed-in account with NO person agent. */
export async function sessionOnly(app: FastifyInstance, label: string): Promise<string> {
  const account = addr(label);
  const c = await app.inject({
    method: 'POST',
    url: '/v1/session/challenge',
    payload: {accountId: account},
    remoteAddress: nextIp(),
  });
  const challenge = c.json() as {nonce: string; message: string};
  const signed = await signChallenge(account, challenge);
  const s = await app.inject({
    method: 'POST',
    url: '/v1/session',
    payload: {accountId: account, nonce: challenge.nonce, ...signed},
    remoteAddress: nextIp(),
  });
  return (s.json() as {token: string}).token;
}

/** A registered agent: its API key, database id, wallet and contract agent id. */
export async function agent(
  app: FastifyInstance,
  label: string,
  over: Record<string, unknown> = {},
): Promise<{apiKey: string; agentId: number; wallet: string; chainAgentId: string}> {
  const wallet = addr(`${label}-wallet`);
  const owner = (over['ownerAddress'] as string | undefined) ?? addr(`${label}-owner`);
  const chainAgentId = onChain({owner, wallet});
  const res = await signedRegistration(app, {
    name: label,
    capabilities: ['market-research'],
    pricePerTask: '20000',
    walletAddress: wallet,
    ownerAddress: owner,
    chainAgentId,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as {agentId: number; apiKey: string};
  return {apiKey: body.apiKey, agentId: Number(body.agentId), wallet, chainAgentId};
}

/** The fake chain's purses, by wallet; anything not set is generous. */
export const purses = new Map<string, Partial<BudgetReading>>();

export const fakeReadBudget: BudgetReader = async ({walletAddress}) => {
  const p = purses.get(walletAddress);
  if (p === null) return null;
  return {
    perTaskCap: 100_000n,
    dailyCap: 1_000_000n,
    dailyRemaining: 1_000_000n,
    allowlistOnly: false,
    tokenBalance: 5_000_000n,
    nextReleaseAt: 0n,
    ...p,
  };
};

/** Transactions on the fake chain, by hash: what a browser-signed transaction did. */
export const txs = new Map<string, TxEventsReading>();
/** What each read asked for, so a test can see the signer the API looked up. */
export const txReads: {txHash: string; signerId: string}[] = [];

export const fakeReadTxEvents: TxEventsReader = async ({txHash, signerId}) => {
  txReads.push({txHash, signerId});
  return txs.get(txHash) ?? {status: 'pending'};
};

let txSeq = 0;
/** A fresh base58 transaction hash (43-44 chars, no 0/O/I/l). */
export function txHash(): string {
  const n = String(++txSeq).padStart(6, '1').replace(/0/g, 'z');
  return `Tx${'A'.repeat(36)}${n}`.slice(0, 44);
}

/** Put a successful transaction signed by `signerId` on the fake chain. */
export function onChainTx(
  hash: string,
  signerId: string,
  events: {event: string; data: Record<string, unknown>}[],
): string {
  txs.set(hash, {status: 'success', signerId, events: events as never});
  return hash;
}
