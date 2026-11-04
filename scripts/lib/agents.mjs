/**
 * The on-chain setup of an orchestrator and its workers — shared by the demo
 * (scripts/demo.mjs) and the hosted seed (scripts/seed-hosted.mjs), so the two
 * cannot drift apart.
 *
 * What it builds, on the chain the clients point at:
 * - an orchestrator AgentAccount owned by `owner`: caps from the chain's params,
 *   allowed to call only the escrow's hiring functions, an allowance to the
 *   escrow, 1 MockUSDC to spend, and a session key for the hot key — a hot key
 *   can spend only through the account, only to the escrow, within the caps;
 * - one AgentAccount per worker, also owned by `owner`: caps of zero, a
 *   zero-budget session key, and only acceptJob + submitResult on the escrow —
 *   a stolen worker key can accept and deliver work, nothing else;
 * - ERC-8004 identities: the orchestrator's registered by `owner`, each
 *   worker's by the worker's OWN key (v2's escrow refuses a hire between two
 *   agents of one owner — `SameOwner`);
 * - a bond for each worker, paid by `bonder`;
 * - gas for every key that sends transactions, paid by `gasPayer`.
 *
 * Ids are read from the Registered event, never assumed: on a shared testnet
 * anyone may register between two of our transactions.
 */
