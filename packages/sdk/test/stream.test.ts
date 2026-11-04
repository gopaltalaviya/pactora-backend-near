import {describe, expect, it} from 'vitest';
import {PactoraClient} from '../src/index.js';

/**
 * The SSE reader in `subscribe()`.
 *
 * Its buffer exists because a chunk boundary can land anywhere, including
 * inside a frame — and half a frame parsed as a whole one is a dropped event.
 * On the demo page a dropped event is a payment the viewer never sees, which
 * is the one thing that page exists to show.
 *
 * Frames are assembled by joining with a real newline rather than writing
 * escapes, so nothing here depends on how this file was generated.
 */

const LF = String.fromCharCode(10);

/** One SSE frame: `event: <name>`, `data: <json>`, blank line. */
const frame = (event: string, data: string) => ['event: ' + event, 'data: ' + data, '', ''].join(LF);

/** A fetch whose response body yields exactly these chunks. */
function streaming(chunks: string[]): typeof fetch {
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        },
      }),
      {status: 200, headers: {'content-type': 'text/event-stream'}},
    );
}

function client(impl: typeof fetch) {
  return new PactoraClient({baseUrl: 'http://api.test', apiKey: 'ax_test', fetchImpl: impl});
}

/** Subscribes, lets the reader drain, and returns what arrived. */
async function collect(chunks: string[]): Promise<{event: string; data: unknown}[]> {
  const seen: {event: string; data: unknown}[] = [];
  client(streaming(chunks)).subscribe('1', (event, data) => seen.push({event, data}));
  await new Promise((r) => setTimeout(r, 40));
  return seen;
}

describe('reading the event stream', () => {
  it('reads a single frame', async () => {
    expect(await collect([frame('job.created', '{"jobId":"1"}')])).toEqual([
      {event: 'job.created', data: {jobId: '1'}},
    ]);
  });

  it('reads several frames delivered in one chunk', async () => {
    const seen = await collect([frame('job.created', '{}') + frame('job.settled', '{}')]);
    expect(seen.map((s) => s.event)).toEqual(['job.created', 'job.settled']);
  });

  /**
   * The case the buffer is for: the same bytes, split at an awkward point.
   * Every split of one frame must produce exactly one event.
   */
  it('reassembles a frame split at any byte boundary', async () => {
    const whole = frame('job.settled', '{"jobId":"9"}');
    for (let cut = 1; cut < whole.length; cut++) {
      const seen = await collect([whole.slice(0, cut), whole.slice(cut)]);
      expect(seen, `split at byte ${cut}`).toEqual([{event: 'job.settled', data: {jobId: '9'}}]);
    }
  });

  it('holds a trailing partial frame back instead of emitting half of one', async () => {
    const partial = frame('job.settled', '{"jobId":"9"}').slice(0, 20);
    const seen = await collect([frame('job.created', '{}'), partial]);
    expect(seen.map((s) => s.event)).toEqual(['job.created']);
  });

  /** A malformed frame must not take the stream down with it. */
  it('drops a frame whose data is not JSON and keeps reading', async () => {
    const seen = await collect([frame('bad', 'not-json') + frame('good', '{"ok":true}')]);
    expect(seen.map((s) => s.event)).toEqual(['good']);
  });

  it('ignores a heartbeat comment', async () => {
    const seen = await collect([': keep-alive' + LF + LF + frame('job.settled', '{}')]);
    expect(seen.map((s) => s.event)).toEqual(['job.settled']);
  });

  it('returns an unsubscribe function', async () => {
    const seen: string[] = [];
    const stop = client(streaming([frame('a', '{}')])).subscribe('1', (e) => seen.push(e));
    expect(typeof stop).toBe('function');
    stop();
    await new Promise((r) => setTimeout(r, 40));
  });

  /**
   * A dropped stream is not fatal — `awaitResult` polls independently, so the
   * caller still makes progress.
   */
  it('does not throw when the response has no body', async () => {
    const impl = (async () => new Response(null, {status: 200})) as unknown as typeof fetch;
    expect(() => client(impl).subscribe('1', () => undefined)).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });
});
