import type {FastifyInstance} from 'fastify';
import {KeyPair, signNep413} from '@pactora/near';
import type {PactoraConfig} from '@pactora/config';
import type {IdentityReading, IdentityReader} from '../../src/chain-reads.js';
import {DEFAULT_SIGN_RECIPIENT, makeOwnerVerifier, type OwnerVerifier} from '../../src/challenges.js';
import type {WalletKeys} from '../../src/routes/agents.js';

/**
 * Registering as a real registrant does (audit M1, docs/NEAR-WIRE.md §5): the
 * agent exists on chain, the owner asks for a challenge, signs it with NEP-413
 * using a FULL-ACCESS key, and registers with the signature.
 *
 * Tests name accounts with `addr(label)`: the same label is the same NEAR
 * account in a test file, and this helper holds its full-access key. An owner
 * it holds no key for is posted unsigned, so a test of some other validation
 * still sees a 422.
 *
 * The chain is a fake — an in-memory registry and access-key table — but the
 * signature check is the real one (`makeOwnerVerifier`, near-api-js's
 * NEP-413 verification). Tests that need a different chain pass their own
 * `readIdentity`.
 */

const keys = new Map<string, KeyPair>();

/** The on-chain registry, as the fake chain has it: contract agent id → agent. */
export const registry = new Map<bigint, IdentityReading>();
let nextChainAgentId = 1000n;

/** Wallets the fake signer accepted (`POST /keys/accept`). */
export const accepted: {chainId: string; walletAddress: string; chainAgentId: string}[] = [];

/** A NEAR test account whose full-access key this helper holds. */
export function addr(label: string): string {
  const name =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x';
  const account = `t-${name}.test.near`;
  if (!keys.has(account)) keys.set(account, KeyPair.fromRandom('ed25519'));
  return account;
}

/** The full-access key behind an `addr()` account. */
export function keyOf(account: string): KeyPair {
  const key = keys.get(account);
  if (!key) throw new Error(`no test key for ${account} — name it with addr()`);
  return key;
}

/** Put an agent on the fake chain; answers its contract agent id. */
export function onChain(agent: Partial<IdentityReading> & {owner: string; wallet?: string | null}): string {
  const id = nextChainAgentId++;
  registry.set(id, {
    owner: agent.owner,
    wallet: agent.wallet === undefined ? null : agent.wallet,
    pendingWallet: agent.pendingWallet ?? null,
    frozen: agent.frozen ?? false,
  });
  return String(id);
}

/** Accounts whose `addr()` key the fake chain holds as a FUNCTION-CALL key, like an agent's. */
export const functionCallOnly = new Set<string>();

/**
 * Real NEP-413 verification against the fake access-key table: every `addr()`
 * key is full access, unless its account is in `functionCallOnly`.
 */
export function fakeOwnerVerifier(config: PactoraConfig): OwnerVerifier {
  return makeOwnerVerifier(config, DEFAULT_SIGN_RECIPIENT, () => ({
    accessKey: async (accountId: string, publicKey: string) => {
      if (keys.get(accountId)?.getPublicKey().toString() !== publicKey) return null;
      return functionCallOnly.has(accountId)
        ? {
            nonce: 1n,
            permission: {FunctionCall: {receiver_id: 'pactora.test.near', method_names: [], allowance: null}},
          }
        : {nonce: 1n, permission: 'FullAccess' as const};
    },
  }));
}

/** Sign a challenge the way the owner's wallet would (NEP-413), as `account`. */
export async function signChallenge(
  account: string,
  challenge: {message: string; nonce: string},
  as = account,
) {
  const signed = await signNep413({
    accountId: as,
    keyPair: keyOf(account),
    message: challenge.message,
    recipient: DEFAULT_SIGN_RECIPIENT,
    nonce: new Uint8Array(Buffer.from(challenge.nonce, 'hex')),
  });
  return {publicKey: signed.publicKey, signature: signed.signature};
}

export const fakeReadIdentity: IdentityReader = async ({chainAgentId}) => registry.get(chainAgentId) ?? null;

export const fakeWalletKeys: WalletKeys = {
  publicKeyFor: async () => 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp',
  accept: async (args) => {
    const agent = registry.get(BigInt(args.chainAgentId));
    if (agent && agent.pendingWallet === args.walletAddress) {
      agent.wallet = args.walletAddress;
      agent.pendingWallet = null;
    }
    accepted.push(args);
    return {txHash: 'AcceptTx1111111111111111111111111111111111111', alreadyAccepted: false};
  },
};

/** The chain-facing deps every test app needs: spread into `buildApp`. */
export function chainDeps(config: PactoraConfig) {
  return {verifyOwner: fakeOwnerVerifier(config), readIdentity: fakeReadIdentity, walletKeys: fakeWalletKeys};
}

export async function signedRegistration(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  opts: {remoteAddress?: string; ownerKey?: KeyPair; signAs?: string} = {},
) {
  const inject = (url: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url,
      payload: body,
      ...(opts.remoteAddress ? {remoteAddress: opts.remoteAddress} : {}),
    });

  const ownerAddress = String(payload['ownerAddress']);
  const owner = opts.ownerKey ?? keys.get(ownerAddress);
  // No chainAgentId given: the agent is put on chain first, as the owner's wallet would.
  const withId =
    payload['chainAgentId'] !== undefined || typeof payload['walletAddress'] !== 'string'
      ? payload
      : {...payload, chainAgentId: onChain({owner: ownerAddress, wallet: String(payload['walletAddress'])})};
  if (!owner) return inject('/v1/agents', withId);

  const challenge = await inject('/v1/agents/challenge', {
    ownerAddress: withId['ownerAddress'],
    walletAddress: withId['walletAddress'],
    chainAgentId: withId['chainAgentId'],
    ...(withId['chainId'] !== undefined ? {chainId: withId['chainId']} : {}),
  });
  if (challenge.statusCode !== 200) return challenge;
  const {nonce, message, recipient} = challenge.json() as {nonce: string; message: string; recipient: string};

  const signed = await signNep413({
    accountId: opts.signAs ?? ownerAddress,
    keyPair: owner,
    message,
    recipient,
    nonce: new Uint8Array(Buffer.from(nonce, 'hex')),
  });
  return inject('/v1/agents', {...withId, nonce, publicKey: signed.publicKey, signature: signed.signature});
}
