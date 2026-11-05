import {describe, expect, it} from 'vitest';
import {KeyPair, PublicKey, baseEncode, signFunctionCall, signFunctionCallWith, TGAS} from '@pactora/near';
import {KmsKeySource, kmsKey, nearPublicKeyOfSpki, type KmsClient} from '../src/kms.js';

/**
 * Keys that never leave AWS KMS: `ECC_NIST_EDWARDS25519`, signed with
 * `ED25519_SHA_512` over the RAW 32-byte transaction hash. The KMS here is a
 * double holding an ordinary ed25519 key, so what is tested is everything
 * this code does with KMS's answers — SPKI parsing, signature checks, the
 * transaction it produces. That AWS answers in exactly these formats is
 * documented only in part; see kms.ts.
 */

/** RFC 8410 SubjectPublicKeyInfo of an ed25519 key. */
const spkiOf = (kp: KeyPair) =>
  new Uint8Array([...Buffer.from('302a300506032b6570032100', 'hex'), ...kp.getPublicKey().data]);

function fakeKms(
  keys: Record<string, KeyPair>,
  tamper?: (sig: Uint8Array) => Uint8Array,
): KmsClient & {
  signed: Uint8Array[];
} {
  const signed: Uint8Array[] = [];
  return {
    signed,
    async getPublicKey(keyId) {
      return spkiOf(keys[keyId]!);
    },
    async sign(keyId, message) {
      signed.push(message);
      const sig = keys[keyId]!.sign(message).signature;
      return tamper ? tamper(sig) : sig;
    },
  };
}

const tx = {
  signerId: 'bot.alice.testnet',
  receiverId: 'pactora.testnet',
  nonce: 9n,
  blockHash: '11111111111111111111111111111111',
  method: 'accept_job',
  args: {job_id: 2},
  gas: 100n * TGAS,
  deposit: 0n,
};

describe('a KMS ed25519 key', () => {
  it('reads the NEAR public key out of the SPKI', async () => {
    const kp = KeyPair.fromRandom('ed25519');
    expect(nearPublicKeyOfSpki(spkiOf(kp))).toBe(kp.getPublicKey().toString());
    expect(`ed25519:${baseEncode(kp.getPublicKey().data)}`).toBe(kp.getPublicKey().toString());
  });

  it('refuses an SPKI that is not ed25519 (a secp256k1 key, say)', () => {
    const secpSpki = new Uint8Array(88).fill(4);
    expect(() => nearPublicKeyOfSpki(secpSpki)).toThrow(/not an ed25519/);
  });

  it('produces exactly the transaction a local key would, signing the 32-byte hash', async () => {
    const kp = KeyPair.fromRandom('ed25519');
    const kms = fakeKms({k1: kp});
    const remote = await signFunctionCallWith({...tx, key: await kmsKey(kms, 'k1')});
    const local = await signFunctionCall({...tx, keyPair: kp});
    expect(remote.hash).toBe(local.hash);
    expect(Buffer.from(remote.bytes).equals(Buffer.from(local.bytes))).toBe(true);
    expect(kms.signed[0]).toHaveLength(32);
  });

  it('refuses a signature that is not 64 bytes', async () => {
    const kms = fakeKms({k1: KeyPair.fromRandom('ed25519')}, (s) => new Uint8Array([0x30, ...s]));
    await expect(signFunctionCallWith({...tx, key: await kmsKey(kms, 'k1')})).rejects.toThrow(
      /returned a 65-byte signature, not 64/,
    );
  });

  it('refuses a signature that is not from its own key', async () => {
    const other = KeyPair.fromRandom('ed25519');
    const kms = fakeKms(
      {k1: KeyPair.fromRandom('ed25519')},
      (s) => other.sign(new Uint8Array(s.length)).signature,
    );
    await expect(signFunctionCallWith({...tx, key: await kmsKey(kms, 'k1')})).rejects.toThrow(
      /does not verify/,
    );
  });
});

describe('SIGNER_KMS_KEYS', () => {
  it('selects by wallet account, and has nothing for anyone else', async () => {
    const kp = KeyPair.fromRandom('ed25519');
    const src = await KmsKeySource.create(fakeKms({k1: kp}), {'bot.alice.testnet': 'k1'});
    const key = await src.keyFor('bot.alice.testnet');
    expect(key?.publicKey).toBe(kp.getPublicKey().toString());
    const msg = new Uint8Array(32).fill(1);
    expect(PublicKey.from(key!.publicKey).verify(msg, await key!.sign(msg))).toBe(true);
    expect(await src.keyFor('someone.testnet')).toBeNull();
    expect(await src.accounts()).toEqual(['bot.alice.testnet']);
  });

  it('refuses an entry that is not a NEAR account id', async () => {
    await expect(
      KmsKeySource.create(fakeKms({k1: KeyPair.fromRandom('ed25519')}), {'Bot.Alice!': 'k1'}),
    ).rejects.toThrow(/not a NEAR account id/);
  });
});
