/**
 * NEP-297 events → what the indexer stores (docs/NEAR-PORT.md §7).
 *
 * Two inputs, both already parsed from `EVENT_JSON:` log lines by
 * @pactora/near's `eventsOf`:
 *
 * - the Pactora contract's own events, `standard: "pactora"`, version
 *   "1.0.0" — `emit()` in events.rs, which always wraps ONE data object in an
 *   array;
 * - the payment token's NEP-141 `ft_transfer` events (near-contract-standards
 *   `FtTransfer::emit_many`), whose data array may list several transfers.
 *
 * Payloads use the camelCase keys the projection and the API read (the EVM
 * build's names, so `payload->>'outcome'` and `payload->>'reason'` keep
 * working): agent ids become `<role>AgentId`, every u64 becomes a decimal
 * string, U128 amounts stay the decimal strings the contract wrote.
 */
import type {Nep297Event} from '@pactora/near';

export const PACTORA_STANDARD = 'pactora';
export const PACTORA_VERSION = '1.0.0';

export interface DecodedJobEvent {
  kind: string;
  /** The contract's job id, decimal. */
  chainJobId: string;
  payload: Record<string, unknown>;
}

type FieldType = 'u64' | 'u128' | 'hash' | 'hash?' | 'string' | 'bool' | 'outcome' | 'outcome?';
type Field = readonly [type: FieldType, from: string, to: string];

/** The contract's `Outcome` enum, as serde writes a unit variant. */
const OUTCOMES = new Set(['Success', 'Failed', 'DisputeLost', 'Unresolved']);

/**
 * Every job event in events.rs, its kind (the names the EVM build used, kept
 * so the API's queries do not change) and its fields. Events not listed —
 * agent_registered, review, funded, caps_set, transfer_* and the rest — are
 * not part of a job's lifecycle and are ignored.
 */
const JOB_EVENTS: Record<string, {kind: string; fields: readonly Field[]}> = {
  job_created: {
    kind: 'created',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['u64', 'client', 'clientAgentId'],
      ['u64', 'worker', 'workerAgentId'],
      ['u128', 'amount', 'amount'],
      ['u128', 'fee', 'fee'],
      ['hash', 'spec_hash', 'specHash'],
      ['u64', 'accept_deadline', 'acceptDeadline'],
      ['u64', 'work_deadline', 'workDeadline'],
    ],
  },
  job_accepted: {
    kind: 'accepted',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['u64', 'worker', 'workerAgentId'],
      ['u128', 'bond', 'bond'],
      ['u64', 'work_deadline', 'workDeadline'],
    ],
  },
  result_submitted: {
    kind: 'submitted',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['hash', 'result_hash', 'resultHash'],
      ['u64', 'review_deadline', 'reviewDeadline'],
    ],
  },
  job_disputed: {
    kind: 'disputed',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['u128', 'dispute_bond', 'disputeBond'],
      ['u64', 'dispute_deadline', 'disputeDeadline'],
      ['hash?', 'reason_hash', 'reasonHash'],
    ],
  },
  dispute_resolved: {
    kind: 'dispute_resolved',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['bool', 'for_worker', 'forWorker'],
      ['string', 'arbiter', 'arbiter'],
    ],
  },
  dispute_expired: {kind: 'dispute_expired', fields: [['u64', 'job_id', 'jobId']]},
  job_settled: {
    kind: 'settled',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['u64', 'worker', 'workerAgentId'],
      ['u128', 'paid', 'paid'],
      ['u128', 'fee', 'fee'],
      ['outcome', 'outcome', 'outcome'],
    ],
  },
  job_refunded: {
    kind: 'refunded',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['u64', 'client', 'clientAgentId'],
      ['u128', 'amount', 'amount'],
      ['string', 'reason', 'reason'],
      ['outcome?', 'outcome', 'outcome'],
    ],
  },
  bond_seized: {
    kind: 'bond_seized',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['u64', 'worker', 'workerAgentId'],
      ['u64', 'client', 'clientAgentId'],
      ['u128', 'amount', 'amount'],
    ],
  },
  dispute_bond_settled: {
    kind: 'dispute_bond_settled',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['u64', 'to', 'toAgentId'],
      ['u128', 'amount', 'amount'],
    ],
  },
  direct_paid: {
    kind: 'direct_paid',
    fields: [
      ['u64', 'job_id', 'jobId'],
      ['u64', 'client', 'clientAgentId'],
      ['u64', 'worker', 'workerAgentId'],
      ['u128', 'amount', 'amount'],
      ['u128', 'fee', 'fee'],
      ['hash', 'spec_hash', 'specHash'],
    ],
  },
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One field, checked and converted; throws naming it. */
function field(type: FieldType, name: string, v: unknown, where: string): unknown {
  const bad = (want: string): never => {
    throw new Error(`${where}: field ${name} must be ${want}, got ${JSON.stringify(v)}`);
  };
  switch (type) {
    case 'u64':
      // A JSON number. JSON.parse rounds anything above 2^53, so an id it
      // could not hold exactly is refused rather than stored wrong.
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) bad('a u64 below 2^53');
      return String(v);
    case 'u128':
      if (typeof v !== 'string' || !/^(0|[1-9]\d*)$/.test(v)) bad('a decimal string (U128)');
      return v;
    case 'hash?':
      if (v === null) return null;
      if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) bad('null or 64 lowercase hex');
      return v;
    case 'hash':
      if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) bad('64 lowercase hex');
      return v;
    case 'string':
      if (typeof v !== 'string') bad('a string');
      return v;
    case 'bool':
      if (typeof v !== 'boolean') bad('a boolean');
      return v;
    case 'outcome?':
      if (v === null) return null;
      if (typeof v !== 'string' || !OUTCOMES.has(v)) bad(`null or one of ${[...OUTCOMES].join(', ')}`);
      return v;
    case 'outcome':
      if (typeof v !== 'string' || !OUTCOMES.has(v)) bad(`one of ${[...OUTCOMES].join(', ')}`);
      return v;
  }
}

