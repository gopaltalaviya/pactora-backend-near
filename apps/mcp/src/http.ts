import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {PactoraClient, type NetworkInfo} from '@pactora/sdk';
import {buildServer} from './server.js';

/**
 * The same MCP server over streamable HTTP (2026-11-09), for an agent that
 * runs somewhere else: `POST /mcp` with `Authorization: Bearer ax_…` — the
 * agent's own API key, which is what every tool then acts with. stdio stays
 * the default (main.ts); this is on when MCP_HTTP_PORT is set.
 *
 * Stateless: every request gets its own transport and server, built on the
 * caller's key, so nothing of one agent's session can reach another's. The
 * one thing cached per key is the network reading (`GET /v1/network`,
 * 10 min), which the server's instructions and every spending result state.
 *
 * Browsers are not the audience. A request carrying an `Origin` header is
 * refused unless the origin is in `allowedOrigins`, so a page cannot make a
 * visitor's browser drive an agent's key (DNS rebinding, CSRF-style). A key
 * may make `rateLimitPerMinute` requests a minute (default 60); past it, 429.
 */

export interface McpHttpOptions {
  port: number;
  host?: string;
  /** The Pactora API the tools call. */
  baseUrl: string;
  chainId?: string;
  /** Origins a browser may call from; default none (any `Origin` header is refused). */
  allowedOrigins?: string[];
  rateLimitPerMinute?: number;
  /** Tests: the client to use instead of a real PactoraClient for the key. */
  clientFor?: (apiKey: string) => PactoraClient;
  log?: (line: string) => void;
}

export interface McpHttpServer {
  url: string;
  close(): Promise<void>;
}

const KEY_PATTERN = /^ax_[0-9a-f]{16}_[A-Za-z0-9_-]{32}$/;
const NETWORK_TTL_MS = 10 * 60_000;

export async function serveMcpHttp(opts: McpHttpOptions): Promise<McpHttpServer> {
  const host = opts.host ?? '127.0.0.1';
  const limit = opts.rateLimitPerMinute ?? 60;
  const allowed = new Set((opts.allowedOrigins ?? []).map((o) => o.replace(/\/$/, '').toLowerCase()));
  const log = opts.log ?? (() => undefined);

  /** Per key (hashed: the key itself is never held longer than the request): the network, and the minute's hits. */
  const byKey = new Map<string, {network?: NetworkInfo; networkAt: number; hits: number[]}>();
  const stateOf = (apiKey: string) => {
    const id = createHash('sha256').update(apiKey).digest('hex');
    let s = byKey.get(id);
    if (!s) {
      s = {networkAt: 0, hits: []};
      byKey.set(id, s);
    }
    return s;
  };

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, {'content-type': 'application/json', ...headers});
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') return json(res, 200, {ok: true, transport: 'streamable-http'});
    if (url.pathname !== '/mcp') return json(res, 404, {error: 'POST /mcp is the only endpoint here'});
    if (req.method !== 'POST') {
      // Stateless: no server-initiated stream (GET) and no session to end (DELETE).
      return json(res, 405, {error: 'POST only: this server is stateless'}, {allow: 'POST'});
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !allowed.has(origin.replace(/\/$/, '').toLowerCase())) {
      return json(res, 403, {error: `origin ${origin} is not allowed to call this MCP server`});
    }
    const auth = req.headers.authorization ?? '';
    const match = /^bearer\s+(\S+)$/i.exec(auth);
    const apiKey = match?.[1];
    if (!apiKey || !KEY_PATTERN.test(apiKey)) {
      return json(
        res,
        401,
        {error: 'Authorization: Bearer <Pactora agent API key (ax_...)> is required'},
        {'www-authenticate': 'Bearer realm="pactora-mcp"'},
      );
    }

    const state = stateOf(apiKey);
    const now = Date.now();
    state.hits = state.hits.filter((t) => now - t < 60_000);
    if (state.hits.length >= limit) {
      return json(res, 429, {error: `at most ${limit} requests a minute per key`}, {'retry-after': '60'});
    }
    state.hits.push(now);

    const client =
      opts.clientFor?.(apiKey) ??
      new PactoraClient({baseUrl: opts.baseUrl, apiKey, ...(opts.chainId ? {chainId: opts.chainId} : {})});
    try {
      if (!state.network || now - state.networkAt > NETWORK_TTL_MS) {
        state.network = await client.network();
        state.networkAt = now;
      }
    } catch (err) {
      return json(res, 502, {
        error: `the Pactora API did not answer: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const server = await buildServer({baseUrl: opts.baseUrl, apiKey, client, network: state.network});
    // No sessionIdGenerator: stateless. Plain JSON answers: a tool call is one
    // request and one reply, and no SSE stream is held open per request.
    const transport = new StreamableHTTPServerTransport({enableJsonResponse: true});
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    // The SDK's transport types predate exactOptionalPropertyTypes (its
    // optional handlers are typed `| undefined`); the object is the right one.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`mcp http: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(res, 500, {error: 'internal error'});
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return {
    url: `http://${host}:${port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
