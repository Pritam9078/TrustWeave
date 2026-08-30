/**
 * Blockchain adapter interface.
 *
 * Both the in-memory and the EVM implementation satisfy this exact interface, so the
 * rest of the backend cannot tell them apart and there is no "if (demo mode)" branch
 * anywhere in the domain services. Swapping adapters is a config change; it is never
 * a code path change, which is what stops the demo path and the real path from
 * drifting apart.
 *
 * Nothing in any of these signatures carries PII, invoice contents, document text or
 * model reasoning. Only commitments (bytes32 hashes), token ids and DID commitments
 * cross this boundary — that constraint is enforced by the shape of the interface
 * itself, not by remembering to sanitise at each call site.
 */

export type ChainKind = "memory" | "evm";

export interface TxReceipt {
  txHash: string;
  blockNumber?: number;
  chainId: string;
  /** True when the write was simulated in memory rather than broadcast. */
  simulated: boolean;
}

export interface OnChainAsset {
  tokenId: string;
  ownerCommitment: string;
  metadataCommitment: string;
  frozen: boolean;
  revoked: boolean;
  exists: boolean;
}

export interface OnChainAgent {
  didCommitment: string;
  policyCommitment: string;
  active: boolean;
  exists: boolean;
}

export interface OnChainIdentity {
  didCommitment: string;
  status: number; // 0 ACTIVE | 1 SUSPENDED | 2 REVOKED
  exists: boolean;
}

export interface OnChainProof {
  commitment: string;
  subjectCommitment: string;
  timestamp: number;
  exists: boolean;
}

export interface BlockchainAdapter {
  readonly kind: ChainKind;
  readonly chainId: string;
  readonly addresses: Record<string, string | null>;

  /* Identity registry */
  registerIdentity(didCommitment: string): Promise<TxReceipt>;
  setIdentityStatus(didCommitment: string, status: number): Promise<TxReceipt>;
  getIdentity(didCommitment: string): Promise<OnChainIdentity>;

  /* Asset registry */
  mintAsset(params: { tokenId: string; ownerCommitment: string; metadataCommitment: string }): Promise<TxReceipt>;
  transferAsset(params: { tokenId: string; newOwnerCommitment: string }): Promise<TxReceipt>;
  setAssetFrozen(tokenId: string, frozen: boolean): Promise<TxReceipt>;
  revokeAsset(tokenId: string): Promise<TxReceipt>;
  getAsset(tokenId: string): Promise<OnChainAsset>;

  /* Agent registry */
  registerAgent(params: { agentCommitment: string; didCommitment: string; policyCommitment: string }): Promise<TxReceipt>;
  setAgentPolicy(agentCommitment: string, policyCommitment: string): Promise<TxReceipt>;
  setAgentActive(agentCommitment: string, active: boolean): Promise<TxReceipt>;
  getAgent(agentCommitment: string): Promise<OnChainAgent>;

  /* Proof registry */
  anchorProof(params: { commitment: string; subjectCommitment: string }): Promise<TxReceipt>;
  getProof(commitment: string): Promise<OnChainProof>;

  health(): Promise<{ ok: boolean; detail: string }>;
}
