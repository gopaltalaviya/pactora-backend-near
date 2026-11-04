/**
 * Live check of the KMS signing path (v3): `kmsAccount` — DER parsing, low-s,
 * recovery id, transaction serialisation — sends a real transaction on
 * Monad testnet and the chain attributes it to the KMS key's address.
 *
 * No AWS account is needed: a stand-in KMS holds AGENT_B's key and answers
 * like AWS KMS does (DER SPKI, DER signatures without recovery id, either s).
 * Against real AWS KMS, set VERIFY_KMS_KEY_ID (and AWS credentials) instead.
 *
 *   set -a; . ../agentx-contracts/.env; set +a
 *   node scripts/verify-kms.mjs          # one 0-value self-transfer, ~0.002 MON
 */
import {secp256k1} from '@noble/curves/secp256k1';
import {createPublicClient, createWalletClient, http} from 'viem';
import {awsKms, kmsAccount} from '../apps/signer/dist/kms.js';

const RPC = process.env.RPC_URL_10143 || 'https://testnet-rpc.monad.xyz';
const pub = createPublicClient({transport: http(RPC)});
if ((await pub.getChainId()) !== 10143) throw new Error('verify-kms: testnet only');

const SPKI = '3056301006072a8648ce3d020106052b8104000a034200';
let kms;
let keyId = process.env.VERIFY_KMS_KEY_ID;
if (keyId) {
  kms = await awsKms(process.env.AWS_REGION);
} else {
  const key = process.env.AGENT_B_PRIVATE_KEY?.slice(2);
  if (!key) throw new Error('set AGENT_B_PRIVATE_KEY (or VERIFY_KMS_KEY_ID)');
  keyId = 'stand-in';
  let flip = false;
  kms = {
    async getPublicKey() {
      return Uint8Array.from(
        Buffer.concat([Buffer.from(SPKI, 'hex'), Buffer.from(secp256k1.getPublicKey(key, false))]),
      );
    },
    async sign(_id, digest) {
      // Alternate high and low s, as a real KMS may return either.
      let sig = secp256k1.sign(digest, key);
      if ((flip = !flip)) sig = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s);
      return sig.toDERRawBytes();
    },
  };
}

const account = await kmsAccount(kms, keyId);
const wallet = createWalletClient({account, transport: http(RPC)});
const chain = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: {name: 'MON', symbol: 'MON', decimals: 18},
  rpcUrls: {default: {http: [RPC]}},
};
const hash = await wallet.sendTransaction({chain, to: account.address, value: 0n});
const receipt = await pub.waitForTransactionReceipt({hash});
const tx = await pub.getTransaction({hash});
const ok = receipt.status === 'success' && tx.from.toLowerCase() === account.address.toLowerCase();
console.log(
  `${ok ? '✓' : '✗'} KMS-signed tx ${hash} from ${tx.from} (key ${account.address}), status ${receipt.status}`,
);
process.exit(ok ? 0 : 1);
