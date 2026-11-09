import type {ChainConfig} from '@pactora/config';
import {signFunctionCallWith, TGAS, type NearClient, type SignedTx, type TxOutcome} from '@pactora/near';
import {ErrorCode, PactoraError} from '@pactora/shared';
import type {ServiceAccount} from './keysource.js';
import {refusalOf} from './signer.js';

/**
 * The test-token faucet's sender (docs/26 F23), testnet and sandbox only.
 *
 * It holds the key of a SEPARATE faucet account that carries a limited float
 * of the payment token — never the token owner's key, which could mint
 * without limit. The API decides who may claim and how often (per account,
 * per IP, per day, and a global cap); this side refuses anything above its
 * own per-send cap, so a bug or a compromise of the API cannot empty the
 * float faster than the cap allows.
 *
 * A receiver the token does not know yet is registered first (NEP-145
 * `storage_deposit`, paid from the faucet's NEAR), because `ft_transfer` to
 * an unregistered account fails.
 */

export interface FaucetSendResult {
  txHash: string;
  registered: boolean;
}

export interface Faucet {
  accountId: string;
  maxPerSend: bigint;
  send(receiverId: string, amount: bigint): Promise<FaucetSendResult>;
}

/**
 * The faucet account must not be the payment token's owner — that key could
 * mint without limit. Read from the chain at start. An RPC failure REFUSES
 * to start (audit L5): the guard used to be skipped when the owner could not
 * be read, which is the one case where nothing had been checked.
 */
export async function assertFaucetNotOwner(
  near: Pick<NearClient, 'view'>,
  chain: ChainConfig,
  faucet: Pick<ServiceAccount, 'accountId'>,
): Promise<void> {
  let owner: string;
  try {
    owner = await near.view<string>(chain.contracts.PaymentToken, 'owner', {});
  } catch (err) {
    throw new Error(
      `could not read the payment token's owner from ${chain.contracts.PaymentToken} ` +
        `(${err instanceof Error ? err.message : String(err)}) — the faucet guard cannot run; refusing to start`,
    );
  }
  if (owner === faucet.accountId) {
    throw new Error(
      `FAUCET_ACCOUNT_ID ${faucet.accountId} is the payment token's owner — use a separate account holding a limited float`,
    );
  }
}

/** Only one send at a time: the nonce high-water mark below assumes it. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

export function makeFaucet(opts: {
  near: NearClient;
  chain: ChainConfig;
  account: ServiceAccount;
  maxPerSend: bigint;
}): Faucet {
  const {near, chain, account, maxPerSend} = opts;
  if (!chain.testnet) throw new Error('the faucet runs on testnet or the sandbox only');
  const token = chain.contracts.PaymentToken;
  const once = serial();
  let last = 0n;

  async function sendCall(method: string, args: Record<string, unknown>, deposit: bigint): Promise<string> {
    const access = await near.accessKey(account.accountId, account.key.publicKey);
    if (!access)
      throw new Error(`the faucet account ${account.accountId} has no key ${account.key.publicKey}`);
    const nonce = (access.nonce > last ? access.nonce : last) + 1n;
    last = nonce;
    const block = await near.finalBlock();
    const signed: SignedTx = await signFunctionCallWith({
      signerId: account.accountId,
      key: account.key,
      receiverId: token,
      nonce,
      blockHash: block.hash,
      method,
      args,
      gas: 30n * TGAS,
      deposit,
    });
    const outcome: TxOutcome = await near.sendSigned(signed);
    if (outcome.status === 'failure') throw refusalOf(outcome.failure ?? '', signed.hash);
    if (outcome.status !== 'success')
      throw new Error(`${method} sent as ${signed.hash}, outcome not known yet`);
    return signed.hash;
  }

  return {
    accountId: account.accountId,
    maxPerSend,
    send: (receiverId, amount) =>
      once(async () => {
        if (amount <= 0n || amount > maxPerSend) {
          throw new PactoraError(
            ErrorCode.BUDGET_EXCEEDED,
            `the faucet sends at most ${maxPerSend} base units at a time`,
          );
        }
        if (receiverId === account.accountId) {
          throw new PactoraError(ErrorCode.SCHEMA_MISMATCH, 'the faucet does not pay itself');
        }
        let registered = false;
        const storage = await near.view<unknown>(token, 'storage_balance_of', {account_id: receiverId});
        if (storage === null || storage === undefined) {
          const bounds = await near.view<{min: string}>(token, 'storage_balance_bounds', {});
          await sendCall(
            'storage_deposit',
            {account_id: receiverId, registration_only: true},
            BigInt(bounds.min),
          );
          registered = true;
        }
        const txHash = await sendCall(
          'ft_transfer',
          {receiver_id: receiverId, amount: amount.toString(), memo: 'pactora test faucet'},
          1n,
        );
        return {txHash, registered};
      }),
  };
}
