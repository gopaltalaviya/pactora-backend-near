import {createServer, type IncomingMessage, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {eq, sql} from 'drizzle-orm';
import {agents, closeDb, createDb, jobEvents, jobs, webhookDeliveries, webhooks, type Db} from '@pactora/db';
import {parseSecretKey, seal, verifyWebhookSignature} from '@pactora/service';
import {backoffMs, DISABLE_AFTER, MAX_ATTEMPTS, Notifier} from '../src/notifier.js';

/**
 * The webhook sender against real Postgres and a real HTTP server on
 * 127.0.0.1 (allowed by the local-development policy; the default policy's
 * refusal of it is tested too).
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near';
const KEY = parseSecretKey('5313643a55b27f4c0d4c73f6eed14b9b868db94394795300629cdad4d7419fae');
const LOCAL = {allowHttp: true, allowPrivate: true};

let db: Db;
let server: Server;
let base: string;
type Hit = {path: string; headers: IncomingMessage['headers']; body: string};
let hits: Hit[] = [];
/** path → status to answer, or 'hang' */
const behaviour = new Map<string, number | 'hang'>();

beforeAll(async () => {
  db = createDb(DB_URL, {max: 10});
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url ?? '/';
      hits.push({path, headers: req.headers, body});
      const b = behaviour.get(path) ?? 200;
      if (b === 'hang') return;
      res.writeHead(b).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb(db);
});
beforeEach(async () => {
  hits = [];
  behaviour.clear();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_events, agent_event_seq, webhooks, webhook_deliveries RESTART IDENTITY CASCADE`,
  );
});

let n = 0;
async function agentRow(): Promise<{id: number; publicId: string}> {
  const k = ++n;
  const [a] = await db
    .insert(agents)
    .values({
      chainId: 'near:sandbox',
      ownerAddress: `owner${k}.test.near`,
      walletAddress: `wallet${k}.owner${k}.test.near`,
      name: `A${k}`,
      pricePerTask: '1000',
    })
    .returning({id: agents.id, publicId: agents.publicId});
  return a!;
}

async function hook(agentId: number, path: string, secret = `whsec_test${++n}`) {
  const publicId = crypto.randomUUID();
  await db.insert(webhooks).values({
    publicId,
    agentId,
    url: `${base}${path}`,
    secretEnc: seal(KEY, secret, `webhook:${publicId}`),
  });
  return {publicId, secret};
}

async function event(clientId: number, workerId: number, kind = 'job.settled') {
  const [j] = await db
    .insert(jobs)
    .values({
      chainId: 'near:sandbox',
      clientAgentId: clientId,
      workerAgentId: workerId,
      path: 'escrow',
      amount: '1000',
      spec: {capability: 'x'},
      specHash: 'ab'.repeat(32),
    })
    .returning({id: jobs.id, publicId: jobs.publicId});
  await db.insert(jobEvents).values({chainId: 'near:sandbox', jobId: j!.id, kind, payload: {amount: '1000'}});
  return j!;
}

const deliveriesOf = async (publicId: string) => {
  const [h] = await db.select().from(webhooks).where(eq(webhooks.publicId, publicId));
  return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, h!.id));
};

describe('delivery', () => {
  it('posts the event, signed so the documented recipe verifies it, and records it delivered', async () => {
    const c = await agentRow();
    const w = await agentRow();
    const h = await hook(c.id, '/ok');
    const job = await event(c.id, w.id);
    const notifier = new Notifier({db, secretKey: KEY, policy: LOCAL});
    expect(await notifier.runOnce()).toBe(1);

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    const body = JSON.parse(hit.body);
    expect(body).toMatchObject({
      webhookId: h.publicId,
      agentId: c.publicId,
      seq: 1,
      kind: 'job.settled',
      role: 'client',
      jobId: job.publicId,
    });
    expect(hit.headers['pactora-delivery']).toBe(body.deliveryId);
    const sig = String(hit.headers['pactora-signature']);
    expect(verifyWebhookSignature(h.secret, sig, body.deliveryId, hit.body)).toBe(true);
    // Each part of the recipe matters.
    expect(verifyWebhookSignature('whsec_wrong', sig, body.deliveryId, hit.body)).toBe(false);
    expect(verifyWebhookSignature(h.secret, sig, crypto.randomUUID(), hit.body)).toBe(false);
    expect(verifyWebhookSignature(h.secret, sig, body.deliveryId, hit.body.replace('1000', '9000'))).toBe(
      false,
    );
    const t = Number(/t=(\d+)/.exec(sig)![1]);
    expect(verifyWebhookSignature(h.secret, sig, body.deliveryId, hit.body, {nowS: t + 301})).toBe(false);

    const [d] = await deliveriesOf(h.publicId);
    expect(d).toMatchObject({status: 'delivered', attempts: 1, lastStatus: 200});
    expect(await notifier.runOnce()).toBe(0);
  });

  it('retries a failing endpoint with backoff, gives up after 8 tries, and counts it against the hook', async () => {
    const c = await agentRow();
    const w = await agentRow();
    const h = await hook(c.id, '/fail');
    behaviour.set('/fail', 500);
    await event(c.id, w.id);
    let now = new Date(Date.now() + 1000); // just after the rows' real-time defaults
    const notifier = new Notifier({db, secretKey: KEY, policy: LOCAL, now: () => now});
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      expect(await notifier.runOnce()).toBe(1);
      const [d] = await deliveriesOf(h.publicId);
      if (i < MAX_ATTEMPTS) {
        expect(d).toMatchObject({status: 'pending', attempts: i, lastStatus: 500});
        expect(d!.nextAttemptAt.getTime() - now.getTime()).toBe(backoffMs(i));
        // Not due yet: nothing is sent.
        expect(await notifier.runOnce()).toBe(0);
        now = new Date(d!.nextAttemptAt.getTime() + 1);
      } else {
        expect(d).toMatchObject({status: 'failed', attempts: MAX_ATTEMPTS});
      }
    }
    expect(hits).toHaveLength(MAX_ATTEMPTS);
    const [row] = await db.select().from(webhooks).where(eq(webhooks.publicId, h.publicId));
    expect(row!.consecutiveFailures).toBe(1);
    expect(row!.active).toBe(true);
  });

  it(`switches a hook off after ${DISABLE_AFTER} deliveries in a row gave up, saying why`, async () => {
    const c = await agentRow();
    const w = await agentRow();
    const h = await hook(c.id, '/dead');
    await db
      .update(webhooks)
      .set({consecutiveFailures: DISABLE_AFTER - 1})
      .where(eq(webhooks.publicId, h.publicId));
    await event(c.id, w.id);
    await db.update(webhookDeliveries).set({attempts: MAX_ATTEMPTS - 1});
    behaviour.set('/dead', 503);
    await new Notifier({db, secretKey: KEY, policy: LOCAL}).runOnce();
    const [row] = await db.select().from(webhooks).where(eq(webhooks.publicId, h.publicId));
    expect(row!.active).toBe(false);
    expect(row!.disabledReason).toMatch(/in a row failed; last: answered 503/);
  });

  it('a success resets the hook’s failure count', async () => {
    const c = await agentRow();
    const w = await agentRow();
    const h = await hook(c.id, '/ok');
    await db.update(webhooks).set({consecutiveFailures: 4}).where(eq(webhooks.publicId, h.publicId));
    await event(c.id, w.id);
    await new Notifier({db, secretKey: KEY, policy: LOCAL}).runOnce();
    const [row] = await db.select().from(webhooks).where(eq(webhooks.publicId, h.publicId));
    expect(row!.consecutiveFailures).toBe(0);
  });

  it('does not follow a redirect: a 3xx is a failed try', async () => {
    const c = await agentRow();
    const w = await agentRow();
    const h = await hook(c.id, '/moved');
    behaviour.set('/moved', 302);
    await event(c.id, w.id);
    await new Notifier({db, secretKey: KEY, policy: LOCAL}).runOnce();
    expect(hits.map((x) => x.path)).toEqual(['/moved']);
    const [d] = await deliveriesOf(h.publicId);
    expect(d).toMatchObject({status: 'pending', lastStatus: 302});
  });

  it('with the production policy, a hook that now points at a private address is not sent to', async () => {
    const c = await agentRow();
    const w = await agentRow();
    const h = await hook(c.id, '/ok'); // 127.0.0.1
    await event(c.id, w.id);
    await new Notifier({db, secretKey: KEY}).runOnce();
    expect(hits).toHaveLength(0);
    const [d] = await deliveriesOf(h.publicId);
    expect(d!.lastError).toMatch(/refused target: must be https/);
  });

  it('a secret sealed under another key is not used: the try fails, nothing is sent unsigned', async () => {
    const c = await agentRow();
    const w = await agentRow();
    const h = await hook(c.id, '/ok');
    await event(c.id, w.id);
    await new Notifier({
      db,
      secretKey: parseSecretKey('5df0ddee0e9062d65ba255aaa30e020f76b9eb0b4d1a7f87f3756ef2d24865e0'),
      policy: LOCAL,
    }).runOnce();
    expect(hits).toHaveLength(0);
    const [d] = await deliveriesOf(h.publicId);
    expect(d!.status).toBe('pending');
  });
});

describe('fairness and concurrency', () => {
  it('a hanging endpoint does not hold up another agent’s delivery', async () => {
    const a = await agentRow();
    const b = await agentRow();
    const w = await agentRow();
    const slow = await hook(a.id, '/hang');
    const fast = await hook(b.id, '/ok');
    behaviour.set('/hang', 'hang');
    await event(a.id, w.id);
    await event(b.id, w.id);
    const notifier = new Notifier({db, secretKey: KEY, policy: LOCAL, timeoutMs: 3000});
    const round = notifier.runOnce();
    const t0 = Date.now();
    let fastDone = false;
    while (Date.now() - t0 < 2500) {
      const [d] = await deliveriesOf(fast.publicId);
      if (d?.status === 'delivered') {
        fastDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fastDone).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2500);
    await round;
    const [s] = await deliveriesOf(slow.publicId);
    expect(s).toMatchObject({status: 'pending', attempts: 1});
    expect(s!.lastError).toMatch(/timed out/);
  });

  it('one webhook gets one delivery per round, oldest first', async () => {
    const c = await agentRow();
    const w = await agentRow();
    const h = await hook(c.id, '/ok');
    for (let i = 0; i < 3; i++) await event(c.id, w.id);
    const notifier = new Notifier({db, secretKey: KEY, policy: LOCAL});
    for (let i = 1; i <= 3; i++) {
      expect(await notifier.runOnce()).toBe(1);
      expect(JSON.parse(hits.at(-1)!.body).seq).toBe(i);
    }
    expect((await deliveriesOf(h.publicId)).every((d) => d.status === 'delivered')).toBe(true);
  });

  it('two notifiers at once never send the same delivery twice', async () => {
    const owners = await Promise.all(Array.from({length: 6}, () => agentRow()));
    const w = await agentRow();
    for (const o of owners) {
      await hook(o.id, `/ok-${o.id}`);
      await event(o.id, w.id);
    }
    const one = new Notifier({db, secretKey: KEY, policy: LOCAL, concurrency: 6});
    const two = new Notifier({db, secretKey: KEY, policy: LOCAL, concurrency: 6});
    const [x, y] = await Promise.all([one.runOnce(), two.runOnce()]);
    expect(x + y).toBe(6);
    const ids = hits.map((h) => JSON.parse(h.body).deliveryId);
    expect(new Set(ids).size).toBe(6);
    expect(ids).toHaveLength(6);
  });

  it('a lease left by a notifier that died is taken over once it expires', async () => {
    const c = await agentRow();
    const w = await agentRow();
    const h = await hook(c.id, '/ok');
    await event(c.id, w.id);
    let now = new Date(Date.now() + 1000); // just after the rows' real-time defaults
    const dead = new Notifier({db, secretKey: KEY, policy: LOCAL, now: () => now, leaseMs: 60_000});
    expect(await dead.claim()).toHaveLength(1); // claimed, then "crashed"
    const alive = new Notifier({db, secretKey: KEY, policy: LOCAL, now: () => now});
    expect(await alive.runOnce()).toBe(0);
    now = new Date(now.getTime() + 61_000);
    expect(await alive.runOnce()).toBe(1);
    const [d] = await deliveriesOf(h.publicId);
    expect(d!.status).toBe('delivered');
  });
});
