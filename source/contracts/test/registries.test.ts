import { expect } from "chai";
import hre from "hardhat";
import { keccak256, toHex } from "viem";

/**
 * Contract tests.
 *
 * Every test names an attack or a governance mistake and asserts the contract refuses
 * it. The emphasis is on *unauthorized* paths: the happy path is easy and rarely the
 * thing that goes wrong in production.
 */

const commit = (s: string) => keccak256(toHex(s));

const DID_A = commit("did:key:alice");
const DID_B = commit("did:key:bob");
const ORG = commit("org:northwind");
const TOKEN = commit("asset:laptop-1");
const META = commit('{"serial":"NW-0417"}');
const META2 = commit('{"serial":"NW-0417","note":"updated"}');
const AGENT = commit("agent:finance-01");
const CAPS = commit("PAYMENT_CREATE,ASSET_READ");
const CAPS2 = commit("PAYMENT_CREATE,ASSET_READ,PAYMENT_APPROVE");
const PROOF = commit("proof:payment-42");

async function actors() {
  const [admin, backend, attacker, newAdmin] = await hre.viem.getWalletClients();
  return { admin, backend, attacker, newAdmin };
}

describe("AccessControlled (via IdentityRegistry)", () => {
  it("lets the admin appoint a writer", async () => {
    const { admin, backend } = await actors();
    const reg = await hre.viem.deployContract("IdentityRegistry", [admin.account.address]);
    await reg.write.setWriter([backend.account.address, true]);
    expect(await reg.read.writers([backend.account.address])).to.equal(true);
  });

  it("refuses a non-admin appointing a writer", async () => {
    const { admin, attacker } = await actors();
    const reg = await hre.viem.deployContract("IdentityRegistry", [admin.account.address]);
    await expect(
      reg.write.setWriter([attacker.account.address, true], { account: attacker.account }),
    ).to.be.rejectedWith("NotAdmin");
  });

  it("refuses a non-writer writing", async () => {
    const { admin, attacker } = await actors();
    const reg = await hre.viem.deployContract("IdentityRegistry", [admin.account.address]);
    await expect(
      reg.write.registerIdentity([DID_A, ORG], { account: attacker.account }),
    ).to.be.rejectedWith("NotWriter");
  });

  it("stops all writes when paused, and resumes when unpaused", async () => {
    const { admin, backend } = await actors();
    const reg = await hre.viem.deployContract("IdentityRegistry", [admin.account.address]);
    await reg.write.setWriter([backend.account.address, true]);

    await reg.write.setPaused([true]);
    await expect(
      reg.write.registerIdentity([DID_A, ORG], { account: backend.account }),
    ).to.be.rejectedWith("ContractPaused");

    await reg.write.setPaused([false]);
    await reg.write.registerIdentity([DID_A, ORG], { account: backend.account });
    expect(await reg.read.isActive([DID_A])).to.equal(true);
  });

  it("refuses a writer pausing the contract — writers record facts, they do not govern", async () => {
    const { admin, backend } = await actors();
    const reg = await hre.viem.deployContract("IdentityRegistry", [admin.account.address]);
    await reg.write.setWriter([backend.account.address, true]);
    await expect(reg.write.setPaused([true], { account: backend.account })).to.be.rejectedWith("NotAdmin");
  });

  it("revokes a compromised writer immediately", async () => {
    const { admin, backend } = await actors();
    const reg = await hre.viem.deployContract("IdentityRegistry", [admin.account.address]);
    await reg.write.setWriter([backend.account.address, true]);
    await reg.write.setWriter([backend.account.address, false]);
    await expect(
      reg.write.registerIdentity([DID_A, ORG], { account: backend.account }),
    ).to.be.rejectedWith("NotWriter");
  });

  it("requires the incoming admin to accept, so a typo cannot brick governance", async () => {
    const { admin, newAdmin, attacker } = await actors();
    const reg = await hre.viem.deployContract("IdentityRegistry", [admin.account.address]);

    await reg.write.transferAdmin([newAdmin.account.address]);
    // Still the old admin until acceptance.
    expect((await reg.read.admin()).toLowerCase()).to.equal(admin.account.address.toLowerCase());
    await expect(reg.write.acceptAdmin({ account: attacker.account })).to.be.rejectedWith("NotAdmin");

    await reg.write.acceptAdmin({ account: newAdmin.account });
    expect((await reg.read.admin()).toLowerCase()).to.equal(newAdmin.account.address.toLowerCase());
  });

  it("rejects the zero address as admin or writer", async () => {
    const { admin } = await actors();
    const reg = await hre.viem.deployContract("IdentityRegistry", [admin.account.address]);
    await expect(reg.write.setWriter(["0x0000000000000000000000000000000000000000", true])).to.be.rejectedWith("ZeroAddress");
  });
});

