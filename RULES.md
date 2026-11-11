# Swarm rules

The rules every agent in `scripts/swarm.mjs` follows. No model is in the
loop: each agent is a few lines of arithmetic, and the market they make
together runs through the real API, signer, indexer and contract.

Run it:

```bash
pnpm swarm:local                                                      # local NEAR node: 20 buyers, 5 sellers
SWARM_NETWORK=testnet node --env-file=../pactora-contracts-near/.env scripts/swarm.mjs   # NEAR testnet: 6 buyers, 3 sellers
```

It ends with `Swarm passed.` and exit code 0. On testnet it also prints each
settlement's transaction on the explorer.

## Who is in the swarm

| Agent | Count (local / testnet) | Capability | Money |
|---|---|---|---|
| Buyer | 20 / 6 | `procurement` | a purse of 2 mUSDC, spent only through escrow |
| Seller | 5 / 3 | `data-labeling` | a stake (the contract's minimum + 2 mUSDC), so it can be hired |

Each agent has its own owner account and its own wallet sub-account
(`bot.<owner>`), registered on chain with a function-call key that can call
only the Pactora contract and cannot attach NEAR.

## Seller rule (bidding)

Each seller has three numbers:

| Seller | Floor (base units) | Mark-down | Capacity (bids per round) |
|---|---|---|---|
| Atlas | 20 000 | 0.70 | 10 |
| Birch | 25 000 | 0.80 | 10 |
| Cobalt | 30 000 | 0.60 | 6 |
| Dune | 45 000 | 0.90 | 10 |
| Ember | 15 000 | 0.95 | 4 |

(On testnet: Atlas, Birch and Cobalt.)

For each open listing, richest ceiling first:

1. Skip it if the buyer's ceiling is below the floor, or the seller has made
   `capacity` bids this round.
2. Otherwise bid `max(floor, ceiling × mark-down)`.

So the same listing draws different prices, and a cheap seller with little
capacity cannot take every job.

## Buyer rule (choosing)

Each buyer posts one listing with a ceiling (30 000 to 100 000 base units,
never above the contract's per-task cap, which it reads from the chain).
When the bids are in, it picks the bid with the highest

```
score = 0.55 × (1 − price / ceiling) + 0.45 × (reputation / 100)
```

where `reputation` is the applicant's score in the API, written by the
indexer from settlements on chain. Ties go to the seller with fewer completed
jobs, which spreads work.

## Rounds

Two rounds, half the buyers each. Round 2's buyers see the reputation that
round 1's settlements wrote on chain, so a seller that delivered in round 1
can win in round 2 with a higher price than a rival with no record.

## Every job, start to finish

1. The buyer selects a bid. The signer calls `create_job` from the buyer's
   purse: the price is locked in escrow.
2. The seller accepts, sends a draft, and the buyer accepts the draft.
3. The seller submits; the hash on chain is the accepted draft's hash.
4. The buyer approves; the contract pays the seller the price less the fee
   and writes both parties' reputation.

## Round 3: collective purchasing

Three buyers buy ONE job worth three per-task caps, which no buyer could buy
alone (`POST /v1/pools`, `POST /v1/pools/:id/join`). The worker is the
seller with the best record after rounds 1–2. Each buyer funds an equal
share as its own escrow job, from its own wallet and under its own caps; the
worker accepts every share and delivers the same output to each, so every
share carries the same result hash on chain; each buyer approves its own.

## Round 4: subcontracting

A buyer hires the top seller; the top seller, now a client too, hires the
cheapest other seller for half the work from its own purse (its owner tops
it up first), approves that delivery, then delivers its own job. The child
job's spec names the parent job. Checked: what the middle agent kept equals
its price, less the fee, less what it paid.

## What is checked, against the chain

- Every buyer posted, and every fill settled on chain; every pool share
  settled with one result hash; the subcontract chain settled.
- Each seller's completed count in the API equals its settled wins, and its
  public 52-week history counts the same settlements.
- Every buyer stayed within its caps: each job at or below its ceiling and
  the contract's per-task cap, each day's spend at or below the daily cap,
  and each purse fell by exactly what it paid.
- Balances reconcile: what buyers paid equals what sellers received plus the
  fees.
- I1: the contract holds exactly what it owes.

## A run on NEAR testnet (2026-11-11)

`Swarm passed.` in 473 s on `pactora.gopalt.testnet`: 6 listings, 18 bids,
6 fills, median price 0.0405 mUSDC (range 0.021–0.06), 6 settlements on
chain. Round 1 went Atlas 1, Cobalt 2. In round 2 all three buyers chose
Cobalt, at higher prices than Atlas bid, because of the record round 1 had
just written on chain (score 57 against 50).

| Round | Buyer → seller | Price | Chain job | Settling transaction |
|---|---|---|---|---|
| 1 | Buyer 01 → Atlas | 0.021 mUSDC | 49 | [3zuLf17p…](https://testnet.nearblocks.io/txns/3zuLf17p7EFpXTPnwzvhoeaZ28n4jPHnxCtFt7CVvLji) |
| 1 | Buyer 02 → Cobalt | 0.03 mUSDC | 50 | [4sbzTXFK…](https://testnet.nearblocks.io/txns/4sbzTXFKUJ37Z42SDPEAEpBdrDXaAfBLMT4cdWPkfDu8) |
| 1 | Buyer 03 → Cobalt | 0.036 mUSDC | 51 | [2xLt9ggL…](https://testnet.nearblocks.io/txns/2xLt9ggLKxZ3Dn7UTouLY7qXXGo5xZDcqKAvzfsyFZve) |
| 2 | Buyer 04 → Cobalt | 0.045 mUSDC | 52 | [A9LxfQMG…](https://testnet.nearblocks.io/txns/A9LxfQMGGRApuYpCQXUjvfYbtENufNf5MHPYPZLsYXEY) |
| 2 | Buyer 05 → Cobalt | 0.054 mUSDC | 53 | [6WkSyFMg…](https://testnet.nearblocks.io/txns/6WkSyFMg4mYusJiLisjV8ocpK9EtsDCp2BKix1MH1Yfi) |
| 2 | Buyer 06 → Cobalt | 0.06 mUSDC | 54 | [7i2oWRoB…](https://testnet.nearblocks.io/txns/7i2oWRoBrCxBPxo5HvritVyS4xiv4Qhw4nVrQjri59Z) |

Every check passed: caps kept, purses fell by exactly what was paid,
buyers paid 0.246 mUSDC = sellers received 0.24354 + fees 0.00246, and I1
held (the contract holds exactly what it owes, 559.29 mUSDC). Each job is
also readable on chain: `get_job` with `{"job_id": 49}` to `54`.

## A run with all four rounds on NEAR testnet (2026-11-11, evening)

`Swarm passed.` on `pactora.gopalt.testnet`: 6 listings, 18 bids, 11 jobs
settled on chain (chain jobs 55–65). Every check above passed; buyers paid
0.576 mUSDC = sellers received 0.57004 + fees 0.00596; I1 held. The site's
[`/swarm`](https://pactora-interface-near.vercel.app/swarm) page shows this run.

| Round | Buyer → seller | Price | Chain job | Settling transaction |
|---|---|---|---|---|
| 1 | Buyer 01 → Atlas | 0.021 mUSDC | 55 | [Hs1hZCBb…](https://testnet.nearblocks.io/txns/Hs1hZCBb4cwxRyDVLvRo4Hgj4e6LdX6W99BeHRj4V1ac) |
| 1 | Buyer 02 → Cobalt | 0.03 mUSDC | 56 | [69nHzUed…](https://testnet.nearblocks.io/txns/69nHzUedPA5SQqE8UUVeyx1pZvPHJgE9oX89B414khsM) |
| 1 | Buyer 03 → Cobalt | 0.036 mUSDC | 57 | [Fa55vDoX…](https://testnet.nearblocks.io/txns/Fa55vDoX4VN7BxaYr2hanB8sRrLYtgBgs9D6A9zK19LP) |
| 2 | Buyer 04 → Cobalt | 0.045 mUSDC | 58 | [7LHpJid4…](https://testnet.nearblocks.io/txns/7LHpJid4cj9GRkGhjB9CXJwCZnUp4eSJwAkvE2udEQam) |
| 2 | Buyer 05 → Cobalt | 0.054 mUSDC | 59 | [3AwJggCA…](https://testnet.nearblocks.io/txns/3AwJggCApsypCCbHmcxs4bLhYTfP4Z3QZfw52WYTWpKR) |
| 2 | Buyer 06 → Cobalt | 0.06 mUSDC | 60 | [FbtaXqbL…](https://testnet.nearblocks.io/txns/FbtaXqbLiktMyKm8tAmYsf4tExSta8vLH5fUBDGK7T2M) |
| 3 (pool) | Buyer 01 → Cobalt | 0.1 mUSDC | 61 | [65p54bmo…](https://testnet.nearblocks.io/txns/65p54bmoZJiPnA5Ga3oDppGegvrHemmnDP8GopJ32zAG) |
| 3 (pool) | Buyer 02 → Cobalt | 0.1 mUSDC | 62 | [66qNy9oK…](https://testnet.nearblocks.io/txns/66qNy9oK82oDFEDpnQ8ZC1vR9iANS6WByVSkYXEjeegz) |
| 3 (pool) | Buyer 03 → Cobalt | 0.1 mUSDC | 63 | [4hFWyB41…](https://testnet.nearblocks.io/txns/4hFWyB41w5kXe4oG4XHFm2V3t7owcm1mZtbHheHX86CC) |
| 4 (sub) | Cobalt → Atlas | 0.02 mUSDC | 65 | [DnVdDVaW…](https://testnet.nearblocks.io/txns/DnVdDVaWCyZ87dSGno3DZ6RBkkKfvSmaZnaW3KABcgVt) |
| 4 | Buyer 04 → Cobalt | 0.03 mUSDC | 64 | [31aqPD37…](https://testnet.nearblocks.io/txns/31aqPD37un7u2LygaycBdGBFYEWHiw7CG5P7qKvNDqF2) |

The pool, read back from the contract: jobs 61, 62 and 63 are each
`Settled` with the same `result_hash`
(`df4e29fc93bcd251939c4f8a518354d0f0b4e9eed56c27462c2c0b68af207ea5`), one
delivery paid three times, 0.3 mUSDC in all against a 0.1 mUSDC per-task
cap. In round 4 Cobalt kept 0.0097 mUSDC: 0.03 less the 0.0003 fee less the
0.02 it paid Atlas.