import {encodeFunctionData, parseAbi, toFunctionSelector, zeroAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {agentCardUri, isCanonicalRegistry, registerAgent, send as sendTx, topUp} from './chain.mjs';

/** 0.5 MON: every wrapped call reserves its full gas limit on Monad (~0.054 MON). */
export const GAS_TOPUP = 500_000_000_000_000_000n;

const ERC20 = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

const mon = (wei) => (Number(wei / 10n ** 12n) / 1e6).toFixed(4);

/**
 * @param {object} o
 * @param o.pub            public client
 * @param o.chain          @pactora/config chain
 * @param o.abis           loadAbis()
 * @param o.walletFor      (account) => wallet client for that account
 * @param o.owner          wallet client: owns every AgentAccount and the orchestrator identity
 * @param o.bonder         wallet client: mints MockUSDC and bonds the workers
 * @param o.gasPayer       wallet client: tops up gas
 * @param o.hotKey         the orchestrator's session key (hex private key)
 * @param o.workerKeys     one private key per worker
 * @param o.workers        [{capability}] — names and capabilities for the agent cards
 * @param o.apiUrl         the API the agent cards point at
 * @param o.extraGas       [{address, amount}] — other accounts that need gas (e.g. a hosted owner)
 * @param o.gasEach        gas for the hot key and each worker key (default GAS_TOPUP)
 * @param o.orchestratorDelegateKey  v3, optional: make the orchestrator's wallet
 *                         this EOA, delegated to AgentDelegate by EIP-7702,
 *                         instead of an AgentAccount — same caps, same session
 *                         key, funds stay in the EOA. Idempotent across runs.
 * @param o.hotGas         gas for the hot key alone (default gasEach) — v3: it pays every
 *                         approve, and each reserves the escrow's feedback gas budget
 * @param o.log            (message) => void
 */
export async function setupAgents(o) {
  const {pub, chain, abis, owner, bonder, gasPayer, workers} = o;
  const log = o.log ?? (() => {});
  const send = (client, request) => sendTx(pub, client, request);
  const write = (client, address, abi, fn, args) =>
    send(client, {to: address, data: encodeFunctionData({abi, functionName: fn, args})});

  const identity = chain.erc8004['identityRegistry'];
  const token = chain.contracts['PaymentToken'];
  const vault = chain.contracts['StakeVault'];
  const escrow = chain.contracts['TaskEscrow'];
  const factory = chain.contracts['AgentAccountFactory'];
  const factoryAbi = abis['AgentAccountFactory'];
  const accountAbi = abis['AgentAccount'];
  const idAbi = abis['MockIdentityRegistry'];
  // v3: on the canonical registry the AgentAccount wallets are set by the
  // accounts' owner's ERC-1271 signature (see registerAgent).
  const canonical = isCanonicalRegistry(chain);
  const escrowSelector = (fn) =>
    toFunctionSelector(abis['TaskEscrow'].find((x) => x.type === 'function' && x.name === fn));

  const hot = privateKeyToAccount(o.hotKey);
  const workerAccounts = o.workerKeys.map((k) => privateKeyToAccount(k));
  const delegateEoa = o.orchestratorDelegateKey ? privateKeyToAccount(o.orchestratorDelegateKey) : null;
  if (delegateEoa && !chain.contracts['AgentDelegate']) {
    throw new Error('orchestratorDelegateKey given, but this chain has no AgentDelegate deployed');
  }

  // ── gas first: every key below sends transactions ─────────────────────
  // Said BEFORE sending if the payer cannot cover it: a drained payer used to
  // surface as a bare "transaction 0x… reverted" from the first top-up.
  const needs = [
    ...workerAccounts.map((a) => ({address: a.address, amount: o.gasEach ?? GAS_TOPUP})),
    {address: hot.address, amount: o.hotGas ?? o.gasEach ?? GAS_TOPUP},
    ...(delegateEoa ? [{address: delegateEoa.address, amount: o.gasEach ?? GAS_TOPUP}] : []),
    ...(o.extraGas ?? []),
  ];
  let needed = 0n;
  for (const n of needs) {
    const balance = await pub.getBalance({address: n.address});
    if (balance < n.amount) needed += n.amount - balance;
  }
  const has = await pub.getBalance({address: gasPayer.account.address});
  const margin = 50_000_000_000_000_000n; // the top-ups' own gas
  if (needed > 0n && has < needed + margin) {
    throw new Error(
      `the gas payer ${gasPayer.account.address} has ${mon(has)} MON; topping up the agents' wallets ` +
        `needs ~${mon(needed + margin)}. Fund it (or, for the demo, unset FUNDER_PRIVATE_KEY so the ` +
        `deployer pays). No top-up was sent.`,
    );
  }
  for (const n of needs) await topUp(pub, gasPayer, n.address, n.amount);
  // A balance funded in the last couple of blocks is not yet spendable for
  // gas on Monad (measured: scripts/spike-7702.mjs). Wait three.
  const funded = await pub.getBlockNumber();
  while ((await pub.getBlockNumber()) < funded + 3n) await new Promise((r) => setTimeout(r, 400));

  // ── the bonder's tokens, approved for bonds and hires ────────────────
  await write(bonder, token, ERC20, 'mint', [bonder.account.address, 1_000_000_000n]);
  await write(bonder, token, ERC20, 'approve', [vault, 1_000_000_000n]);
  await write(bonder, token, ERC20, 'approve', [escrow, 1_000_000_000n]);

  // CREATE2 salts, unique per CALL: the start time in the high bits, an index
  // in the low. A salt derived from the next agent id collided after an
  // aborted run, and createAccount reverted on the address it had occupied.
  const start = BigInt(Date.now());
  const salt = (n) => `0x${((start << 64n) | BigInt(n)).toString(16).padStart(64, '0')}`;
  const predict = (s) =>
    pub.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: 'predictAddress',
      args: [owner.account.address, s],
    });
  const block = await pub.getBlock({blockTag: 'latest'});
  const expiry = block.timestamp + 23n * 3600n;

  // ── the orchestrator's account ────────────────────────────────────────
  const caps = {
    perTaskCap: BigInt(chain.params.defaultPerTaskCap),
    dailyCap: BigInt(chain.params.defaultDailyCap),
    allowlistOnly: true,
  };
  // The owner of the orchestrator's wallet: the factory's owner for an
  // AgentAccount; for a delegated EOA, the EOA itself (it calls itself).
  let orchestratorWallet;
  let walletOwner = owner;
  let walletAbi = accountAbi;
  if (delegateEoa) {
    walletOwner = o.walletFor(delegateEoa);
    walletAbi = abis['AgentDelegate'];
    orchestratorWallet = delegateEoa.address;
    await delegateTo(pub, walletOwner, chain.contracts['AgentDelegate'], walletAbi, token, caps);
  } else {
    orchestratorWallet = await predict(salt(0));
    await write(owner, factory, factoryAbi, 'createAccount', [owner.account.address, salt(0), caps]);
  }
  for (const fn of ['createJob', 'directPay', 'approve', 'dispute', 'cancel']) {
    await write(walletOwner, orchestratorWallet, walletAbi, 'setAllowedCall', [
      escrow,
      escrowSelector(fn),
      true,
    ]);
  }
  await write(walletOwner, orchestratorWallet, walletAbi, 'setAllowance', [escrow, 1_000_000_000n]);
  await write(bonder, token, ERC20, 'mint', [orchestratorWallet, 1_000_000n]); // 1 MockUSDC to spend
  await write(walletOwner, orchestratorWallet, walletAbi, 'grantSessionKey', [
    hot.address,
    expiry,
    caps.dailyCap,
  ]);
  // Audit F1: whoever keeps the key alive is its session manager, which can
  // only extend it — never the owner, whose key stays with whoever set this up.
  if (o.sessionManager) {
    await write(walletOwner, orchestratorWallet, walletAbi, 'setSessionManager', [o.sessionManager]);
  }
  log(
    `orchestrator spends through ${delegateEoa ? 'an EOA delegated to AgentDelegate (EIP-7702)' : 'AgentAccount'} ${orchestratorWallet} — caps ${chain.formatToken(caps.perTaskCap)}/task, ${chain.formatToken(caps.dailyCap)}/day, escrow-only, session key ${hot.address.slice(0, 10)}…`,
  );

  // A delegated EOA registers itself: it is its own wallet.
  const orchestratorId = await registerAgent(pub, walletOwner, {
    identity,
    abi: idAbi,
    uri: agentCardUri({name: 'Orchestrator', capabilities: ['orchestration'], apiUrl: o.apiUrl}),
    wallet: orchestratorWallet,
    canonical,
    walletSigner: delegateEoa ?? owner.account,
  });

  // ── the workers' accounts ─────────────────────────────────────────────
  const workerCaps = {perTaskCap: 0n, dailyCap: 0n, allowlistOnly: true};
  const workerWallets = [];
  for (const [i, key] of workerAccounts.entries()) {
    const account = await predict(salt(i + 1));
    await write(owner, factory, factoryAbi, 'createAccount', [
      owner.account.address,
      salt(i + 1),
      workerCaps,
    ]);
    for (const fn of ['acceptJob', 'submitResult']) {
      await write(owner, account, accountAbi, 'setAllowedCall', [escrow, escrowSelector(fn), true]);
    }
    await write(owner, account, accountAbi, 'grantSessionKey', [key.address, expiry, 0n]);
    if (o.sessionManager) await write(owner, account, accountAbi, 'setSessionManager', [o.sessionManager]);
    workerWallets.push(account);
  }
  log(
    `${workers.length} workers act through AgentAccounts — zero caps, only acceptJob + submitResult on the escrow, each on its own session key`,
  );

  const workerIds = [];
  for (const [i, w] of workers.entries()) {
    const id = await registerAgent(pub, o.walletFor(workerAccounts[i]), {
      identity,
      abi: idAbi,
      uri: agentCardUri({name: titleCase(w.capability), capabilities: [w.capability], apiUrl: o.apiUrl}),
      wallet: workerWallets[i],
      canonical,
      // The worker's identity is the worker key's; its wallet is an account
      // the shared owner controls, so that owner signs for the account.
      walletSigner: owner.account,
    });
    workerIds.push(id);
    // Anyone may bond an agent; the bonder does, standing in for the owner.
    await write(bonder, vault, abis['StakeVault'], 'deposit', [id, 10_000_000n]);
  }
  log(
    `${workers.length + 1} agents on-chain (orchestrator ${orchestratorId}, workers ${workerIds.join(', ')} — each worker its own owner), bonded and funded for gas`,
  );

  // orchestratorOwner: the client that owns the orchestrator's identity —
  // `owner`, or the delegated EOA itself.
  return {
    caps,
    orchestratorWallet,
    orchestratorId,
    orchestratorOwner: walletOwner,
    hot,
    workerAccounts,
    workerWallets,
    workerIds,
  };
}

