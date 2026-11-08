import type {FastifyInstance} from 'fastify';
import {and, count, eq, sql, sum} from 'drizzle-orm';
import {faucetClaims, type Db} from '@pactora/db';
import type {ChainConfig} from '@pactora/config';
import {ErrorCode, PactoraError} from '@pactora/shared';
import {authenticatePerson} from '../auth.js';
import type {FaucetSend} from '../submit.js';

/**
 * Test tokens for people trying Pactora on testnet (docs/26 F23).
 *
 * Testnet and sandbox only. A signed-in person claims a fixed amount for
 * their own account: once per account per UTC day, at most `perIpPerDay`
 * claims from one address, and at most `dailyCap` base units for everyone
 * together. The signer sends from a separate faucet account with a limited
 * float, under its own per-send cap; the token owner's key is never used.
 *
 * The limits are checked and the claim written under one advisory lock per
 * chain and day, so two claims at once cannot both slip under a cap. A send
 * the signer definitely refused frees the claim (try again); one whose
 * outcome is unknown keeps it, so a transfer that did land is never paid
 * twice.
 */

export interface FaucetConfig {
  /** Base units per claim. */
  amount: bigint;
  perIpPerDay: number;
  /** Base units for everyone, per UTC day. */
  dailyCap: bigint;
}

export interface FaucetRouteDeps {
  db: Db;
  chains: Record<string, ChainConfig>;
  send?: FaucetSend;
  config: FaucetConfig;
  now?: () => Date;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** The codes after which the signer certainly sent nothing. */
const NOT_SENT = new Set<string>([ErrorCode.BUDGET_EXCEEDED, ErrorCode.SCHEMA_MISMATCH, ErrorCode.FORBIDDEN]);

export async function registerFaucetRoutes(app: FastifyInstance, deps: FaucetRouteDeps): Promise<void> {
  const {db, config} = deps;
  const now = deps.now ?? (() => new Date());

  const usage = async (chainId: string, day: string, account: string, ip: string) => {
    const [mine] = await db
      .select({n: count()})
      .from(faucetClaims)
      .where(
        and(eq(faucetClaims.chainId, chainId), eq(faucetClaims.account, account), eq(faucetClaims.day, day)),
      );
    const [fromIp] = await db
      .select({n: count()})
      .from(faucetClaims)
      .where(and(eq(faucetClaims.ip, ip), eq(faucetClaims.day, day)));
    const [total] = await db
      .select({s: sum(faucetClaims.amount)})
      .from(faucetClaims)
      .where(and(eq(faucetClaims.chainId, chainId), eq(faucetClaims.day, day)));
    return {mine: Number(mine?.n ?? 0), fromIp: Number(fromIp?.n ?? 0), total: BigInt(total?.s ?? '0')};
  };

  app.get('/v1/faucet', async (request) => {
    const person = await authenticatePerson(db, request);
    const chain = deps.chains[person.chainId];
    const day = utcDay(now());
    const u = await usage(person.chainId, day, person.account, request.ip);
    return {
      available: Boolean(chain?.testnet && deps.send),
      testnet: Boolean(chain?.testnet),
      amount: config.amount.toString(),
      claimedToday: u.mine > 0,
      day,
      remainingToday: (config.dailyCap > u.total ? config.dailyCap - u.total : 0n).toString(),
    };
  });

  app.post('/v1/faucet', async (request, reply) => {
    const person = await authenticatePerson(db, request);
    const chain = deps.chains[person.chainId];
    if (!chain?.testnet) {
      throw new PactoraError(
        ErrorCode.FORBIDDEN,
        'the faucet exists on testnet only — real tokens are never given away',
      );
    }
    if (!deps.send)
      throw new PactoraError(ErrorCode.UPSTREAM_UNAVAILABLE, 'no faucet is configured on this server');
    const day = utcDay(now());
    const ip = request.ip;

    const claim = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`faucet:${person.chainId}:${day}`}))`);
      const u = await usage(person.chainId, day, person.account, ip);
      if (u.mine > 0) {
        throw new PactoraError(
          ErrorCode.LIMIT_REACHED,
          `${person.account} already claimed today (UTC ${day})`,
        );
      }
      if (u.fromIp >= config.perIpPerDay) {
        throw new PactoraError(
          ErrorCode.LIMIT_REACHED,
          `at most ${config.perIpPerDay} claims per address per day`,
        );
      }
      if (u.total + config.amount > config.dailyCap) {
        throw new PactoraError(
          ErrorCode.LIMIT_REACHED,
          'the faucet has given out all it may today; try tomorrow',
        );
      }
      const [row] = await tx
        .insert(faucetClaims)
        .values({chainId: person.chainId, account: person.account, ip, amount: config.amount.toString(), day})
        .returning();
      return row!;
    });

    try {
      const sent = await deps.send(person.account, config.amount, request.id);
      await db
        .update(faucetClaims)
        .set({status: 'sent', txHash: sent.txHash})
        .where(eq(faucetClaims.id, claim.id));
      return reply.status(201).send({
        account: person.account,
        amount: config.amount.toString(),
        txHash: sent.txHash,
        explorerUrl: chain.explorerTx(sent.txHash),
        registered: sent.registered,
        from: sent.from,
      });
    } catch (err) {
      const code = err instanceof PactoraError ? err.code : null;
      if (code && NOT_SENT.has(code)) {
        await db.delete(faucetClaims).where(eq(faucetClaims.id, claim.id));
      } else {
        await db.update(faucetClaims).set({status: 'failed'}).where(eq(faucetClaims.id, claim.id));
      }
      throw err;
    }
  });
}
