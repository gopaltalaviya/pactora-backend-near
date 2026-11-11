/**
 * NEAR helpers for the scripts (demo, live checks): accounts, the owner's two
 * registration transactions, token funding. near-api-js 7.4, the same library
 * the services use (through @pactora/near).
 *
 * Testnet and the local sandbox only: `rootAccount` refuses anything else.
 */
import {readFileSync} from 'node:fs';
import {Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions, nearToYocto} from 'near-api-js';

export const TGAS = 1_000_000_000_000n;
export {KeyPair, nearToYocto};

/**
 * The account that pays for the run: on the sandbox its root (`test.near`,
 * key from the sandbox's validator_key.json); on testnet the deployer from
 * .env. Never mainnet.
 */
/**
 * Free testnet RPCs to fall back to when the primary answers "rate limits
 * exceeded" (FastNEAR's free tier does, under a full demo run: 2026-11-11).
 * dRPC and NEAR's own endpoint both answered chain_id "testnet" that day.
 */
const TESTNET_FALLBACK_RPCS = ['https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'];
const RATE_LIMITED = /-429|rate limit|too many requests/i;
/** The error's words for the rate-limit test; never throws (errors can carry BigInts). */
const describe = (err) => {
  let body = '';
  try {
    body = JSON.stringify(err ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    // unserialisable: the message alone decides
  }
  return `${err?.message ?? ''} ${body}`;
};

/**
 * A JsonRpcProvider that moves to the next URL only when the current one is
 * rate-limiting. Every other error, a contract refusal included, is thrown
 * as it came, so the checks that expect a refusal still read the node's own
 * words. (near-api-js's FailoverRpcProvider switches on any error.)
 */
class RateLimitRotatingProvider extends JsonRpcProvider {
  constructor(urls) {
    super({url: urls[0]});
    this.others = urls.slice(1).map((url) => new JsonRpcProvider({url}));
  }
  async sendJsonRpc(method, params) {
    try {
      return await super.sendJsonRpc(method, params);
    } catch (err) {
      if (!RATE_LIMITED.test(describe(err))) throw err;
      let last = err;
      for (const p of this.others) {
        try {
          return await p.sendJsonRpc(method, params);
        } catch (e) {
          if (!RATE_LIMITED.test(describe(e))) throw e;
          last = e;
        }
      }
      throw last;
    }
  }
}

export function providerFor(chain) {
  if (chain.chainId !== 'near:testnet') return new JsonRpcProvider({url: chain.rpcUrl});
  return new RateLimitRotatingProvider([...new Set([chain.rpcUrl, ...TESTNET_FALLBACK_RPCS])]);
}

export function rootAccount(chain, env = process.env) {
  const provider = providerFor(chain);
  let id;
  let secret;
  if (chain.chainId === 'near:sandbox') {
    if (!env.SANDBOX_KEY_FILE) throw new Error('SANDBOX_KEY_FILE must name the sandbox validator_key.json');
    const k = JSON.parse(readFileSync(env.SANDBOX_KEY_FILE, 'utf8'));
    id = k.account_id;
    secret = k.secret_key;
  } else if (chain.chainId === 'near:testnet') {
    id = env.DEPLOYER_ACCOUNT_ID;
    secret = env.DEPLOYER_SECRET_KEY;
    if (!id?.endsWith('.testnet') || !secret)
      throw new Error('DEPLOYER_ACCOUNT_ID (.testnet) and DEPLOYER_SECRET_KEY must be set');
  } else {
    throw new Error(`refusing ${chain.chainId}: scripts run on testnet or the local sandbox only`);
  }
  const keyPair = KeyPair.fromString(secret);
  return {id, keyPair, provider, account: new Account(id, provider, new KeyPairSigner(keyPair))};
}

/** Send one transaction and wait for finality; throws with the node's reason on failure. */
export async function send(account, receiverId, acts) {
  const out = await account.signAndSendTransaction({
    receiverId,
    actions: acts,
    waitUntil: 'FINAL',
    throwOnFailure: false,
  });
  if (typeof out.status === 'object' && 'Failure' in out.status) {
    throw new Error(`${receiverId}: ${JSON.stringify(out.status.Failure)} (tx ${out.transaction.hash})`);
  }
  const b64 = out.status.SuccessValue ?? '';
  const text = Buffer.from(b64, 'base64').toString('utf8');
  let value;
  try {
    value = text ? JSON.parse(text) : undefined;
  } catch {
    value = text;
  }
  return {value, hash: out.transaction.hash};
}

export const call = (account, contractId, method, args, {deposit = 0n, gas = 100n * TGAS} = {}) =>
  send(account, contractId, [actions.functionCall(method, args, gas, deposit)]);

export const view = (provider, contractId, method, args = {}) =>
  provider.callFunction({contractId, method, args, blockQuery: {finality: 'final'}});

/**
 * A sub-account of `parent` with a fresh full-access key: a person, in the demo.
 * `save(id, keyPair)` runs BEFORE the account is created, so a testnet run can
 * keep the key and sweep the account back (scripts/lib/throwaway.mjs).
 */
export async function createPerson(root, name, near = '3', {save} = {}) {
  const keyPair = KeyPair.fromRandom('ed25519');
  const id = `${name}.${root.id}`;
  save?.(id, keyPair);
  await send(root.account, id, [
    actions.createAccount(),
    actions.transfer(nearToYocto(near)),
    actions.addFullAccessKey(keyPair.getPublicKey()),
  ]);
  return {
    id,
    keyPair,
    provider: root.provider,
    account: new Account(id, root.provider, new KeyPairSigner(keyPair)),
  };
}

/**
 * A function-call-only account: its one key may call `contractId`, with no
 * deposit, within `allowance` of gas. What an agent wallet or the keeper is.
 */
export async function createScopedAccount(
  parent,
  id,
  publicKey,
  contractId,
  // 0.2 NEAR: no key can ever take back what a function-call-only account
  // holds. A call reserves its 100 Tgas at the pessimistic gas price up front
  // (about 0.101 NEAR); a whole demo burns under 0.003 per wallet.
  {near = '0.2', allowance = '0.25'} = {},
) {
  return send(parent.account, id, [
    actions.createAccount(),
    actions.transfer(nearToYocto(near)),
    actions.addFunctionCallAccessKey(
      PublicKey.from(String(publicKey)),
      contractId,
      [],
      nearToYocto(allowance),
    ),
  ]);
}

/**
 * The owner's registration (docs/NEAR-WIRE.md §5, step 2): the agent wallet
 * created with the signer's key scoped to Pactora, then `register_agent`.
 * Answers the contract agent id.
 */
export async function registerOnChain(owner, {wallet, walletPublicKey, pactora, cardUri}) {
  await createScopedAccount(owner, wallet, walletPublicKey, pactora);
  const r = await call(
    owner.account,
    pactora,
    'register_agent',
    {wallet, card_uri: cardUri},
    {deposit: nearToYocto('0.1')},
  );
  return String(r.value);
}

/** Register on the token (NEP-145) and mint, from the token's owner (the deployer). */
export async function mintTo(minter, token, account, amount) {
  const bounds = await view(minter.provider, token, 'storage_balance_bounds');
  await call(
    account.account,
    token,
    'storage_deposit',
    {account_id: account.id, registration_only: true},
    {deposit: BigInt(bounds.min)},
  );
  await call(minter.account, token, 'mint', {account_id: account.id, amount: String(amount)});
}

/** `ft_transfer_call` into Pactora: `{Fund: {agent_id}}` (spendable) or `{Stake: {agent_id}}`. */
export const deposit = (from, token, pactora, amount, msg) =>
  call(
    from.account,
    token,
    'ft_transfer_call',
    {receiver_id: pactora, amount: String(amount), msg: JSON.stringify(msg)},
    {deposit: 1n, gas: 150n * TGAS},
  );
