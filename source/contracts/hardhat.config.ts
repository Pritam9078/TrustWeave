import { subtask, type HardhatUserConfig } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import path from "node:path";
import fs from "node:fs";
import "@nomicfoundation/hardhat-toolbox-viem";
import * as dotenv from "dotenv";

dotenv.config();

const SOLC_VERSION = "0.8.24";
const SOLC_LONG_VERSION = "0.8.24+commit.e11b9ed9";

const CHAIN_RPC_URL = process.env.CHAIN_RPC_URL ?? "";
const CHAIN_PRIVATE_KEY = process.env.CHAIN_PRIVATE_KEY ?? "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

/**
 * Use the locally installed `solc` package instead of downloading a compiler binary.
 *
 * Hardhat fetches solc from binaries.soliditylang.org on first compile. That host is
 * unreachable from locked-down CI runners and corporate egress allowlists, and when it
 * fails the build dies for a reason that has nothing to do with the contracts. The npm
 * `solc` package ships the identical compiler as WebAssembly and installs from the
 * normal registry, so pointing Hardhat at it makes compilation work offline and pins
 * the exact version rather than trusting whatever the remote list resolves to.
 *
 * If `solc` is not installed we defer to Hardhat's normal download path, so this is an
 * addition to the default behaviour rather than a replacement for it.
 */
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: { solcVersion: string }, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const compilerPath = path.join(__dirname, "node_modules", "solc", "soljson.js");
    if (fs.existsSync(compilerPath)) {
      return {
        compilerPath,
        isSolcJs: true,
        version: args.solcVersion,
        longVersion: SOLC_LONG_VERSION,
      };
    }
    // solc is not installed locally — fall through to Hardhat's standard downloader.
  }
  return runSuper();
});

const config: HardhatUserConfig = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: {},                                   // in-process EVM used by `npm test`
    localhost: { url: "http://127.0.0.1:8545" },   // `npx hardhat node` in a second terminal
    ...(CHAIN_RPC_URL && CHAIN_PRIVATE_KEY
      ? { sepolia: { url: CHAIN_RPC_URL, accounts: [CHAIN_PRIVATE_KEY] } }
      : {}),
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
};

export default config;
