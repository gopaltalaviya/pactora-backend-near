import {secp256k1} from '@noble/curves/secp256k1';
import {
  keccak256,
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  type Hex,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {describe, expect, it} from 'vitest';
import {KmsKeySource, kmsAccount, parseDerSignature, type KmsClient} from '../src/kms.js';

/**
 * A KMS stand-in that does what AWS KMS does: holds the key, returns a DER
 * SubjectPublicKeyInfo and DER signatures of the digest it is given, with no
 * recovery id — and, like KMS, does not promise a low `s`.
 */
const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';
const N = secp256k1.CURVE.n;

function fakeKms(
  keys: Record<string, Hex>,
  opts: {highS?: boolean; wrongKey?: Hex} = {},
): KmsClient & {calls: number} {
  const fake = {
    calls: 0,
    async getPublicKey(keyId: string) {
      const pub = secp256k1.getPublicKey(keys[keyId]!.slice(2), false);
      return Uint8Array.from(Buffer.concat([Buffer.from(SPKI_PREFIX, 'hex'), Buffer.from(pub)]));
    },
    async sign(keyId: string, digest: Uint8Array) {
      fake.calls++;
      expect(digest.length).toBe(32);
      const key = (opts.wrongKey ?? keys[keyId]!).slice(2);
      const sig = secp256k1.sign(digest, key, {lowS: true});
      const out = opts.highS ? new secp256k1.Signature(sig.r, N - sig.s) : sig;
      return out.toDERRawBytes();
    },
  };
  return fake;
}

const KEY_A: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const KEY_B: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const ADDR_A = privateKeyToAccount(KEY_A).address;
const ADDR_B = privateKeyToAccount(KEY_B).address;

const TX = {
  chainId: 143,
  type: 'eip1559',
  nonce: 7,
  to: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  data: '0xdeadbeef',
  gas: 300_000n,
  maxFeePerGas: 200_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  value: 0n,
} as const;

describe('kmsAccount', () => {
  it('derives the address from the KMS public key', async () => {
    const account = await kmsAccount(fakeKms({a: KEY_A}), 'a');
    expect(account.address).toBe(ADDR_A);
  });

  it('signs a transaction the chain attributes to that address', async () => {
    const account = await kmsAccount(fakeKms({a: KEY_A}), 'a');
    const raw = await account.signTransaction(TX);
    expect(await recoverTransactionAddress({serializedTransaction: raw as never})).toBe(ADDR_A);
    expect(parseTransaction(raw)).toMatchObject({nonce: 7, chainId: 143, data: '0xdeadbeef'});
  });

  it('produces the same transaction a local key would', async () => {
    const kms = await kmsAccount(fakeKms({a: KEY_A}), 'a');
    // RFC 6979 is deterministic, so the same key and digest give the same bytes.
    expect(await kms.signTransaction(TX)).toBe(await privateKeyToAccount(KEY_A).signTransaction(TX));
  });

  it('turns a high-s KMS signature into the low-s one Ethereum accepts', async () => {
    const account = await kmsAccount(fakeKms({a: KEY_A}, {highS: true}), 'a');
    const raw = await account.signTransaction(TX);
    const {s} = parseTransaction(raw) as {s: Hex};
    expect(BigInt(s) <= N / 2n).toBe(true);
    expect(await recoverTransactionAddress({serializedTransaction: raw as never})).toBe(ADDR_A);
  });

  it('signs messages and typed data (ERC-1271 / owner challenges)', async () => {
    const account = await kmsAccount(fakeKms({a: KEY_A}), 'a');
    const message = 'pactora re-issue challenge 42';
    expect(await recoverMessageAddress({message, signature: await account.signMessage({message})})).toBe(
      ADDR_A,
    );
    const typed = {
      domain: {name: 'Pactora', version: '1', chainId: 143},
      types: {Grant: [{name: 'key', type: 'address'}]},
      primaryType: 'Grant',
      message: {key: ADDR_B},
    } as const;
    expect(await recoverTypedDataAddress({...typed, signature: await account.signTypedData(typed)})).toBe(
      ADDR_A,
    );
  });

  it('refuses a signature that is not from its own key', async () => {
    const account = await kmsAccount(fakeKms({a: KEY_A}, {wrongKey: KEY_B}), 'a');
    await expect(account.signTransaction(TX)).rejects.toThrow(/not from/);
  });
});

describe('KmsKeySource', () => {
  it('selects by agent id, then by wallet, and has nothing for anyone else', async () => {
    const keys = await KmsKeySource.create(fakeKms({a: KEY_A, b: KEY_B}), {'12': 'a', [ADDR_B]: 'b'});
    expect((await keys.accountFor(12))?.address).toBe(ADDR_A);
    expect((await keys.accountFor(99, ADDR_B.toLowerCase()))?.address).toBe(ADDR_B);
    expect(await keys.accountFor(99, '0x' + '11'.repeat(20))).toBeNull();
    expect(await keys.accountFor(99)).toBeNull();
    expect(
      keys
        .all()
        .map((a) => a.address)
        .sort(),
    ).toEqual([ADDR_A, ADDR_B].sort());
    expect(keys.kind).toBe('aws-kms');
  });

  it('refuses an address entry whose KMS key is a different address', async () => {
    await expect(KmsKeySource.create(fakeKms({a: KEY_A}), {[ADDR_B]: 'a'})).rejects.toThrow(/not 0x/);
  });

  it('refuses an entry that is neither an id nor an address', async () => {
    await expect(KmsKeySource.create(fakeKms({a: KEY_A}), {alice: 'a'})).rejects.toThrow(/neither/);
  });
});

describe('parseDerSignature', () => {
  it('reads r and s, including a leading zero byte', async () => {
    const sig = secp256k1.sign(keccak256('0x01').slice(2), KEY_A.slice(2));
    expect(parseDerSignature(sig.toDERRawBytes())).toEqual({r: sig.r, s: sig.s});
  });

  it('refuses what is not a DER signature', () => {
    expect(() => parseDerSignature(Uint8Array.from([0x31, 0x02, 0x02, 0x00]))).toThrow(/malformed/);
  });
});