describe("IdentityRegistry", () => {
  async function deployed() {
    const a = await actors();
    const reg = await hre.viem.deployContract("IdentityRegistry", [a.admin.account.address]);
    await reg.write.setWriter([a.backend.account.address, true]);
    return { ...a, reg };
  }

  it("registers an identity as a commitment only", async () => {
    const { reg, backend } = await deployed();
    await reg.write.registerIdentity([DID_A, ORG], { account: backend.account });
    const [exists, status] = await reg.read.getIdentity([DID_A]);
    expect(exists).to.equal(true);
    expect(status).to.equal(1); // ACTIVE
  });

  it("refuses duplicate registration", async () => {
    const { reg, backend } = await deployed();
    await reg.write.registerIdentity([DID_A, ORG], { account: backend.account });
    await expect(
      reg.write.registerIdentity([DID_A, ORG], { account: backend.account }),
    ).to.be.rejectedWith("AlreadyRegistered");
  });

  it("suspends and reactivates", async () => {
    const { reg, backend } = await deployed();
    await reg.write.registerIdentity([DID_A, ORG], { account: backend.account });
    await reg.write.setIdentityStatus([DID_A, 2], { account: backend.account }); // SUSPENDED
    expect(await reg.read.isActive([DID_A])).to.equal(false);
    await reg.write.setIdentityStatus([DID_A, 1], { account: backend.account }); // ACTIVE
    expect(await reg.read.isActive([DID_A])).to.equal(true);
  });

  it("makes revocation permanent — a compromised key is never resurrected", async () => {
    const { reg, backend } = await deployed();
    await reg.write.registerIdentity([DID_A, ORG], { account: backend.account });
    await reg.write.setIdentityStatus([DID_A, 3], { account: backend.account }); // REVOKED
    await expect(
      reg.write.setIdentityStatus([DID_A, 1], { account: backend.account }),
    ).to.be.rejectedWith("RevocationIsFinal");
  });

  it("refuses status changes on an unknown identity", async () => {
    const { reg, backend } = await deployed();
    await expect(
      reg.write.setIdentityStatus([DID_B, 2], { account: backend.account }),
    ).to.be.rejectedWith("UnknownIdentity");
  });

  it("refuses an attacker revoking someone else's identity", async () => {
    const { reg, backend, attacker } = await deployed();
    await reg.write.registerIdentity([DID_A, ORG], { account: backend.account });
    await expect(
      reg.write.setIdentityStatus([DID_A, 3], { account: attacker.account }),
    ).to.be.rejectedWith("NotWriter");
  });
});