/**
 * Make `eoaClient`'s EOA delegate to AgentDelegate (EIP-7702) with `caps`.
 * Idempotent: an EOA already delegated and initialised has its caps re-set;
 * one delegated elsewhere, or not at all, is (re)delegated first.
 */
async function delegateTo(pub, eoaClient, delegate, delegateAbi, token, caps) {
  const eoa = eoaClient.account.address;
  const designator = `0xef0100${delegate.slice(2).toLowerCase()}`;
  if ((await pub.getCode({address: eoa}))?.toLowerCase() !== designator) {
    const authorization = await eoaClient.signAuthorization({contractAddress: delegate, executor: 'self'});
    // Calldata-free: it lands on the delegate's receive(); initialisation is
    // decided below, from what the EOA's namespace already holds.
    const hash = await eoaClient.sendTransaction({to: eoa, authorizationList: [authorization], data: '0x'});
    const receipt = await pub.waitForTransactionReceipt({hash});
    if (receipt.status !== 'success') throw new Error(`delegating ${eoa} reverted: ${hash}`);
  }
  const current = await pub.readContract({address: eoa, abi: delegateAbi, functionName: 'token'});
  const self = (functionName, args) =>
    sendTx(pub, eoaClient, {to: eoa, data: encodeFunctionData({abi: delegateAbi, functionName, args})});
  if (current === zeroAddress) await self('initialize', [token, caps]);
  else await self('setPolicy', [caps]);
}

export function titleCase(s) {
  return s
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}
