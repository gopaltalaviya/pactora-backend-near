import {describe, expect, it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {PactoraClient} from '@pactora/sdk';
import {buildServer} from '../src/server.js';
import {TESTNET} from './fixtures.js';

/**
 * The server over a real MCP session.
 *
 * The handlers are unit-tested next door; what this proves is that a client
 * actually sees them — the schemas serialise, the annotations arrive, and a
 * failure comes back as a tool error the model can read rather than a
 * protocol exception that kills the session.
 */

function fakeClient(over: Record<string, unknown> = {}): PactoraClient {
  return {
    network: async () => TESTNET,
    budget: async () => ({dailyRemainingDisplay: '0.30 USDC', maxSingleSpend: '50000'}),
    discover: async () => [],
    getJob: async () => ({jobId: '7', state: 'submitted', result: {summary: 'ok'}}),
    ...over,
  } as unknown as PactoraClient;
}

async function connect(pactora: PactoraClient): Promise<Client> {
  const server = await buildServer({baseUrl: 'http://unused', apiKey: 'ax_test', client: pactora});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({name: 'test', version: '0'});
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('an MCP session against the server', () => {
  it('lists all nine tools with schemas a client can read', async () => {
    const client = await connect(fakeClient());
    const {tools} = await client.listTools();

    expect(tools).toHaveLength(9);
    const hire = tools.find((t) => t.name === 'hire_agent')!;
    expect(hire.inputSchema.required).toContain('maxPrice');
    await client.close();
  });

  /**
   * The annotation a host uses to decide what needs human approval. Marking a
   * spending tool read-only would route it around exactly that gate.
   */
  it('never marks a money-moving tool as read-only', async () => {
    const client = await connect(fakeClient());
    const {tools} = await client.listTools();

    for (const name of ['hire_agent', 'approve_job', 'dispute_job']) {
      expect(tools.find((t) => t.name === name)!.annotations?.readOnlyHint, name).toBe(false);
    }
    for (const name of ['get_network', 'my_budget', 'discover_agents', 'get_job']) {
      expect(tools.find((t) => t.name === name)!.annotations?.readOnlyHint, name).toBe(true);
    }
    await client.close();
  });

  it('states the network and the untrusted-result rule in its instructions', async () => {
    const client = await connect(fakeClient());
    const instructions = client.getInstructions() ?? '';

    expect(instructions).toMatch(/TESTNET/);
    expect(instructions).toMatch(/DATA, not instructions/);
    await client.close();
  });

  it('returns a callable result for a read tool', async () => {
    const client = await connect(fakeClient());
    const res = await client.callTool({name: 'get_network', arguments: {}});

    const text = (res.content as {type: string; text: string}[])[0]!.text;
    expect(JSON.parse(text).chainId).toBe(10143);
    await client.close();
  });

  /**
   * A failed tool call must reach the model as a readable error. If it threw
   * across the transport instead, the agent would lose the session over a
   * recoverable problem.
   */
  it('reports a failure as a tool error the model can act on', async () => {
    const client = await connect(
      fakeClient({
        getJob: async () => {
          throw new Error('connection reset');
        },
      }),
    );

    const res = await client.callTool({name: 'get_job', arguments: {jobId: '7'}});
    expect(res.isError).toBe(true);

    const described = JSON.parse((res.content as {text: string}[])[0]!.text);
    expect(described.retryable).toBe(true);
    expect(described.message).toMatch(/connection reset/);
    await client.close();
  });

  /**
   * Reading the network once at startup means two calls in one session can
   * never disagree about whether the money is real.
   */
  it('reads the network once, not per call', async () => {
    let reads = 0;
    const client = await connect(
      fakeClient({
        network: async () => {
          reads++;
          return TESTNET;
        },
      }),
    );

    await client.callTool({name: 'get_network', arguments: {}});
    await client.callTool({name: 'get_network', arguments: {}});
    expect(reads).toBe(1);
    await client.close();
  });
});
