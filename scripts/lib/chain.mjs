/**
 * Chain helpers shared by the scripts that write to a real chain.
 *
 * Two rules the v2 contracts made hard requirements, in one place:
 *
 * - An identity is registered BY ITS OWNER. v2's escrow refuses a hire when
 *   client and worker have the same owner (SameOwner), so a script that
 *   registered every agent from one key could no longer hire anything.
 * - An agent id is READ from the `Registered` event, never assumed. Assuming
 *   `nextId + i` is wrong the moment anyone else registers on a shared
 *   testnet between two of our transactions.
 */
import {keccak256, parseAbi, parseEventLogs, toHex} from 'viem';

/**
 * Send, surviving a dropped response: sign ONCE, then broadcast the same bytes
 * until the node has them. Re-running writeContract after a lost response
 * would sign a NEW transaction on a new nonce; the same bytes are idempotent.
 */
export async function send(pub, walletClient, request) {
  const prepared = await walletClient.prepareTransactionRequest(request);
  const raw = await walletClient.signTransaction(prepared);
  const hash = keccak256(raw);
  for (let attempt = 0; ; attempt++) {
    try {
      await pub.sendRawTransaction({serializedTransaction: raw});
      break;
    } catch (err) {
      const msg = `${err.shortMessage ?? ''} ${err.details ?? ''} ${err.message ?? ''}`;
      if (/already known|nonce too low|replacement transaction underpriced/i.test(msg)) break;
      const transient =
        err.name === 'HttpRequestError' ||
        err.name === 'TimeoutError' ||
        /\b50[234]\b|fetch failed|ECONNRESET/i.test(msg);
      if (!transient || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const receipt = await pub.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

/**
 * Whether the chain's ERC-8004 registry is the canonical one (v3 testnet,
 * mainnet) or our own reference deployment (local anvil, v2 testnet). Read
 * from the deployment record: a mock is listed there only when we deployed it.
 */
export const isCanonicalRegistry = (chain) => !chain.contracts['MockIdentityRegistry'];

/** The canonical registry's interface (upstream erc-8004-contracts, verified 2026-10-25). */
export const CANONICAL_IDENTITY_ABI = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'function getAgentWallet(uint256) view returns (address)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])',
]);

const ACCOUNT_SIGN_ABI = parseAbi(['function accountMessageHash(bytes32 hash) view returns (bytes32)']);

/**
 * Register an ERC-8004 identity AS `ownerClient`'s account, paying out to
 * `wallet`; returns the new agent id.
 *
 * On our reference registry the wallet is an argument. On the canonical one
 * `register` makes the OWNER the wallet, and moving it takes a signature from
 * the new wallet: ECDSA for an EOA, ERC-1271 for a contract. An AgentAccount
 * answers ERC-1271 with its own owner's signature over `accountMessageHash`,
 * so `walletSigner` is that owner's account (or the wallet's own key, for an
 * EOA wallet). Pass `canonical: isCanonicalRegistry(chain)`.
 */
export async function registerAgent(pub, ownerClient, {identity, abi, uri, wallet, canonical, walletSigner}) {
  const {encodeFunctionData, hashTypedData} = await import('viem');
  if (!canonical) {
    const receipt = await send(pub, ownerClient, {
      to: identity,
      data: encodeFunctionData({abi, functionName: 'register', args: [uri, wallet]}),
    });
    const [registered] = parseEventLogs({abi, logs: receipt.logs, eventName: 'Registered'});
    if (!registered) throw new Error(`no Registered event in ${receipt.transactionHash}`);
    return registered.args.agentId;
  }

  const receipt = await send(pub, ownerClient, {
    to: identity,
    data: encodeFunctionData({abi: CANONICAL_IDENTITY_ABI, functionName: 'register', args: [uri]}),
  });
  const [registered] = parseEventLogs({
    abi: CANONICAL_IDENTITY_ABI,
    logs: receipt.logs,
    eventName: 'Registered',
  });
  if (!registered) throw new Error(`no Registered event in ${receipt.transactionHash}`);
  const agentId = registered.args.agentId;
  const owner = ownerClient.account.address;
  if (wallet.toLowerCase() === owner.toLowerCase()) return agentId;

  if (!walletSigner) throw new Error(`moving agent ${agentId}'s wallet needs a walletSigner`);
  const [, name, version, chainId, verifyingContract] = await pub.readContract({
    address: identity,
    abi: CANONICAL_IDENTITY_ABI,
    functionName: 'eip712Domain',
  });
  // The registry allows a deadline at most 5 minutes out (MAX_DEADLINE_DELAY).
  const deadline = (await pub.getBlock()).timestamp + 240n;
  const digest = hashTypedData({
    domain: {name, version, chainId, verifyingContract},
    types: {
      AgentWalletSet: [
        {name: 'agentId', type: 'uint256'},
        {name: 'newWallet', type: 'address'},
        {name: 'owner', type: 'address'},
        {name: 'deadline', type: 'uint256'},
      ],
    },
    primaryType: 'AgentWalletSet',
    message: {agentId, newWallet: wallet, owner, deadline},
  });
  const code = await pub.getCode({address: wallet});
  const hash =
    code && code !== '0x'
      ? await pub.readContract({
          address: wallet,
          abi: ACCOUNT_SIGN_ABI,
          functionName: 'accountMessageHash',
          args: [digest],
        })
      : digest;
  const signature = await walletSigner.sign({hash});
  await send(pub, ownerClient, {
    to: identity,
    data: encodeFunctionData({
      abi: CANONICAL_IDENTITY_ABI,
      functionName: 'setAgentWallet',
      args: [agentId, wallet, deadline, signature],
    }),
  });
  return agentId;
}

/** Top an address up to `target` wei from `payer`, if it is below it. */
export async function topUp(pub, payerClient, address, target) {
  const balance = await pub.getBalance({address});
  if (balance >= target) return null;
  return send(pub, payerClient, {to: address, value: target - balance});
}

/**
 * An ERC-8004 registration file ("agent card") as a base64 JSON data: URI —
 * the form the spec allows for fully on-chain metadata — so an identity the
 * demo registers describes its agent to anyone reading the registry, instead
 * of pointing at an address that resolves to nothing. Same shape as the
 * interface's lib/agent-card.ts (registration-v1).
 */
export function agentCardUri({name, capabilities, apiUrl, description}) {
  const card = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name,
    description: description ?? `A Pactora agent offering ${capabilities.join(', ')}.`,
    image: '',
    services: [
      {
        name: 'Pactora',
        endpoint: `${apiUrl.replace(/\/$/, '')}/v1/agents`,
        version: 'v1',
        skills: capabilities,
      },
    ],
    x402Support: false,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(card), 'utf8').toString('base64')}`;
}

export const unique = (label) => keccak256(toHex(`${label}:${Date.now()}:${Math.random()}`));

/**
 * Register an agent with a Pactora API the way the /register page does: ask
 * for a challenge naming what is being registered, sign it as the owner, and
 * register with the signature (audit M1). `owner` is a viem account — its key
 * signs here and goes nowhere. `walletSigner`, an account too, is needed only
 * when there is no `chainAgentId` and the wallet is not the owner.
 *
 * Returns the API's answer: `{agentId, apiKey, ...}`; throws on a refusal.
 */
export async function registerWithApi(base, body, owner, walletSigner) {
  const post = async (path, payload) => {
    const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(`${path} ${body.name ?? ''}: ${res.status} ${json.code ?? ''} ${json.detail ?? ''}`);
    return json;
  };
  const {nonce, message} = await post('/v1/agents/challenge', {
    ownerAddress: body.ownerAddress,
    walletAddress: body.walletAddress,
    ...(body.chainId !== undefined ? {chainId: body.chainId} : {}),
    ...(body.chainAgentId !== undefined ? {chainAgentId: body.chainAgentId} : {}),
  });
  return post('/v1/agents', {
    ...body,
    nonce,
    signature: await owner.signMessage({message}),
    ...(walletSigner ? {walletSignature: await walletSigner.signMessage({message})} : {}),
  });
}
