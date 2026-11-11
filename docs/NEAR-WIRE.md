# Wire contract: the backend and the NEAR contract

How the backend, SDK, MCP server and interface talk to Pactora on NEAR:
network keys, identifiers, chain facts, sign-in, the signer API and events.
This is the agreement every package is built against. If code and this file
disagree, one of them is a bug.

The contract itself is `../pactora-contracts-near/contracts/pactora` (one
contract: registry, escrow, bonds, caps, reputation). Its method names and
JSON argument names are quoted here exactly.

## 1. Network key: CAIP-2 strings

| What | Form |
|---|---|
| Network id (`chainId`) | a string: `"near:testnet"`, `"near:sandbox"` (local), later `"near:mainnet"` |
| Enabled networks | `ENABLED_CHAINS=near:testnet` (comma list) |
| Default network | `DEFAULT_CHAIN` |
| RPC override | `RPC_URL_<SLUG>` — `RPC_URL_TESTNET`, `RPC_URL_SANDBOX` |
| Database | `chain_id text` on every chain-derived table |
| x402 `network` | the CAIP-2 id itself, `near:testnet` |

The field keeps the name `chainId`: CAIP-2 calls this string a "chain ID".
`near:<network>` is the form NEAR x402 code uses (`r402-near`); the
ChainAgnostic registry has no NEAR profile yet, so this is a convention, not a
registered standard. A service that sees a numeric-network variable
(`ENABLED_CHAIN_IDS`, `DEFAULT_CHAIN_ID`, `RPC_URL_<digits>`) refuses to start
and names the variable to use.

Each network also has a **slug** (`testnet`, `sandbox`), used in file names
because `:` is not allowed in Windows paths.

## 2. Identifiers

