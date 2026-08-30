import { env } from "../../config/env.js";
import { InMemoryBlockchainAdapter } from "./memoryAdapter.js";
import { EvmBlockchainAdapter } from "./evmAdapter.js";
import type { BlockchainAdapter } from "./types.js";

export * from "./types.js";
export { InMemoryBlockchainAdapter } from "./memoryAdapter.js";

let instance: BlockchainAdapter | null = null;

/**
 * Adapter selection. "auto" upgrades to the real chain the moment complete credentials
 * are present — no separate feature flag, because a flag is one more thing to forget
 * and the failure mode (silently writing nothing to a chain you believe you're using)
 * is exactly the kind of thing this product exists to prevent.
 */
export function createBlockchainAdapter(): BlockchainAdapter {
  const wantsEvm = env.BLOCKCHAIN_ADAPTER === "evm";
  const hasCreds = Boolean(
    env.CHAIN_RPC_URL && env.CHAIN_PRIVATE_KEY &&
    env.IDENTITY_REGISTRY_ADDRESS && env.ASSET_REGISTRY_ADDRESS &&
    env.AGENT_REGISTRY_ADDRESS && env.PROOF_REGISTRY_ADDRESS,
  );

  if ((wantsEvm || env.BLOCKCHAIN_ADAPTER === "auto") && hasCreds) {
    return new EvmBlockchainAdapter({
      rpcUrl: env.CHAIN_RPC_URL,
      privateKey: env.CHAIN_PRIVATE_KEY,
      chainId: env.CHAIN_ID,
      identityRegistry: env.IDENTITY_REGISTRY_ADDRESS,
      assetRegistry: env.ASSET_REGISTRY_ADDRESS,
      agentRegistry: env.AGENT_REGISTRY_ADDRESS,
      proofRegistry: env.PROOF_REGISTRY_ADDRESS,
    });
  }

  if (wantsEvm && !hasCreds) {
    throw new Error(
      "BLOCKCHAIN_ADAPTER=evm but chain credentials are incomplete. Set CHAIN_RPC_URL, CHAIN_PRIVATE_KEY and all four registry addresses, or use BLOCKCHAIN_ADAPTER=memory.",
    );
  }

  return new InMemoryBlockchainAdapter();
}

export function getBlockchainAdapter(): BlockchainAdapter {
  if (!instance) instance = createBlockchainAdapter();
  return instance;
}

export function setBlockchainAdapter(adapter: BlockchainAdapter) { instance = adapter; }
