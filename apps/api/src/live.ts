import {eq} from 'drizzle-orm';
import {jobEvents, runEvents, type Db} from '@pactora/db';
import {streamEventOf, type EventBus} from './events.js';

/**
 * Live events from every writer, not just this process (v3).
 *
 * The bus is in memory, so a stream used to carry only what its own process
 * published. The indexer is another process, and a second API replica is
 * another again: their events reached a client only on its next reconnect.
 * Migration 0009 NOTIFYs every stored job and run event; this LISTENs, loads
 * the row and publishes it here, in the shape a replay sends.
 *
 * An event this instance recorded itself arrives twice — its own publish,
 * then the echo. streamEvents drops the second by id, so nothing here tries
 * to tell them apart.
 */
export const EVENTS_CHANNEL = 'pactora_events';

export interface LiveDeps {
  db: Db;
  bus: EventBus;
  runBus: EventBus;
  log: (err: unknown, msg: string) => void;
  /** How long boot waits for the first LISTEN before carrying on without it. */
  listenWaitMs?: number;
}

type Listening = {unlisten: () => Promise<void>};
type Notice = {kind: 'job' | 'run'; id: number};

/** Start listening; resolves once LISTEN is in place, or after `listenWaitMs`. Returns the stop function. */
export async function listenForEvents(deps: LiveDeps): Promise<() => Promise<void>> {
  const client = deps.db.$client;

  // One at a time, in arrival order. Each notice waits on a query; run
  // concurrently, a fast load could overtake a slow one and a client would
  // see a job's events out of order.
  let queue = Promise.resolve();
  const onNotify = (raw: string) => {
    queue = queue
      .then(() => handle(raw))
      .catch((err: unknown) => deps.log(err, 'live event: could not deliver'));
  };

  async function handle(raw: string): Promise<void> {
    const notice = parse(raw);
    if (!notice) {
      deps.log(new Error(`unreadable notice: ${raw.slice(0, 200)}`), 'live event: ignored');
      return;
    }
    if (notice.kind === 'job') {
      const [row] = await deps.db.select().from(jobEvents).where(eq(jobEvents.id, notice.id));
      // Gone already (a cascade from a deleted job): nothing to show.
      if (row) deps.bus.publish(row.jobId, streamEventOf(row));
    } else {
      const [row] = await deps.db.select().from(runEvents).where(eq(runEvents.id, notice.id));
      if (row) deps.runBus.publish(row.runId, streamEventOf(row));
    }
  }

  // postgres.js re-LISTENs by itself after a dropped connection, and keeps
  // trying through an outage (checked: 11 s of an unreachable host, past
  // connect_timeout). Notices sent while it was gone are not replayed: a
  // client that reconnects gets them from its Last-Event-ID.
  //
  // The first LISTEN retries the same way, so with the database down it
  // neither resolves nor fails. The API boots with the database down
  // (`/ready` says so); waited on, it would not boot at all. So wait a
  // little, then let it finish in the background.
  let listening: Listening | null = null;
  let stopped = false;
  const pending = client.listen(EVENTS_CHANNEL, onNotify).then(
    (l) => {
      if (stopped) void l.unlisten().catch(() => undefined);
      else listening = l;
      return true;
    },
    (err: unknown) => {
      deps.log(err, 'live events: could not LISTEN; streams carry only what this instance publishes');
      return false;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    pending,
    new Promise<null>((r) => (timer = setTimeout(() => r(null), deps.listenWaitMs ?? 3_000))),
  ]);
  clearTimeout(timer);
  if (ready === null) {
    deps.log(
      new Error('LISTEN not in place yet'),
      'live events: database unreachable; listening when it is back',
    );
  }

  return async () => {
    stopped = true;
    // Never waits on a LISTEN still pending: closing the pool ends it.
    await listening?.unlisten();
  };
}

function parse(raw: string): Notice | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if ((v['kind'] === 'job' || v['kind'] === 'run') && Number.isSafeInteger(v['id'])) {
      return {kind: v['kind'], id: v['id'] as number};
    }
  } catch {
    // fall through: not JSON
  }
  return null;
}
