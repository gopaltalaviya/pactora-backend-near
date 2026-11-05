import {PublicKey, baseEncode, type TxKey} from '@pactora/near';
import type {KeySource} from './keystore.js';
import {isAccountId} from './keystore.js';

/**
 * Keys that never leave AWS KMS. On a chain that is not a testnet this is
 * how the signer holds a key without a decryptable copy in its environment.
 *
 * AWS KMS supports ed25519 signing (checked 2026-11-05 against
 * https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html
 * and https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html):
 * key spec `ECC_NIST_EDWARDS25519`, signing algorithm `ED25519_SHA_512`
 * (pure EdDSA, RFC 8032 / FIPS 186-5 §7.6), which KMS requires to be called
 * with `MessageType: RAW`. NEAR signs the 32-byte sha256 of the borsh
 * transaction with pure ed25519, so that hash is the RAW message.
 * `ED25519_PH_SHA_512` (HashEdDSA) is a different signature that NEAR does
 * not accept, and is never used here.
 *
 * The AWS pages do not state the byte format of an ed25519 signature; every
 * signature is therefore verified against the key's public key before it is
 * used (`signFunctionCallWith` does), and anything but 64 bytes is refused.
 */

/** The two KMS calls the signer makes — the AWS client, or a test double. */
export interface KmsClient {
  /** DER SubjectPublicKeyInfo of the key. */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  /** ed25519 signature (ED25519_SHA_512, MessageType RAW) of `message`. */
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;
}

/** SPKI prefix of an ed25519 key: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING (32 bytes) } (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The `ed25519:<base58>` key in an ed25519 SubjectPublicKeyInfo. */
export function nearPublicKeyOfSpki(spki: Uint8Array): string {
  const der = Buffer.from(spki);
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('not an ed25519 SubjectPublicKeyInfo');
  }
  return `ed25519:${baseEncode(der.subarray(12))}`;
}

/** A `TxKey` whose private half is `keyId` in the KMS. */
export async function kmsKey(kms: KmsClient, keyId: string): Promise<TxKey> {
  const publicKey = nearPublicKeyOfSpki(await kms.getPublicKey(keyId));
  PublicKey.from(publicKey);
  return {
    publicKey,
    async sign(message) {
      const signature = await kms.sign(keyId, message);
      if (signature.length !== 64) {
        throw new Error(`KMS key ${keyId} returned a ${signature.length}-byte signature, not 64`);
      }
      return signature;
    },
  };
}

/**
 * `SIGNER_KMS_KEYS`: a JSON object of wallet account → KMS key id (or ARN).
 * Resolved once at boot; an account with no entry has no KMS key.
 */
export class KmsKeySource implements KeySource {
  readonly kind = 'aws-kms';

  private constructor(private readonly byAccount: Map<string, TxKey>) {}

  static async create(kms: KmsClient, keys: Record<string, string>): Promise<KmsKeySource> {
    const byAccount = new Map<string, TxKey>();
    for (const [account, keyId] of Object.entries(keys)) {
      if (!isAccountId(account)) throw new Error(`SIGNER_KMS_KEYS: "${account}" is not a NEAR account id`);
      byAccount.set(account, await kmsKey(kms, keyId));
    }
    return new KmsKeySource(byAccount);
  }

  async keyFor(accountId: string): Promise<TxKey | null> {
    return this.byAccount.get(accountId) ?? null;
  }

  async accounts(): Promise<string[]> {
    return [...this.byAccount.keys()];
  }
}

/** AWS KMS, with credentials from the SDK's default chain (role, env, profile). */
export async function awsKms(region?: string): Promise<KmsClient> {
  const {KMSClient, GetPublicKeyCommand, SignCommand} = await import('@aws-sdk/client-kms');
  const client = new KMSClient(region ? {region} : {});
  return {
    async getPublicKey(keyId) {
      const out = await client.send(new GetPublicKeyCommand({KeyId: keyId}));
      if (out.KeySpec !== 'ECC_NIST_EDWARDS25519' || !out.PublicKey) {
        throw new Error(`KMS key ${keyId} is ${out.KeySpec ?? 'unknown'}, not ECC_NIST_EDWARDS25519`);
      }
      return out.PublicKey;
    },
    async sign(keyId, message) {
      const out = await client.send(
        new SignCommand({
          KeyId: keyId,
          Message: message,
          MessageType: 'RAW',
          SigningAlgorithm: 'ED25519_SHA_512',
        }),
      );
      if (!out.Signature) throw new Error(`KMS key ${keyId} returned no signature`);
      return out.Signature;
    },
  };
}
