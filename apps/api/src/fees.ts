import type {Params} from '@pactora/config';

/**
 * The protocol fee on a job of `amount`, exactly as the contract computes it
 * (`fee_of`, contracts/pactora/src/lib.rs): `max(amount × bps / 10000,
 * min_fee)`, integer division.
 *
 * It is taken from the WORKER's payout when the job settles — the client
 * pays `amount` and not a unit more, the worker receives `amount − fee` —
 * and is not charged at all on a refund. So everything the client is asked
 * to reserve or spend is the amount alone (docs/26 F21).
 */
export function feeOf(amount: bigint, params: Pick<Params, 'protocolFeeBps' | 'minFee'>): bigint {
  const bps = (amount * BigInt(params.protocolFeeBps)) / 10_000n;
  return bps > params.minFee ? bps : params.minFee;
}

/** What a worker receives for a job of `amount` that settles in its favour. */
export function workerReceives(amount: bigint, params: Pick<Params, 'protocolFeeBps' | 'minFee'>): bigint {
  const net = amount - feeOf(amount, params);
  return net > 0n ? net : 0n;
}
