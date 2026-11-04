/**
 * Graceful shutdown, and a process that does not limp on after an error.
 *
 * A deploy sends SIGTERM and waits. Without a handler the process died with
 * requests in flight — a signing request half-done, an SSE stream cut — and
 * the database pool was never closed. And with no `unhandledRejection`
 * handler, an unhandled promise failure was logged by Node and ignored,
 * leaving a service running in a state nobody had reasoned about.
 *
 * Closers run IN ORDER: stop accepting work first (the HTTP server drains
 * its in-flight requests), then release what the work was using.
 */
export interface ShutdownLogger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  fatal: (obj: unknown, msg?: string) => void;
}

export interface ShutdownHandle {
  shutdown: (reason: string, code?: number) => Promise<void>;
  /** Resolves when shutdown has begun, for loops that should stop. */
  signal: AbortSignal;
}

export function installShutdown(opts: {
  logger: ShutdownLogger;
  closers: Array<readonly [name: string, close: () => Promise<unknown>]>;
  timeoutMs?: number;
  exit?: (code: number) => void;
  process?: NodeJS.EventEmitter;
}): ShutdownHandle {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const proc = opts.process ?? process;
  const controller = new AbortController();
  let running: Promise<void> | null = null;

  const shutdown = (reason: string, code = 0): Promise<void> => {
    if (running) return running;
    controller.abort();
    running = (async () => {
      opts.logger.info({reason}, 'shutting down');
      const timer = setTimeout(() => {
        opts.logger.error({timeoutMs: opts.timeoutMs ?? 10_000}, 'shutdown timed out; exiting anyway');
        exit(code === 0 ? 1 : code);
      }, opts.timeoutMs ?? 10_000);
      timer.unref?.();
      for (const [name, close] of opts.closers) {
        try {
          await close();
        } catch (err) {
          opts.logger.error({err, closer: name}, 'close failed');
        }
      }
      clearTimeout(timer);
      exit(code);
    })();
    return running;
  };

  proc.on('SIGTERM', () => void shutdown('SIGTERM'));
  proc.on('SIGINT', () => void shutdown('SIGINT'));
  proc.on('unhandledRejection', (err: unknown) => {
    opts.logger.fatal({err}, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  proc.on('uncaughtException', (err: unknown) => {
    opts.logger.fatal({err}, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  return {shutdown, signal: controller.signal};
}