/**
 * A Pactora job event, decoded; null for an event that is not one.
 *
 * Throws on a `pactora` event this code cannot read exactly — another
 * version, or a known event with a missing or mistyped field. Those come
 * from the protocol's own contract, so they mean a contract upgrade this
 * indexer was not updated for, and money events misread are worse than an
 * indexer that stops and says why.
 */
export function decodePactoraEvent(e: Nep297Event): DecodedJobEvent | null {
  if (e.standard !== PACTORA_STANDARD) return null;
  if (e.version !== PACTORA_VERSION) {
    throw new Error(
      `pactora event ${e.event} has version ${e.version}; this indexer reads ${PACTORA_VERSION} only`,
    );
  }
  const spec = JOB_EVENTS[e.event];
  if (!spec) return null;

  const where = `pactora ${e.event}`;
  if (!Array.isArray(e.data) || e.data.length !== 1 || !isObject(e.data[0])) {
    throw new Error(`${where}: data must be an array of exactly one object, as emit() writes it`);
  }
  const data = e.data[0];
  const payload: Record<string, unknown> = {};
  for (const [type, from, to] of spec.fields) {
    if (!(from in data)) throw new Error(`${where}: field ${from} is missing`);
    payload[to] = field(type, from, data[from], where);
  }
  return {kind: spec.kind, chainJobId: payload['jobId'] as string, payload};
}

export interface FtTransferEntry {
  from: string;
  to: string;
  /** Base units, decimal. */
  amount: string;
  /** Position in the event's data array. */
  entry: number;
}

/**
 * The transfers in one NEP-141 `ft_transfer` event; [] for anything else.
 *
 * `ft_mint` and `ft_burn` are left out on purpose: a mint has no sender and a
 * burn no receiver, so neither can be money moving from one side of a hire to
 * the other — which is all the funding graph asks (packages/db trust.ts joins
 * `from_address` to the worker's side). A malformed entry is skipped rather
 * than halting the indexer: the token may be a third party's contract, and
 * one bad entry must not stop the protocol's own events being indexed.
 */
export function decodeFtTransfers(e: Nep297Event): FtTransferEntry[] {
  if (e.standard !== 'nep141' || e.event !== 'ft_transfer' || !Array.isArray(e.data)) return [];
  const out: FtTransferEntry[] = [];
  e.data.forEach((d: unknown, entry) => {
    if (!isObject(d)) return;
    const {old_owner_id: from, new_owner_id: to, amount} = d;
    if (typeof from !== 'string' || typeof to !== 'string') return;
    if (typeof amount !== 'string' || !/^(0|[1-9]\d*)$/.test(amount)) return;
    out.push({from, to, amount, entry});
  });
  return out;
}
