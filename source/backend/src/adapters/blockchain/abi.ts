/** Minimal ABIs for the four registries. Kept hand-written and small so the backend
 *  does not depend on Hardhat build artefacts being present at runtime. */

export const IDENTITY_REGISTRY_ABI = [
  { type: "function", name: "registerIdentity", stateMutability: "nonpayable", inputs: [{ name: "didCommitment", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setStatus", stateMutability: "nonpayable", inputs: [{ name: "didCommitment", type: "bytes32" }, { name: "status", type: "uint8" }], outputs: [] },
  { type: "function", name: "getIdentity", stateMutability: "view", inputs: [{ name: "didCommitment", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [{ name: "status", type: "uint8" }, { name: "exists", type: "bool" }] }] },
] as const;

export const ASSET_REGISTRY_ABI = [
  { type: "function", name: "mintAsset", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "ownerCommitment", type: "bytes32" }, { name: "metadataCommitment", type: "bytes32" }], outputs: [] },
  { type: "function", name: "transferAsset", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "newOwnerCommitment", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setFrozen", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "frozen", type: "bool" }], outputs: [] },
  { type: "function", name: "revokeAsset", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "getAsset", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "ownerCommitment", type: "bytes32" }, { name: "metadataCommitment", type: "bytes32" },
      { name: "frozen", type: "bool" }, { name: "revoked", type: "bool" }, { name: "exists", type: "bool" }] }] },
] as const;

export const AGENT_REGISTRY_ABI = [
  { type: "function", name: "registerAgent", stateMutability: "nonpayable", inputs: [{ name: "agentCommitment", type: "bytes32" }, { name: "didCommitment", type: "bytes32" }, { name: "policyCommitment", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setPolicy", stateMutability: "nonpayable", inputs: [{ name: "agentCommitment", type: "bytes32" }, { name: "policyCommitment", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setActive", stateMutability: "nonpayable", inputs: [{ name: "agentCommitment", type: "bytes32" }, { name: "active", type: "bool" }], outputs: [] },
  { type: "function", name: "getAgent", stateMutability: "view", inputs: [{ name: "agentCommitment", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "didCommitment", type: "bytes32" }, { name: "policyCommitment", type: "bytes32" },
      { name: "active", type: "bool" }, { name: "exists", type: "bool" }] }] },
] as const;

export const PROOF_REGISTRY_ABI = [
  { type: "function", name: "anchorProof", stateMutability: "nonpayable", inputs: [{ name: "commitment", type: "bytes32" }, { name: "subjectCommitment", type: "bytes32" }], outputs: [] },
  { type: "function", name: "getProof", stateMutability: "view", inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "subjectCommitment", type: "bytes32" }, { name: "timestamp", type: "uint256" }, { name: "exists", type: "bool" }] }] },
] as const;