describe("AssetRegistry", () => {
  async function deployed() {
    const a = await actors();
    const reg = await hre.viem.deployContract("AssetRegistry", [a.admin.account.address]);
    await reg.write.setWriter([a.backend.account.address, true]);
    await reg.write.mint([TOKEN, DID_A, META], { account: a.backend.account });
    return { ...a, reg };
  }

  it("mints with owner and metadata commitments", async () => {
    const { reg } = await deployed();
    const [exists, owner, metadata] = await reg.read.getAsset([TOKEN]);
    expect(exists).to.equal(true);
    expect(owner).to.equal(DID_A);
    expect(metadata).to.equal(META);
  });

  it("refuses an unauthorized mint", async () => {
    const { reg, attacker } = await deployed();
    await expect(
      reg.write.mint([commit("asset:stolen"), DID_B, META], { account: attacker.account }),
    ).to.be.rejectedWith("NotWriter");
  });

  it("refuses an unauthorized transfer", async () => {
    const { reg, attacker } = await deployed();
    await expect(
      reg.write.transfer([TOKEN, DID_B], { account: attacker.account }),
    ).to.be.rejectedWith("NotWriter");
  });

  it("has no approve or operator delegation to exploit", async () => {
    const { reg } = await deployed();
    // The contract intentionally exposes no ERC-721-style approval surface; the absence
    // of these functions is the security property being asserted.
    expect((reg.abi as any[]).some((f) => ["approve", "setApprovalForAll", "transferFrom"].includes(f.name))).to.equal(false);
  });

  it("blocks transfer of a frozen asset", async () => {
    const { reg, backend } = await deployed();
    await reg.write.setFrozen([TOKEN, true], { account: backend.account });
    await expect(
      reg.write.transfer([TOKEN, DID_B], { account: backend.account }),
    ).to.be.rejectedWith("AssetIsFrozen");
  });

  it("allows transfer again once unfrozen", async () => {
    const { reg, backend } = await deployed();
    await reg.write.setFrozen([TOKEN, true], { account: backend.account });
    await reg.write.setFrozen([TOKEN, false], { account: backend.account });
    await reg.write.transfer([TOKEN, DID_B], { account: backend.account });
    const [, owner] = await reg.read.getAsset([TOKEN]);
    expect(owner).to.equal(DID_B);
  });

  it("makes revocation terminal for assets too", async () => {
    const { reg, backend } = await deployed();
    await reg.write.revoke([TOKEN], { account: backend.account });
    await expect(reg.write.transfer([TOKEN, DID_B], { account: backend.account })).to.be.rejectedWith("AssetIsRevoked");
    await expect(reg.write.revoke([TOKEN], { account: backend.account })).to.be.rejectedWith("AssetIsRevoked");
  });

  it("refuses double minting the same token", async () => {
    const { reg, backend } = await deployed();
    await expect(reg.write.mint([TOKEN, DID_B, META], { account: backend.account })).to.be.rejectedWith("AlreadyMinted");
  });

  it("refuses operations on an unknown token", async () => {
    const { reg, backend } = await deployed();
    await expect(reg.write.transfer([commit("asset:ghost"), DID_B], { account: backend.account })).to.be.rejectedWith("UnknownAsset");
  });

  it("records a metadata change as an event rather than silently", async () => {
    const { reg, backend, admin } = await deployed();
    await reg.write.updateMetadata([TOKEN, META2], { account: backend.account });
    const [, , metadata] = await reg.read.getAsset([TOKEN]);
    expect(metadata).to.equal(META2);
    const client = await hre.viem.getPublicClient();
    const logs = await client.getContractEvents({ address: reg.address, abi: reg.abi, eventName: "AssetMetadataUpdated" });
    expect(logs.length).to.equal(1);
  });
});

