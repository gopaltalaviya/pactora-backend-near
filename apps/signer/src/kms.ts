import {
  hashMessage,
  hashTypedData,
  keccak256,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  type Hex,
  type LocalAccount,
} from 'viem';
import {publicKeyToAddress, toAccount} from 'viem/accounts';
import type {KeySource} from './keystore.js';

/**
 * Keys that never leave a KMS (v3, docs/20 §3). On a mainnet the signer
 * refuses raw keys, so this is how it signs there.
 *
 * Why keys at all: agents act through the API with no human present, so
 * something must sign their transactions. What it holds is narrow — an
 * agent's SESSION key, which its AgentAccount or EIP-7702 delegate caps per
 * task and per day and its owner can revoke; the keeper's; the renewer's.
 * The funds stay with the owner. A KMS means even those keys cannot be
 * copied out of this process: it asks the KMS to sign each digest.
 *
 * AWS KMS, `ECC_SECG_P256K1` keys, `ECDSA_SHA_256` over a 32-byte DIGEST (the
 * keccak-256 hash; KMS does not hash a digest again). KMS returns a DER
 * signature with no recovery id and a possibly high `s`; both are fixed here,
 * because Ethereum accepts only low-s (EIP-2).
 */

/** The two KMS calls the signer makes — the AWS client, or a test double. */
export interface KmsClient {
  /** DER SubjectPublicKeyInfo of the key. */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  /** DER ECDSA signature of a 32-byte digest. */
  sign(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** An Ethereum account whose key is `keyId` in the KMS. */
export async function kmsAccount(kms: KmsClient, keyId: string): Promise<LocalAccount> {
  const address = publicKeyToAddress(uncompressedKey(await kms.getPublicKey(keyId)));

  const sign = async (hash: Hex): Promise<Hex> => {
    const {r, s} = parseDerSignature(await kms.sign(keyId, hexToBytes(hash)));
    const low = s > N / 2n ? N - s : s;
    for (const yParity of [0, 1] as const) {
      const signature = serializeSignature({r: toHex32(r), s: toHex32(low), yParity});
      if ((await recoverAddress({hash, signature})).toLowerCase() === address.toLowerCase()) {
        return signature;
      }
    }
    throw new Error(`KMS key ${keyId} returned a signature that is not from ${address}`);
  };

  const account = toAccount({
    address,
    async sign({hash}) {
      return sign(hash);
    },
    async signMessage({message}) {
      return sign(hashMessage(message));
    },
    async signTypedData(typedData) {
      return sign(hashTypedData(typedData));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const signature = await sign(keccak256(await serializer(transaction)));
      const {r, s, yParity} = splitSignature(signature);
      return serializer(transaction, {r, s, yParity});
    },
  });
  return account;
}

/**
 * Keys by agent: `SIGNER_KMS_KEYS` is a JSON object of agent id or wallet
 * address → KMS key id (or ARN). Resolved once at boot; an agent with no
 * entry has no key, and the signer refuses it.
 */
export class KmsKeySource implements KeySource {
  readonly kind = 'aws-kms';

  private constructor(
    private readonly byId: Map<number, LocalAccount>,
    private readonly byAddress: Map<string, LocalAccount>,
  ) {}

  static async create(kms: KmsClient, keys: Record<string, string>): Promise<KmsKeySource> {
    const byId = new Map<number, LocalAccount>();
    const byAddress = new Map<string, LocalAccount>();
    for (const [agent, keyId] of Object.entries(keys)) {
      const account = await kmsAccount(kms, keyId);
      if (/^0x[0-9a-fA-F]{40}$/.test(agent)) {
        if (agent.toLowerCase() !== account.address.toLowerCase()) {
          throw new Error(`SIGNER_KMS_KEYS: key ${keyId} is ${account.address}, not ${agent}`);
        }
      } else if (/^\d+$/.test(agent)) {
        byId.set(Number(agent), account);
      } else {
        throw new Error(`SIGNER_KMS_KEYS: "${agent}" is neither an agent id nor an address`);
      }
      byAddress.set(account.address.toLowerCase(), account);
    }
    return new KmsKeySource(byId, byAddress);
  }

  async accountFor(agentId: number, wallet?: string): Promise<LocalAccount | null> {
    return this.byId.get(agentId) ?? (wallet ? (this.byAddress.get(wallet.toLowerCase()) ?? null) : null);
  }

  all(): LocalAccount[] {
    return [...this.byAddress.values()];
  }
}

/** AWS KMS, with credentials from the SDK's default chain (role, env, profile). */
export async function awsKms(region?: string): Promise<KmsClient> {
  const {KMSClient, GetPublicKeyCommand, SignCommand} = await import('@aws-sdk/client-kms');
  const client = new KMSClient(region ? {region} : {});
  return {
    async getPublicKey(keyId) {
      const out = await client.send(new GetPublicKeyCommand({KeyId: keyId}));
      if (out.KeySpec !== 'ECC_SECG_P256K1' || !out.PublicKey) {
        throw new Error(`KMS key ${keyId} is ${out.KeySpec ?? 'unknown'}, not ECC_SECG_P256K1`);
      }
      return out.PublicKey;
    },
    async sign(keyId, digest) {
      const out = await client.send(
        new SignCommand({
          KeyId: keyId,
          Message: digest,
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      );
      if (!out.Signature) throw new Error(`KMS key ${keyId} returned no signature`);
      return out.Signature;
    },
  };
}

/** The 65-byte uncompressed point at the end of a secp256k1 SPKI. */
export function uncompressedKey(spki: Uint8Array): Hex {
  const point = spki.slice(-65);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('not an uncompressed secp256k1 public key');
  return bytesToHex(point);
}

/** (r, s) from a DER `SEQUENCE { INTEGER r, INTEGER s }`. */
export function parseDerSignature(der: Uint8Array): {r: bigint; s: bigint} {
  let i = 0;
  const expect = (tag: number) => {
    if (der[i++] !== tag) throw new Error('malformed DER signature');
  };
  const length = () => {
    const first = der[i++]!;
    if (first < 0x80) return first;
    let n = 0;
    for (let k = 0; k < (first & 0x7f); k++) n = (n << 8) | der[i++]!;
    return n;
  };
  const integer = () => {
    expect(0x02);
    const len = length();
    const value = BigInt(bytesToHex(der.slice(i, i + len)));
    i += len;
    return value;
  };
  expect(0x30);
  length();
  const r = integer();
  const s = integer();
  if (r === 0n || s === 0n || r >= N || s >= N) throw new Error('DER signature out of range');
  return {r, s};
}

function splitSignature(signature: Hex): {r: Hex; s: Hex; yParity: 0 | 1} {
  return {
    r: `0x${signature.slice(2, 66)}`,
    s: `0x${signature.slice(66, 130)}`,
    yParity: Number.parseInt(signature.slice(130, 132), 16) === 28 ? 1 : 0,
  };
}

const toHex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const bytesToHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString('hex')}`;
const hexToBytes = (h: Hex): Uint8Array => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
