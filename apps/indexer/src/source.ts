import type {ChainConfig} from '@pactora/config';
import {blockRpc, nearClient, neardataSource, rpcSource, type BlockSource} from '@pactora/near';

/**
 * The chain's block source, after checking it is the network the config names.
 *
 * The RPC must answer `status.chain_id` = `nearNetworkId`; and on neardata the
 * final block it serves must be the block the RPC has at that height — a
 * mainnet neardata URL beside a testnet RPC would otherwise index the wrong
 * network without a single error.
 */
export async function openSource(
  chain: ChainConfig,
  opts: {neardataApiKey?: string} = {},
): Promise<BlockSource> {
  const client = nearClient(chain.rpcUrl);
  const network = await client.networkId();
  if (network !== chain.nearNetworkId) {
    throw new Error(
      `chain ${chain.chainId}: RPC ${chain.rpcUrl} is network "${network}", the config says "${chain.nearNetworkId}"`,
    );
  }
  const rpc = blockRpc(chain.rpcUrl);
  if (chain.blockSource.kind === 'rpc') return rpcSource(rpc);

  const source = neardataSource(chain.blockSource.url, fetch, opts.neardataApiKey);
  // A height both have as final: the lower of the two heads, a real block on either.
  const height = Math.min(await source.finalHeight(), (await client.finalBlock()).height);
  const served = await source.blockAt(height);
  // An RPC that has never seen the height answers with an error, not null
  // (testnet: "Block either has never been observed on the node or has been
  // garbage collected") — the same verdict, so it gets the same message.
  const onRpc = await rpc.block(height).then(
    (b) => b?.header.hash ?? 'no block',
    (err: unknown) => {
      const message = (err as Error).message ?? '';
      // Anything else is the RPC failing to answer: rethrown, so it reads as an outage.
      if (!/never been observed|garbage collected|UNKNOWN_BLOCK/i.test(message)) throw err;
      return `no block (${message})`;
    },
  );
  if (!served || served.hash !== onRpc) {
    throw new Error(
      `chain ${chain.chainId}: neardata ${chain.blockSource.url} block ${height} is ${served?.hash ?? 'missing'}, ` +
        `RPC ${chain.rpcUrl} has ${onRpc} — not the same network`,
    );
  }
  return source;
}
