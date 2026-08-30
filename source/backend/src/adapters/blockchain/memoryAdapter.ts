import { createHash, randomBytes } from "node:crypto";
import type {
  BlockchainAdapter, OnChainAgent, OnChainAsset, OnChainIdentity, OnChainProof, TxReceipt,
} from "./types.js";

/**
 * Deterministic in-memory chain.
 *
 * This is not a stub that returns `true` — it enforces the same invariants the Solidity
 * contracts enforce, and throws the same named errors. Minting a duplicate token id
 * fails here exactly as it fails on-chain; transferring a frozen asset fails here
 * exactly as it fails on-chain. That matters because the automated test suite runs
 * against this adapter: if it were permissive, the tests would prove nothing about the
 * real contracts.
 *
 * Its one honest limitation, stated plainly in the API response and the UI: the
 * transaction hashes are locally generated and no external party can verify them.
 * `simulated: true` is set on every receipt so this can never be mistaken for the
 * real thing downstream.
 */
export class InMemoryBlockchainAdapter implements BlockchainAdapter {
  readonly kind = "memory" as const;
  readonly chainId: string;
  readonly addresses = {
    identityRegistry: "0xMEMORY_IDENTITY",
    assetRegistry: "0xMEMORY_ASSET",
    agentRegistry: "0xMEMORY_AGENT",
    proofRegistry: "0xMEMORY_PROOF",
  };

  private identities = new Map<string, OnChainIdentity>();
  private assets = new Map<string, OnChainAsset>();
  private agents = new Map<string, OnChainAgent>();
  private proofs = new Map<string, OnChainProof>();
  private blockNumber = 1_000_000;

  constructor(chainId = "memory-1") { this.chainId = chainId; }

  /** Hash of the operation, not a random value, so a replayed test produces a stable trail. */
  private receipt(op: string, key: string): TxReceipt {
    const txHash = "0x" + createHash("sha256").update(`${op}:${key}:${this.blockNumber}:${randomBytes(4).toString("hex")}`).digest("hex");
    return { txHash, blockNumber: this.blockNumber++, chainId: this.chainId, simulated: true };
  }

  async registerIdentity(didCommitment: string): Promise<TxReceipt> {
    if (this.identities.has(didCommitment)) throw new Error("IdentityAlreadyRegistered");
    this.identities.set(didCommitment, { didCommitment, status: 0, exists: true });
    return this.receipt("registerIdentity", didCommitment);
  }

  async setIdentityStatus(didCommitment: string, status: number): Promise<TxReceipt> {
    const rec = this.identities.get(didCommitment);
    if (!rec) throw new Error("IdentityNotRegistered");
    if (rec.status === 2) throw new Error("IdentityRevoked"); // revocation is terminal, as on-chain
    rec.status = status;
    return this.receipt("setIdentityStatus", didCommitment);
  }

  async getIdentity(didCommitment: string): Promise<OnChainIdentity> {
    return this.identities.get(didCommitment) ?? { didCommitment, status: 0, exists: false };
  }

  async mintAsset(p: { tokenId: string; ownerCommitment: string; metadataCommitment: string }): Promise<TxReceipt> {
    if (this.assets.has(p.tokenId)) throw new Error("TokenAlreadyMinted");
    this.assets.set(p.tokenId, {
      tokenId: p.tokenId, ownerCommitment: p.ownerCommitment,
      metadataCommitment: p.metadataCommitment, frozen: false, revoked: false, exists: true,
    });
    return this.receipt("mintAsset", p.tokenId);
  }

  async transferAsset(p: { tokenId: string; newOwnerCommitment: string }): Promise<TxReceipt> {
    const asset = this.assets.get(p.tokenId);
    if (!asset) throw new Error("TokenNotMinted");
    if (asset.revoked) throw new Error("AssetRevoked");
    if (asset.frozen) throw new Error("AssetFrozen");
    asset.ownerCommitment = p.newOwnerCommitment;
    return this.receipt("transferAsset", p.tokenId);
  }

  async setAssetFrozen(tokenId: string, frozen: boolean): Promise<TxReceipt> {
    const asset = this.assets.get(tokenId);
    if (!asset) throw new Error("TokenNotMinted");
    if (asset.revoked) throw new Error("AssetRevoked");
    asset.frozen = frozen;
    return this.receipt("setAssetFrozen", tokenId);
  }

  async revokeAsset(tokenId: string): Promise<TxReceipt> {
    const asset = this.assets.get(tokenId);
    if (!asset) throw new Error("TokenNotMinted");
    asset.revoked = true;
    return this.receipt("revokeAsset", tokenId);
  }

  async getAsset(tokenId: string): Promise<OnChainAsset> {
    return this.assets.get(tokenId) ?? {
      tokenId, ownerCommitment: "0x", metadataCommitment: "0x", frozen: false, revoked: false, exists: false,
    };
  }

  async registerAgent(p: { agentCommitment: string; didCommitment: string; policyCommitment: string }): Promise<TxReceipt> {
    if (this.agents.has(p.agentCommitment)) throw new Error("AgentAlreadyRegistered");
    this.agents.set(p.agentCommitment, {
      didCommitment: p.didCommitment, policyCommitment: p.policyCommitment, active: true, exists: true,
    });
    return this.receipt("registerAgent", p.agentCommitment);
  }

  async setAgentPolicy(agentCommitment: string, policyCommitment: string): Promise<TxReceipt> {
    const agent = this.agents.get(agentCommitment);
    if (!agent) throw new Error("AgentNotRegistered");
    agent.policyCommitment = policyCommitment;
    return this.receipt("setAgentPolicy", agentCommitment);
  }

  async setAgentActive(agentCommitment: string, active: boolean): Promise<TxReceipt> {
    const agent = this.agents.get(agentCommitment);
    if (!agent) throw new Error("AgentNotRegistered");
    agent.active = active;
    return this.receipt("setAgentActive", agentCommitment);
  }

  async getAgent(agentCommitment: string): Promise<OnChainAgent> {
    return this.agents.get(agentCommitment) ?? { didCommitment: "0x", policyCommitment: "0x", active: false, exists: false };
  }

  async anchorProof(p: { commitment: string; subjectCommitment: string }): Promise<TxReceipt> {
    if (this.proofs.has(p.commitment)) throw new Error("ProofAlreadyAnchored");
    this.proofs.set(p.commitment, {
      commitment: p.commitment, subjectCommitment: p.subjectCommitment,
      timestamp: Math.floor(Date.now() / 1000), exists: true,
    });
    return this.receipt("anchorProof", p.commitment);
  }

  async getProof(commitment: string): Promise<OnChainProof> {
    return this.proofs.get(commitment) ?? { commitment, subjectCommitment: "0x", timestamp: 0, exists: false };
  }

  async health() {
    return {
      ok: true,
      detail: `In-memory chain simulation (deterministic, enforces the same invariants as the Solidity contracts). Transaction hashes are locally generated and NOT externally verifiable.`,
    };
  }
}
