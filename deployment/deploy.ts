// @ts-nocheck
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Deploys all four registries and authorises the backend's signing key as a writer.
 *
 *   npm run deploy:local     (against `npx hardhat node`)
 *   npm run deploy:sepolia   (needs CHAIN_RPC_URL + CHAIN_PRIVATE_KEY)
 *
 * BACKEND_WRITER_ADDRESS should be the address of the key in the backend's
 * CHAIN_PRIVATE_KEY. Admin rights stay with the deployer: the backend may record
 * facts, but only the admin can pause a registry or appoint another writer. Keeping
 * those two keys separate is the point — a leaked backend key must not be able to
 * disable the pause switch that would contain the incident.
 */
async function main() {
  const [deployer] = await hre.viem.getWalletClients();
  const admin = deployer.account.address;
  const writer = process.env.BACKEND_WRITER_ADDRESS ?? admin;

  if (writer.toLowerCase() === admin.toLowerCase()) {
    console.warn(
      "\n  WARNING: the backend writer and the contract admin are the same key.\n" +
      "  Fine for local development; for anything shared, set BACKEND_WRITER_ADDRESS to a\n" +
      "  separate backend key so a compromised backend cannot pause or re-govern the registries.\n",
    );
  }

  console.log(`Deploying as ${admin}`);
  console.log(`Backend writer will be ${writer}\n`);

  const identity = await hre.viem.deployContract("IdentityRegistry", [admin]);
  const asset = await hre.viem.deployContract("AssetRegistry", [admin]);
  const agent = await hre.viem.deployContract("AgentRegistry", [admin]);
  const proof = await hre.viem.deployContract("ProofRegistry", [admin]);

  const registries = { IdentityRegistry: identity, AssetRegistry: asset, AgentRegistry: agent, ProofRegistry: proof };

  for (const [name, contract] of Object.entries(registries)) {
    console.log(`${name.padEnd(18)} ${contract.address}`);
    if (writer.toLowerCase() !== admin.toLowerCase()) {
      await contract.write.setWriter([writer as `0x${string}`, true]);
    }
  }

  const networkName = hre.network.name;
  const record = {
    network: networkName,
    chainId: await (await hre.viem.getPublicClient()).getChainId(),
    admin, writer,
    deployedAt: new Date().toISOString(),
    addresses: Object.fromEntries(Object.entries(registries).map(([n, c]) => [n, c.address])),
  };

  const outDir = path.join(process.cwd(), "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${networkName}.json`), JSON.stringify(record, null, 2));

  console.log(`\nDeployment written to deployments/${networkName}.json`);
  console.log("Run `npm run wire-backend` to copy these addresses into backend/.env.");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