describe("AgentRegistry", () => {
  async function deployed() {
    const a = await actors();
    const reg = await hre.viem.deployContract("AgentRegistry", [a.admin.account.address]);
    await reg.write.setWriter([a.backend.account.address, true]);
    await reg.write.registerAgent([AGENT, DID_A, CAPS], { account: a.backend.account });
    return { ...a, reg };
  }

  it("registers an active agent", async () => {
    const { reg } = await deployed();
    expect(await reg.read.isActive([AGENT])).to.equal(true);
  });

  it("pauses and resumes an agent", async () => {
    const { reg, backend } = await deployed();
    await reg.write.setActive([AGENT, false], { account: backend.account });
    expect(await reg.read.isActive([AGENT])).to.equal(false);
    await reg.write.setActive([AGENT, true], { account: backend.account });
    expect(await reg.read.isActive([AGENT])).to.equal(true);
  });

  it("refuses an attacker pausing or revoking an agent", async () => {
    const { reg, attacker } = await deployed();
    await expect(reg.write.setActive([AGENT, false], { account: attacker.account })).to.be.rejectedWith("NotWriter");
    await expect(reg.write.revokeAgent([AGENT], { account: attacker.account })).to.be.rejectedWith("NotWriter");
  });

  it("refuses an attacker widening an agent's capabilities", async () => {
    const { reg, attacker } = await deployed();
    await expect(
      reg.write.setCapabilityCommitment([AGENT, CAPS2], { account: attacker.account }),
    ).to.be.rejectedWith("NotWriter");
  });

  it("emits an event whenever capabilities change", async () => {
    const { reg, backend } = await deployed();
    await reg.write.setCapabilityCommitment([AGENT, CAPS2], { account: backend.account });
    const client = await hre.viem.getPublicClient();
    const logs = await client.getContractEvents({ address: reg.address, abi: reg.abi, eventName: "AgentCapabilitiesChanged" });
    expect(logs.length).to.equal(1);
    expect((logs[0] as any).args.previous).to.equal(CAPS);
    expect((logs[0] as any).args.current).to.equal(CAPS2);
  });

  it("makes agent revocation terminal", async () => {
    const { reg, backend } = await deployed();
    await reg.write.revokeAgent([AGENT], { account: backend.account });
    expect(await reg.read.isActive([AGENT])).to.equal(false);
    await expect(reg.write.setActive([AGENT, true], { account: backend.account })).to.be.rejectedWith("AgentIsRevoked");
  });

  it("refuses duplicate agent registration", async () => {
    const { reg, backend } = await deployed();
    await expect(reg.write.registerAgent([AGENT, DID_A, CAPS], { account: backend.account })).to.be.rejectedWith("AlreadyRegistered");
  });
});

describe("ProofRegistry", () => {
  async function deployed() {
    const a = await actors();
    const reg = await hre.viem.deployContract("ProofRegistry", [a.admin.account.address]);
    await reg.write.setWriter([a.backend.account.address, true]);
    return { ...a, reg };
  }

  it("anchors a commitment and reports the block", async () => {
    const { reg, backend } = await deployed();
    await reg.write.anchor([PROOF, TOKEN], { account: backend.account });
    const [exists, subject, , blockNumber] = await reg.read.verify([PROOF]);
    expect(exists).to.equal(true);
    expect(subject).to.equal(TOKEN);
    expect(blockNumber > 0n).to.equal(true);
  });

  it("refuses to overwrite an existing anchor", async () => {
    const { reg, backend } = await deployed();
    await reg.write.anchor([PROOF, TOKEN], { account: backend.account });
    await expect(reg.write.anchor([PROOF, DID_B], { account: backend.account })).to.be.rejectedWith("AlreadyAnchored");
  });

  it("gives even the admin no way to alter or delete an anchor", async () => {
    const { reg, backend } = await deployed();
    await reg.write.anchor([PROOF, TOKEN], { account: backend.account });
    const mutators = (reg.abi as any[]).filter((f) =>
      f.type === "function" && ["delete", "remove", "update", "overwrite", "setProof"].some((n) => (f.name ?? "").toLowerCase().includes(n)));
    expect(mutators).to.deep.equal([]);
  });

  it("refuses an unauthorized anchor", async () => {
    const { reg, attacker } = await deployed();
    await expect(reg.write.anchor([PROOF, TOKEN], { account: attacker.account })).to.be.rejectedWith("NotWriter");
  });

  it("reports an unknown commitment as unanchored rather than reverting", async () => {
    const { reg } = await deployed();
    expect(await reg.read.isAnchored([commit("proof:never-written")])).to.equal(false);
  });
});
