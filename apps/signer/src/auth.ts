import {timingSafeEqual} from 'node:crypto';

/**
 * Who may ask the signer to sign.
 *
 * It signs for any agent, to any target, on request — so reaching it is the
 * whole game. It relied entirely on private networking, while listening on
 * every interface: one misconfigured Railway service, or a port forwarded on
 * a laptop, and anyone could spend any agent's budget.
 *
 * With `SIGNER_TOKEN` set, a request must present it. Without one, the signer
 * binds to loopback only (see `bindHost`), so the only callers are processes
 * on the same machine.
 */
export function authorised(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  // Constant time, and the length check first because timingSafeEqual throws
  // on unequal lengths.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Where to listen. Every interface only when a token guards the door;
 * otherwise loopback, and a request for anything wider is refused outright
 * rather than quietly served.
 */
export function bindHost(env: NodeJS.ProcessEnv): string {
  const requested = env['SIGNER_HOST'];
  if (env['SIGNER_TOKEN']) return requested ?? '0.0.0.0';
  if (requested && requested !== '127.0.0.1' && requested !== '::1' && requested !== 'localhost') {
    throw new Error(`SIGNER_HOST=${requested} without SIGNER_TOKEN would expose an unauthenticated signer`);
  }
  return '127.0.0.1';
}
