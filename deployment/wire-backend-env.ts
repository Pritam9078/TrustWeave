/**
 * Copies deployed registry addresses into backend/.env so going from a deploy to a
 * wired backend is one command rather than four manual copy-pastes (each of which is
 * an opportunity to point the backend at the wrong contract and not notice).
 *
 *   HARDHAT_NETWORK=sepolia npx tsx scripts/wire-backend-env.ts
 */
import fs from "node:fs";
import path from "node:path";

const networkName = process.env.HARDHAT_NETWORK ?? "localhost";
const deploymentFile = path.join(process.cwd(), "deployments", `${networkName}.json`);

if (!fs.existsSync(deploymentFile)) {
  console.error(`No deployment at ${deploymentFile}. Run \`npm run deploy:${networkName}\` first.`);
  process.exit(1);
}

const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
const envPath = path.join(process.cwd(), "..", "backend", ".env");

const updates: Record<string, string> = {
  BLOCKCHAIN_ADAPTER: "evm",
  CHAIN_ID: String(deployment.chainId),
  IDENTITY_REGISTRY_ADDRESS: deployment.addresses.IdentityRegistry,
  ASSET_REGISTRY_ADDRESS: deployment.addresses.AssetRegistry,
  AGENT_REGISTRY_ADDRESS: deployment.addresses.AgentRegistry,
  PROOF_REGISTRY_ADDRESS: deployment.addresses.ProofRegistry,
};

let contents = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
for (const [key, value] of Object.entries(updates)) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  contents = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
}
fs.writeFileSync(envPath, contents.trimStart());

console.log(`Wired ${Object.keys(updates).length} values into backend/.env for network "${networkName}".`);
console.log("The backend will use the live EVM adapter on next start.");
console.log("\nCHAIN_RPC_URL and CHAIN_PRIVATE_KEY are NOT written here — set those yourself; they are secrets.");
