import { createPublicClient, createWalletClient, http, keccak256, toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IDENTITY_REGISTRY_ABI, ASSET_REGISTRY_ABI, AGENT_REGISTRY_ABI, PROOF_REGISTRY_ABI } from "./abi.js";
import type { BlockchainAdapter, OnChainAgent, OnChainAsset, OnChainIdentity, OnChainProof, TxReceipt } from "./types.js";

/**
 * Real EVM adapter. Selected automatically when RPC URL, private key and contract
 * addresses are all present (see index.ts) — there is no separate "enable real chain"
 * switch to forget to flip.
 *
 * The signing key used here is the deployer/operator key and is deliberately kept
 * separate from every application credential: compromising the API does not by itself
 * grant the ability to write to the registries.
 */
export class EvmBlockchainAdapter implements BlockchainAdapter {
  readonly kind = "evm" as const;
  readonly chainId: string;
  readonly addresses: Record<string, string | null>;

  private publicClient: any;
  private walletClient: any;
  private account: any;

  constructor(cfg: {
    rpcUrl: string; privateKey: string; chainId: string;
    identityRegistry: string; assetRegistry: string; agentRegistry: string; proofRegistry: string;
  }) {
    this.chainId = cfg.chainId;
    this.addresses = {
      identityRegistry: cfg.identityRegistry,
      assetRegistry: cfg.assetRegistry,
      agentRegistry: cfg.agentRegistry,
      proofRegistry: cfg.proofRegistry,
    };
    const chain = { id: Number(cfg.chainId), name: `chain-${cfg.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } } as any;
    this.account = privateKeyToAccount(cfg.privateKey as `0x${string}`);
    this.publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(cfg.rpcUrl) });
  }

  /** Token ids are strings application-side; on-chain they are uint256. keccak of the
   *  string keeps that mapping deterministic and collision-resistant. */
  private tokenIdToUint(tokenId: string): bigint {
    return BigInt(keccak256(toHex(tokenId)));
  }

  private async write(address: string, abi: any, functionName: string, args: any[]): Promise<TxReceipt> {
    const hash = await this.walletClient.writeContract({ address: address as Address, abi, functionName, args });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash, blockNumber: Number(receipt.blockNumber), chainId: this.chainId, simulated: false };
  }

  private async read(address: string, abi: any, functionName: string, args: any[]): Promise<any> {
    return this.publicClient.readContract({ address: address as Address, abi, functionName, args });
  }

  async registerIdentity(didCommitment: string) {
    return this.write(this.addresses.identityRegistry!, IDENTITY_REGISTRY_ABI, "registerIdentity", [didCommitment]);
  }
  async setIdentityStatus(didCommitment: string, status: number) {
    return this.write(this.addresses.identityRegistry!, IDENTITY_REGISTRY_ABI, "setStatus", [didCommitment, status]);
  }
  async getIdentity(didCommitment: string): Promise<OnChainIdentity> {
    try {
      const r = await this.read(this.addresses.identityRegistry!, IDENTITY_REGISTRY_ABI, "getIdentity", [didCommitment]);
      return { didCommitment, status: Number(r.status), exists: Boolean(r.exists) };
    } catch { return { didCommitment, status: 0, exists: false }; }
  }

  async mintAsset(p: { tokenId: string; ownerCommitment: string; metadataCommitment: string }) {
    return this.write(this.addresses.assetRegistry!, ASSET_REGISTRY_ABI, "mintAsset",
      [this.tokenIdToUint(p.tokenId), p.ownerCommitment, p.metadataCommitment]);
  }
  async transferAsset(p: { tokenId: string; newOwnerCommitment: string }) {
    return this.write(this.addresses.assetRegistry!, ASSET_REGISTRY_ABI, "transferAsset",
      [this.tokenIdToUint(p.tokenId), p.newOwnerCommitment]);
  }
  async setAssetFrozen(tokenId: string, frozen: boolean) {
    return this.write(this.addresses.assetRegistry!, ASSET_REGISTRY_ABI, "setFrozen", [this.tokenIdToUint(tokenId), frozen]);
  }
  async revokeAsset(tokenId: string) {
    return this.write(this.addresses.assetRegistry!, ASSET_REGISTRY_ABI, "revokeAsset", [this.tokenIdToUint(tokenId)]);
  }
  async getAsset(tokenId: string): Promise<OnChainAsset> {
    try {
      const r = await this.read(this.addresses.assetRegistry!, ASSET_REGISTRY_ABI, "getAsset", [this.tokenIdToUint(tokenId)]);
      return { tokenId, ownerCommitment: r.ownerCommitment, metadataCommitment: r.metadataCommitment,
        frozen: Boolean(r.frozen), revoked: Boolean(r.revoked), exists: Boolean(r.exists) };
    } catch {
      return { tokenId, ownerCommitment: "0x", metadataCommitment: "0x", frozen: false, revoked: false, exists: false };
    }
  }

  async registerAgent(p: { agentCommitment: string; didCommitment: string; policyCommitment: string }) {
    return this.write(this.addresses.agentRegistry!, AGENT_REGISTRY_ABI, "registerAgent",
      [p.agentCommitment, p.didCommitment, p.policyCommitment]);
  }
  async setAgentPolicy(agentCommitment: string, policyCommitment: string) {
    return this.write(this.addresses.agentRegistry!, AGENT_REGISTRY_ABI, "setPolicy", [agentCommitment, policyCommitment]);
  }
  async setAgentActive(agentCommitment: string, active: boolean) {
    return this.write(this.addresses.agentRegistry!, AGENT_REGISTRY_ABI, "setActive", [agentCommitment, active]);
  }
  async getAgent(agentCommitment: string): Promise<OnChainAgent> {
    try {
      const r = await this.read(this.addresses.agentRegistry!, AGENT_REGISTRY_ABI, "getAgent", [agentCommitment]);
      return { didCommitment: r.didCommitment, policyCommitment: r.policyCommitment, active: Boolean(r.active), exists: Boolean(r.exists) };
    } catch { return { didCommitment: "0x", policyCommitment: "0x", active: false, exists: false }; }
  }

  async anchorProof(p: { commitment: string; subjectCommitment: string }) {
    return this.write(this.addresses.proofRegistry!, PROOF_REGISTRY_ABI, "anchorProof", [p.commitment, p.subjectCommitment]);
  }
  async getProof(commitment: string): Promise<OnChainProof> {
    try {
      const r = await this.read(this.addresses.proofRegistry!, PROOF_REGISTRY_ABI, "getProof", [commitment]);
      return { commitment, subjectCommitment: r.subjectCommitment, timestamp: Number(r.timestamp), exists: Boolean(r.exists) };
    } catch { return { commitment, subjectCommitment: "0x", timestamp: 0, exists: false }; }
  }

  async health() {
    try {
      const block = await this.publicClient.getBlockNumber();
      return { ok: true, detail: `Connected to chain ${this.chainId} at block ${block}. Operator ${this.account.address}.` };
    } catch (e: any) {
      return { ok: false, detail: `RPC unreachable: ${e?.message ?? e}` };
    }
  }
}