| Thing | Form |
|---|---|
| Owner, wallet, token, contract | NEAR account id, 2–64 chars, `^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$` (nearcore's rule). Field names are `ownerAddress` / `walletAddress` |
| Agent id (`chainAgentId`) | contract `AgentId` = u64, decimal string |
| Job id (`chainJobId`) | contract `JobId` = u64, decimal string |
| `specHash`, `resultHash`, `reasonHash`, `reviewHash` | **sha256, 64 lowercase hex, no prefix** (the contract's `check_hash` rejects anything else) |
| Tx hash | base58 (32 bytes), 43–44 chars |
| Token amounts | base units, decimal string (mUSDC, 6 decimals) |

Hash inputs: `specHash = sha256(canonicalJson(spec) + ':' + publicId)`,
`reasonHash = sha256(canonicalize({reason}))`.

## 3. Chain facts (`chain/`, synced from the contracts repo)

```
chain/config/networks.json          keyed by CAIP-2 id
chain/config/params.<slug>.json     { "onchain": <contract Params, exactly as get_params returns>,
                                      "offchain": { acceptWindowSeconds, workWindowSeconds,
                                                    fastPathMinScore, confidenceFloor } }
chain/deployments/<slug>.json       { chainId, deployedAt, commit, startBlock,
                                      contracts: { Pactora, PaymentToken, Arbiter },
                                      wasm: { pactora: "<sha256>", mockUsdc: "<sha256>" } }
```

A network entry:

```json
"near:testnet": {
  "chainId": "near:testnet", "slug": "testnet", "nearNetworkId": "testnet",
  "name": "NEAR Testnet", "shortName": "near-testnet", "testnet": true,
  "nativeCurrency": {"name": "NEAR", "symbol": "NEAR", "decimals": 24},
  "rpcUrls": ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  "blockSource": {"kind": "accounts", "url": "https://tx.test.fastnear.com"},
  "blockExplorerUrls": ["https://testnet.nearblocks.io"],
  "faucetUrls": [],
  "paymentToken": {"symbol": "mUSDC", "decimals": 6, "accountId": null, "deployWithProtocol": true}
}
```

`nearNetworkId` is what RPC `status.chain_id` must answer; every service checks
it at start. Finality is always
`final`, so there is no `confirmations` setting.

## 4. `GET /v1/network`

The response:

```ts
{
  chainId: 'near:testnet', nearNetworkId: 'testnet', name, shortName, testnet,
  nativeCurrency: {name: 'NEAR', symbol: 'NEAR', decimals: 24},
  paymentToken: {symbol: 'mUSDC', decimals: 6, accountId: string | null},
  contracts: {Pactora: string, PaymentToken: string, Arbiter: string},
  rpcUrls: string[], explorerBaseUrl: string | null, faucetUrls: string[],
  windows: {accept, work, review, dispute},          // seconds
  minJobAmount, minFee, fastPathMax, fastPathMaxDisplay, protocolFeeBps,
  bondBps, minBond, disputeBondBps, minDisputeBond, maxJobAmount,
  defaultPerTaskCap, defaultDailyCap, minStake, withdrawDelaySeconds,
  enabledChains: string[],
}
```

Explorer links: `${explorer}/txns/<hash>` and `${explorer}/address/<account>`.

## 5. Sign-in and registration (NEP-413)

The owner proves control with a NEP-413 signed message. Four
steps, in this order, because the wallet's key must exist before the wallet
account does, and the agent id exists only after `register_agent`:

1. `POST /v1/agents/wallet-key` `{walletAddress, chainId?}` → `{walletPublicKey}`
   — the `ed25519:…` key the signer holds for that wallet (created on first
   request, the same one every time after). No credentials: a public key is
   harmless, and only the signer holds the private half.
2. The owner's wallet sends two transactions:
   - **tx 1** to `<wallet>`: `CreateAccount`, `Transfer` (gas money for the
     agent), `AddKey(walletPublicKey, FunctionCall{receiver: Pactora,
     methods: [], allowance})`;
   - **tx 2** to `Pactora`: `register_agent({wallet, card_uri, per_task_cap?,
     daily_cap?})` with a deposit for storage. Its return value is the agent id.
3. `POST /v1/agents/challenge` `{ownerAddress, walletAddress, chainAgentId, chainId?}`
   → `{nonce, message, recipient, expiresAt}`. `nonce` is 32 random bytes as
   64 hex (NEP-413 needs exactly 32; the wallet is given them as bytes);
   `recipient` is `PACTORA_SIGN_RECIPIENT` (default `pactora`). The owner's
   wallet signs `{message, recipient, nonce}` (`signMessage`) and returns
   `{accountId, publicKey, signature}` (`signature` base64).
4. `POST /v1/agents` `{…, chainAgentId, nonce, publicKey, signature}`. The API checks:
   (a) the NEP-413 signature is valid for `publicKey`; (b) RPC
   `view_access_key(ownerAddress, publicKey)` is **FullAccess** — a
   function-call key cannot register on its owner's behalf; (c) `get_agent
   (chainAgentId)` has `owner == ownerAddress`, is not frozen, and has
   `wallet == walletAddress` or `pending_wallet == walletAddress`; (d) if
   pending, the signer accepts first (`POST /keys/accept`, §6). Only then is
   the agent row written and the API key issued.

`chainAgentId` is required (an agent not on chain cannot be hired).
Key re-issue (`POST /v1/agents/:id/keys`) takes
`{publicKey, signature, nonce}` — the nonce of the challenge that was signed,
required since the 2026-11-09 audit (M2) — and makes the same full-access
check against the agent's current on-chain owner. In every check the
signature is verified locally first; the chain is asked about the key only
for a signature that verifies.

## 6. Signer HTTP API

Request:

```
POST /sign   {agentId, chainId, method, args, spend, idempotencyKey}
```

Response:

```
{txHash, nonce, replayed, result}
```

`result` is the call's JSON return value. `create_job` and `direct_pay` return the job id.

The allowed methods, with their exact argument names:

| `method` | `args` |
|---|---|
| `create_job` | `{client_id, worker_id, amount, spec_hash, accept_window, work_window}` |
| `direct_pay` | `{client_id, worker_id, amount, spec_hash}` |
| `accept_job` | `{job_id}` |
| `submit_result` | `{job_id, result_hash}` |
| `approve` | `{job_id, review_hash}` |
| `dispute` | `{job_id, reason_hash}` |
| `cancel` | `{job_id}` |
| `accept_wallet` | `{agent_id}` |

How every call is sent:
- **Deposit:** 0 attached. A function-call key can't attach one anyway.
- **Gas:** 100 Tgas.
- **Signing:** with the wallet's function-call key.
- **Nonce:** access-key nonce + 1, under the per-agent advisory lock.
- **Wait:** `send_tx` with `wait_until: FINAL`.

Argument encoding: ids (`*_id`, windows) are JSON numbers, as near-sdk reads
`u64` (a decimal string is accepted and converted); `amount` is a decimal
string (`U128`); hashes are 64 lowercase hex; `review_hash`/`reason_hash` may
be omitted or `null`. Unknown arguments are refused. `client_id`
(`create_job`, `direct_pay`) and `agent_id` (`accept_wallet`) must be the
agent's own `chainAgentId`. `spend` must be at least what the call takes
from the purse: `amount` for a hire, the job's `dispute_bond` (fixed at
creation) for `dispute`, 0 otherwise.

Replay: the same `(agentId, idempotencyKey)` with the same
`{method, args, spend}` returns the original `{txHash, nonce, result}` with
`replayed: true`; a different call under the key is `IDEMPOTENCY_CONFLICT`. A
call that failed on chain answers every retry of its key with the same error.

More endpoints:
- `POST /keys` `{walletAddress, chainId?}` → `{publicKey}`. It creates the key if missing and is idempotent.
- `POST /keys/accept` `{chainId, walletAddress, chainAgentId}` (`chainAgentId` a decimal string) →
  `{txHash, alreadyAccepted}`. Registration step (d): `accept_wallet` for a wallet that has no agent
  row yet. `alreadyAccepted: true` and `txHash: ''` when `get_agent(chainAgentId).wallet` already is
  the wallet; nothing is sent.
- `POST /faucet` `{receiverId, amount}` (`amount` a positive base-unit integer) → `{txHash, registered, from}`.
  Testnet and sandbox only, and only when the signer has `FAUCET_ACCOUNT_ID`: sends the payment token from the
  faucet's own account (registering the receiver with the token first when needed, `registered: true`), never
  more than `FAUCET_MAX_PER_SEND`. The api's `POST /v1/faucet` is its only caller.
- `GET /health` reports each signing account's NEAR balance in yocto (`wallets.wallets[].balanceYocto`).

All four POSTs need `Authorization: Bearer <SIGNER_TOKEN>` when the signer has one. Refusals are RFC 7807
with `code`:

| `code` (HTTP) | When |
|---|---|
| `SCHEMA_MISMATCH` (422) | body or args malformed; declared `spend` below what the call takes; contract `BadHash`, `ZeroAmount`, `AmountBelowMinimum`, `AmountAboveMaximum`, `AmountTooLargeForFastPath`, `WindowTooLong` |
| `CHAIN_MISMATCH` (409) | another network; agent row not on this chain |
| `FORBIDDEN` (403) | method not allowed; `client_id`/`agent_id` not the agent's; dispute of another client's job; key is FullAccess, for another receiver, or lacks the method; contract `NotAgentWallet`, `NotAgentOwner`, `NotPendingWallet` |
| `AGENT_NOT_HIREABLE` (409) | no `chainAgentId`; no key held; key not on the wallet; wallet account missing; no purse; contract `NotHireable`, `AgentFrozen`, `SameOwner`, `SelfDealing` |
| `INSUFFICIENT_FUNDS` (402) | wallet below 0.05 NEAR; key allowance below 0.01 NEAR; purse balance below the spend; contract `InsufficientBalance`, `InsufficientBond`, `InsufficientStorage` |
| `BUDGET_EXCEEDED` (402) | per-task cap or rolling daily cap (with `retryAfter` = seconds until `next_release_at`, else a day); contract `PerTaskCapExceeded`, `DailyCapExceeded` |
| `DEADLINE_PASSED` (410) | contract `DeadlinePassed` |
| `NOT_FOUND` (404) | dispute of a job that does not exist; `/keys/accept` with no key held or no such agent; contract `NoSuchJob`, `NoSuchAgent` |
| `INVALID_STATE` (409) | `/keys/accept` when the pending wallet is another account; `/keys` with no key store; contract `InvalidState`, `Paused`, `WalletTaken`, `DeadlineNotPassed`, any other |
| `IDEMPOTENCY_CONFLICT` (409) | key reused for a different call |
| `UPSTREAM_UNAVAILABLE` (503, `retryAfter`) | a view could not be read, the node rejected the tx before including it, or the outcome is not known yet — retrying the SAME request is safe |
| `UNAUTHORIZED` (401) | missing or wrong token |

## 7. Events (NEP-297, `standard: "pactora"`, `version: "1.0.0"`)

The indexer reads `EVENT_JSON:` logs from receipts whose executor is the Pactora contract. It reads only final blocks.

| Contract event | Indexer kind (unchanged names) |
|---|---|
| `job_created` | `created` |
| `job_accepted` | `accepted` |
| `result_submitted` | `submitted` |
| `job_disputed` | `disputed` |
| `dispute_resolved` | `dispute_resolved` |
| `dispute_expired` | `dispute_expired` |
| `job_settled` | `settled` |
| `job_refunded` | `refunded` |
| `bond_seized` | `bond_seized` |
| `dispute_bond_settled` | `dispute_bond_settled` |
| `direct_paid` | `direct_paid` |

The funding graph uses the token contract's `nep141` `ft_transfer` events, kept only when either side is a known wallet or owner. The cursor stores `{last_block, last_block_hash}`, meaning the height and hash of the last final block read.
