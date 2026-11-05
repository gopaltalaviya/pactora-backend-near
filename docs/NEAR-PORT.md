# The NEAR port — wire contract

What changes when the backend, SDK, MCP server and interface move from Monad
(EVM) to NEAR. This is the agreement every package is built against. If code
and this file disagree, one of them is a bug.

The contract itself is `../pactora-contracts-near/contracts/pactora` (one
contract: registry, escrow, bonds, caps, reputation). Its method names and
JSON argument names are quoted here exactly.

## 1. Network key: CAIP-2 strings

| Before | After |
|---|---|
| `chainId: number` (`10143`, `31337`) | `chainId: string` — `"near:testnet"`, `"near:sandbox"` (local), later `"near:mainnet"` |
| `ENABLED_CHAIN_IDS=10143` | `ENABLED_CHAINS=near:testnet` |
| `DEFAULT_CHAIN_ID` | `DEFAULT_CHAIN` |
| `RPC_URL_<chainId>` | `RPC_URL_<SLUG>` — `RPC_URL_TESTNET`, `RPC_URL_SANDBOX` |
| DB `chain_id bigint` | DB `chain_id text` (migration 0011) |
| x402 `eip155:10143` | x402 `near:testnet` (the key itself) |

The field keeps the name `chainId`: CAIP-2 calls this string a "chain ID".
`near:<network>` is the form NEAR x402 code uses (`r402-near`); the
ChainAgnostic registry has no NEAR profile yet, so this is a convention, not a
registered standard. A service that still sees `ENABLED_CHAIN_IDS`,
`DEFAULT_CHAIN_ID` or `RPC_URL_<digits>` refuses to start and names the
replacement.

Each network also has a **slug** (`testnet`, `sandbox`), used in file names
because `:` is not allowed in Windows paths.

## 2. Identifiers

| Thing | EVM | NEAR |
|---|---|---|
| Owner, wallet, token, contract | `0x` + 40 hex | NEAR account id, 2–64 chars, `^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$` (nearcore's rule). Field names stay `ownerAddress` / `walletAddress` |
| Agent id (`chainAgentId`) | ERC-8004 uint256 | contract `AgentId` = u64, decimal string |
| Job id (`chainJobId`) | uint256 | contract `JobId` = u64, decimal string |
| `specHash`, `resultHash`, `reasonHash`, `reviewHash` | keccak256, `0x`+64 hex | **sha256, 64 lowercase hex, no `0x`** (the contract's `check_hash` rejects anything else) |
| Tx hash | `0x`+64 hex | base58 (32 bytes), 43–44 chars |
| Token amounts | base units, decimal string | unchanged (mUSDC, 6 decimals) |

Hash inputs are unchanged: `specHash = sha256(canonicalJson(spec) + ':' + publicId)`,
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
  "rpcUrls": ["https://rpc.testnet.near.org"],
  "blockSource": {"kind": "neardata", "url": "https://testnet.neardata.xyz"},
  "blockExplorerUrls": ["https://testnet.nearblocks.io"],
  "faucetUrls": [],
  "paymentToken": {"symbol": "mUSDC", "decimals": 6, "accountId": null, "deployWithProtocol": true}
}
```

`nearNetworkId` is what RPC `status.chain_id` must answer; every service checks
it at start, the way the EVM build checked `eth_chainId`. Finality is always
`final`, so there is no `confirmations` setting.

## 4. `GET /v1/network`

Removed: `erc8004`, `confirmations`, `rpcUrls` overrides. Changed and added:

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

The owner proves control with a NEP-413 signed message, not EIP-191. Four
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

`chainAgentId` is required (an agent not on chain cannot be hired); the old
`walletSignature` path is gone. Key re-issue (`POST /v1/agents/:id/keys`) takes
`{publicKey, signature, nonce?}` and makes the same full-access check against
the agent's current on-chain owner.

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

Two more endpoints:
- `POST /keys` `{walletAddress}` → `{publicKey}`. It creates the key if missing and is idempotent.
- `POST /keys/accept` `{chainId, walletAddress, chainAgentId}` → `{txHash, alreadyAccepted}`: signs the wallet's `accept_wallet` with its key, before the API has an agent row.
- `GET /health` reports each signing account's NEAR balance in yocto (`balanceYocto`).

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

## 8. What is gone, and why

| Removed | Reason |
|---|---|
| `renewer` (session-key renewal) | Function-call keys don't expire. The caps live in the contract. |
| `accounts.ts` (bytecode classification) and EIP-7702 | NEAR has no code-at-address wallets. Wallet trust is `get_agent().wallet` plus the access key's scope. |
| The EOA calldata allowlist | The signer only calls the allowed methods above, on `Pactora`. |
| AgentAccount `execute` wrapping | The agent signs directly with its own scoped key. |
| keccak / EIP-191 / ABIs | Replaced by sha256, NEP-413 and JSON arguments. |
| AWS KMS `ECC_SECG_P256K1` | NEAR keys are ed25519. Whether KMS can sign ed25519 is checked before it is ported; until then the keystore is the key source. |
