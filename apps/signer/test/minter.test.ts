import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {loadConfig, type ChainConfig} from '@pactora/config';
import {KeyPair, TGAS, keyPairKey, nearClient} from '@pactora/near';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {
  MINT_GAS,
  MINT_STORAGE_DEPOSIT,
  STORAGE_YOCTO_PER_BYTE,
  assertMinterMatches,
  makeMinter,
  mintStorageBytes,
} from '../src/minter.js';
import {MintBody} from '../src/app.js';
import {FakeNear} from './helpers/fake-near.js';

/**
 * The work-credential minter (feature/work-credentials): a separate account,
 * the credentials contract's `minter`, that calls `nft_mint` and nothing
 * else. Serial sends on one nonce high-water mark, like the faucet; a
 * contract refusal is a PactoraError (nothing minted), an unknown outcome is
 * not (the API keeps its claim and checks `nft_token` before trying again).
 */
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../chain', import.meta.url)),
  env: {ENABLED_CHAINS: 'near:sandbox'},
});
const BASE = config.chain('near:sandbox');
const CREDENTIALS = 'credentials.test.near';
const CHAIN: ChainConfig = {...BASE, contracts: {...BASE.contracts, Credentials: CREDENTIALS}};
const KP = KeyPair.fromRandom('ed25519');
const MINTER = {accountId: 'minter.test.near', key: keyPairKey(KP)};
const METADATA = {
  title: 'Pactora job #7',
  description: 'A credential.',
  media: 'data:image/svg+xml;base64,PHN2Zy8+',
  issued_at: '1800000000000',
  extra: '{"chainJobId":"7"}',
};

const fake = new FakeNear();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.addKey(MINTER.accountId, MINTER.key.publicKey, 'FullAccess', 100n);
});
const near = () => nearClient(fake.url, {retries: 1});

describe('the minter', () => {
  it('calls nft_mint on the credentials contract, from the minter, with gas and a storage deposit', async () => {
    const minter = makeMinter({near: near(), chain: CHAIN, account: MINTER});
    const out = await minter.mint('7', 'worker.test.near', METADATA);
    expect(fake.state.sent).toHaveLength(1);
    const tx = fake.state.sent[0]!;
    expect(tx).toMatchObject({
      signerId: MINTER.accountId,
      receiverId: CREDENTIALS,
      method: 'nft_mint',
      gas: MINT_GAS,
      deposit: MINT_STORAGE_DEPOSIT,
      nonce: 101n,
    });
    expect(tx.args).toEqual({token_id: '7', receiver_id: 'worker.test.near', metadata: METADATA});
    expect(out).toEqual({txHash: tx.hash});
    expect(MINT_GAS).toBe(50n * TGAS);
  });

  it('sends one at a time, each on the next nonce', async () => {
    const minter = makeMinter({near: near(), chain: CHAIN, account: MINTER});
    await Promise.all([
      minter.mint('1', 'a.test.near', METADATA),
      minter.mint('2', 'b.test.near', METADATA),
      minter.mint('3', 'c.test.near', METADATA),
    ]);
    expect(fake.state.sent.map((t) => t.nonce)).toEqual([101n, 102n, 103n]);
    expect(fake.state.sent.map((t) => t.args['token_id'])).toEqual(['1', '2', '3']);
  });

  it('a contract refusal is a PactoraError: nothing was minted', async () => {
    fake.state.onSend = () => ({kind: 'panic', name: 'TokenExists'});
    const minter = makeMinter({near: near(), chain: CHAIN, account: MINTER});
    const err = await minter.mint('7', 'worker.test.near', METADATA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PactoraError);
    expect((err as PactoraError).code).toBe(ErrorCode.INVALID_STATE);
  });

  it('a duplicate token id is its own code, outside the "nothing minted" ones: the token exists', async () => {
    // near-contract-standards' nft_mint: `require!(..., "token_id must be unique")`.
    fake.state.onSend = () => ({kind: 'panic', name: 'token_id must be unique'});
    const minter = makeMinter({near: near(), chain: CHAIN, account: MINTER});
    const err = await minter.mint('7', 'worker.test.near', METADATA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PactoraError);
    expect((err as PactoraError).code).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
    expect((err as PactoraError).detail).toMatch(/token 7 already exists/);
  });

  it('an unknown outcome is NOT a PactoraError: the caller must not assume nothing was minted', async () => {
    fake.state.onSend = () => ({kind: 'timeout', lands: false});
    const minter = makeMinter({near: nearClient(fake.url, {retries: 0}), chain: CHAIN, account: MINTER});
    const err = await minter.mint('7', 'worker.test.near', METADATA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PactoraError);
  });

  it('runs on a test chain with a credentials contract only', () => {
    expect(() => makeMinter({near: near(), chain: BASE, account: MINTER})).toThrow(/Credentials/);
    expect(() => makeMinter({near: near(), chain: {...CHAIN, testnet: false}, account: MINTER})).toThrow(
      /testnet/,
    );
  });
});

describe('the minter startup check', () => {
  const nearAnswering = (minter: string | Error) => ({
    view: async <T>(): Promise<T> => {
      if (minter instanceof Error) throw minter;
      return minter as T;
    },
  });

  it("passes when MINTER_ACCOUNT_ID is the contract's minter", async () => {
    await expect(
      assertMinterMatches(nearAnswering(MINTER.accountId), CREDENTIALS, MINTER),
    ).resolves.toBeUndefined();
  });

  it('refuses another account, naming both', async () => {
    await expect(assertMinterMatches(nearAnswering('other.test.near'), CREDENTIALS, MINTER)).rejects.toThrow(
      /MINTER_ACCOUNT_ID minter\.test\.near is not .*other\.test\.near.*refusing to start/,
    );
  });

  it('refuses to start when the minter cannot be read', async () => {
    await expect(
      assertMinterMatches(nearAnswering(new Error('fetch failed')), CREDENTIALS, MINTER),
    ).rejects.toThrow(/could not read the credentials contract's minter.*refusing to start/);
  });
});

describe('the storage deposit', () => {
  // The longest values MintBody accepts, field by field.
  const caps = MintBody.shape.metadata.shape;
  const MAX = {
    tokenId: '9'.repeat(20),
    receiverId: `${'a'.repeat(56)}.testnet`,
    metadata: {
      title: 't'.repeat(caps.title.maxLength!),
      description: 'd'.repeat(caps.description.maxLength!),
      media: 'data:image/svg+xml;base64,' + 'A'.repeat(caps.media.maxLength! - 26),
      issued_at: '9'.repeat(16),
      extra: 'x'.repeat(caps.extra.maxLength!),
    },
  };

  it('the largest body MintBody accepts fits in MINT_STORAGE_DEPOSIT, with at least 20% to spare', () => {
    expect(MAX.receiverId).toHaveLength(64);
    expect(MintBody.safeParse(MAX).success).toBe(true);
    const cost = BigInt(mintStorageBytes(MAX.tokenId, MAX.receiverId, MAX.metadata)) * STORAGE_YOCTO_PER_BYTE;
    expect(cost * 10n).toBeLessThanOrEqual(MINT_STORAGE_DEPOSIT * 8n);
  });

  it('counts the metadata bytes and a per-record overhead', () => {
    const small = mintStorageBytes('7', 'w.testnet', METADATA);
    const bigger = mintStorageBytes('7', 'w.testnet', {...METADATA, extra: METADATA.extra + 'x'.repeat(100)});
    expect(bigger - small).toBe(100);
    expect(small).toBeGreaterThan(5 * 40);
  });
});
