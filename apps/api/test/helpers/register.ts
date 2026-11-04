import type {FastifyInstance} from 'fastify';
import {keccak256, toHex} from 'viem';
import {privateKeyToAccount, type PrivateKeyAccount} from 'viem/accounts';

/**
 * Registering as a real registrant does (audit M1): ask for a challenge, sign
 * it as the owner — and as the wallet, when there is no ERC-8004 id and the
 * wallet is not the owner — and register with the signatures.
 *
 * Tests name addresses with `addr(label)`: the same label is the same address
 * on every run, and this helper holds its key. An owner it holds no key for
 * is posted unsigned, so a test of some other validation still sees a 422.
 */

const keys = new Map<string, PrivateKeyAccount>();

/** A test address whose key this helper holds. Lower-case, as the API stores it. */
export function addr(label: string): string {
  const account = privateKeyToAccount(keccak256(toHex(`pactora-test:${label}`)));
  keys.set(account.address.toLowerCase(), account);
  return account.address.toLowerCase();
}

/** The key behind an `addr()` address. */
export function keyOf(address: string): PrivateKeyAccount {
  const key = keys.get(address.toLowerCase());
  if (!key) throw new Error(`no test key for ${address} — name it with addr()`);
  return key;
}

export async function signedRegistration(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  opts: {remoteAddress?: string; ownerKey?: PrivateKeyAccount; walletKey?: PrivateKeyAccount} = {},
) {
  const inject = (url: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url,
      payload: body,
      ...(opts.remoteAddress ? {remoteAddress: opts.remoteAddress} : {}),
    });

  const owner = opts.ownerKey ?? keys.get(String(payload['ownerAddress']).toLowerCase());
  if (!owner) return inject('/v1/agents', payload);

  const challenge = await inject('/v1/agents/challenge', {
    ownerAddress: payload['ownerAddress'],
    walletAddress: payload['walletAddress'],
    ...(payload['chainId'] !== undefined ? {chainId: payload['chainId']} : {}),
    ...(payload['chainAgentId'] !== undefined ? {chainAgentId: payload['chainAgentId']} : {}),
  });
  if (challenge.statusCode !== 200) return challenge;
  const {nonce, message} = challenge.json() as {nonce: string; message: string};

  const wallet = opts.walletKey ?? keys.get(String(payload['walletAddress']).toLowerCase());
  const walletMustSign =
    payload['chainAgentId'] === undefined &&
    String(payload['walletAddress']).toLowerCase() !== owner.address.toLowerCase();

  return inject('/v1/agents', {
    ...payload,
    nonce,
    signature: await owner.signMessage({message}),
    ...(walletMustSign && wallet ? {walletSignature: await wallet.signMessage({message})} : {}),
  });
}
