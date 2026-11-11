import type {FastifyReply, FastifyRequest} from 'fastify';

/**
 * Server-Sent Events.
 *
 * SSE rather than WebSockets: the traffic is one-directional, it survives
 * proxies that mangle upgrades, and it reconnects on its own. The demo page
 * is the main consumer and it only ever listens.
 *
 * The bus is keyed by a numeric topic — a job id on one instance, a run id on
 * another. Two instances rather than one shared namespace, because job 7 and
 * run 7 are unrelated and a single map keyed by number would quietly deliver
 * one's events to the other's subscribers.
 */

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
  /**
   * The stored row's id. Sent as the SSE `id:`, so a reconnecting
   * EventSource says where it got to and is sent only what came after.
   */
  id?: number;
}

/**
 * Where a reconnecting client got to: the `Last-Event-ID` an EventSource
 * sends by itself, or `?lastEventId=` for a client that cannot set headers.
 * Anything but a non-negative integer is ignored — a full replay is the safe
 * answer to a value we cannot read.
 */
export function lastEventIdOf(request: FastifyRequest): number | null {
  const header = request.headers['last-event-id'];
  const query = (request.query as {lastEventId?: unknown} | undefined)?.lastEventId;
  const raw = typeof header === 'string' ? header : typeof query === 'string' ? query : undefined;
  return raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

type Subscriber = (event: StreamEvent) => void;

export class EventBus {
  private readonly byTopic = new Map<number, Set<Subscriber>>();
  /** Open SSE streams, so shutdown can end them rather than wait on them. */
  private readonly streams = new Set<() => void>();
  /** Open streams per client address. */
  private readonly byClient = new Map<string, number>();

  /**
   * @param maxStreams open SSE connections this instance will hold. Each is a
   *   socket and a heartbeat timer; without a ceiling one client could open
   *   them until the process ran out of file descriptors.
   * @param maxStreamsPerClient open streams one address may hold. The total
   *   alone let one client take every slot and answer everyone else 503.
   */
  constructor(
    readonly maxStreams = 1_000,
    readonly maxStreamsPerClient = 20,
  ) {}

  get streamCount(): number {
    return this.streams.size;
  }

  /** Streams `client` holds now. */
  streamsOf(client: string): number {
    return this.byClient.get(client) ?? 0;
  }

  /** @internal */
  track(close: () => void, client = ''): () => void {
    this.streams.add(close);
    this.byClient.set(client, this.streamsOf(client) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.streams.delete(close);
      const left = this.streamsOf(client) - 1;
      if (left > 0) this.byClient.set(client, left);
      else this.byClient.delete(client);
    };
  }

  /**
   * End every open stream. Called on shutdown: an SSE connection never ends
   * by itself, so without this `app.close()` waited out the shutdown timeout
   * on every deploy. The client's EventSource reconnects to a live instance.
   */
  closeAll(): void {
    for (const close of [...this.streams]) close();
  }

  publish(topicId: number, event: StreamEvent): void {
    for (const fn of this.byTopic.get(topicId) ?? []) {
      try {
        fn(event);
      } catch {
        // A broken subscriber must never stop the others, and must never
        // propagate into the request that triggered the publish.
      }
    }
  }

  subscribe(topicId: number, fn: Subscriber): () => void {
    let set = this.byTopic.get(topicId);
    if (!set) {
      set = new Set();
      this.byTopic.set(topicId, set);
    }
    set.add(fn);

    return () => {
      set.delete(fn);
      // Drop the key when the last listener leaves, or a long-running process
      // accumulates one empty Set per job it has ever served.
      if (set.size === 0) this.byTopic.delete(topicId);
    };
  }

  get subscriberCount(): number {
    let n = 0;
    for (const set of this.byTopic.values()) n += set.size;
    return n;
  }
}

/**
 * A stored event row as the stream sends it. One mapping for the replay and
 * the live path (live.ts), so a client cannot tell which one delivered it.
 */
export function streamEventOf(row: {id: number; kind: string; payload: unknown}): StreamEvent {
  return {event: row.kind, data: (row.payload ?? {}) as Record<string, unknown>, id: row.id};
}

const HEARTBEAT_MS = 25_000;
/**
 * Ids one stream remembers having sent. The same row arrives twice on an
 * instance that recorded it — its own publish, then the NOTIFY echo — and
 * again if it lands in the replay too. Bounded, oldest out: a duplicate
 * follows its first copy closely — only a replay longer than this could
 * push the first copy out.
 */
const SENT_IDS = 10_000;

/**
 * Stream one topic's events to one client until it disconnects.
 *
 * The heartbeat is not decoration: proxies and load balancers close idle
 * connections, and a demo page that silently stops updating looks identical
 * to a demo that crashed.
 *
 * @param replay loads what already happened. A function, not an array: it
 *   runs AFTER the subscription, so nothing committed between the query and
 *   the subscribe falls through the gap. If it throws, nothing has been sent
 *   and the caller's error handler answers as for any route.
 */
export async function streamEvents(
  reply: FastifyReply,
  bus: EventBus,
  topicId: number,
  replay: () => Promise<StreamEvent[]> = async () => [],
): Promise<void> {
  // Writing to the raw socket skips Fastify's reply pipeline, and with it
  // the headers hooks have already set on the reply — CORS above all. Without
  // them a browser on another origin (the site, in production) refuses the
  // stream, and a live run looks frozen. So carry them over explicitly.
  const prepared = reply.getHeaders() as Record<string, string | number | string[]>;

  // `request.ip` is the client only where TRUST_PROXY says how many proxies
  // to believe; otherwise every client behind the proxy shares one share.
  const client = reply.request.ip;
  const full = bus.streamCount >= bus.maxStreams;
  if (full || bus.streamsOf(client) >= bus.maxStreamsPerClient) {
    reply.raw.writeHead(503, {...prepared, 'content-type': 'application/problem+json', 'retry-after': '5'});
    reply.raw.end(
      JSON.stringify({
        type: 'https://pactoragents.com/errors/upstream-unavailable',
        title: 'Too many open streams',
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        detail: full
          ? `this instance holds ${bus.maxStreams} streams; retry shortly`
          : `one client may hold ${bus.maxStreamsPerClient} streams; close one or retry shortly`,
        retryAfter: 5,
      }),
    );
    return;
  }

  // Dedupe by id, never by "id <= last sent": bigserial ids are taken at
  // insert and become visible at commit, so the indexer can commit id 10
  // after the API commits 11. Skipping by order would drop 10 for good.
  const sent = new Set<number>();
  const send = (e: StreamEvent) => {
    if (e.id !== undefined) {
      if (sent.has(e.id)) return;
      sent.add(e.id);
      if (sent.size > SENT_IDS) sent.delete(sent.values().next().value as number);
    }
    const id = e.id !== undefined ? `id: ${e.id}\n` : '';
    reply.raw.write(`${id}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  };

  // Subscribe BEFORE the replay query, holding live events until the
  // replay is written. v2 replayed and then subscribed, and an event
  // committed in between was in neither: lost, not late.
  let held: StreamEvent[] | null = [];
  const unsubscribe = bus.subscribe(topicId, (e) => (held ? held.push(e) : send(e)));

  let heartbeat: ReturnType<typeof setInterval> | undefined = undefined; // started once the headers are out
  let closed = false;
  // Tracked from here, not after the replay: the cap counts a stream still
  // waiting on its query, or a burst of them could all pass the check above.
  const untrack = bus.track(() => close(), client);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    untrack();
    reply.raw.end();
  };
  reply.raw.on('close', close);
  reply.raw.on('error', close);

  let past: StreamEvent[];
  try {
    past = await replay();
  } catch (err) {
    // Nothing written yet, so the route can still answer with a problem.
    closed = true;
    unsubscribe();
    untrack();
    reply.raw.off('close', close);
    reply.raw.off('error', close);
    throw err;
  }
  // The client left, or shutdown began, while the query ran.
  if (closed) return;

  reply.raw.writeHead(200, {
    ...prepared,
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // nginx buffers SSE into uselessness otherwise
  });
  // Send the headers NOW. Node holds them until the first write, so a client
  // watching a quiet run — nothing to replay, nothing published yet — saw no
  // response at all until the first heartbeat, 25 s later. The retry hint
  // tells EventSource how soon to reconnect after a deploy ends the stream.
  reply.raw.write('retry: 3000\n\n');

  // Replay what already happened, so a client that connects late sees the
  // whole story rather than joining halfway through — then what arrived
  // while it was loading.
  for (const e of past) send(e);
  const live = held;
  held = null;
  for (const e of live) send(e);

  heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), HEARTBEAT_MS);
}
