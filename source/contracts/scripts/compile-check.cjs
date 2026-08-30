/**
 * Offline compile verification.
 *
 * Hardhat downloads the solc binary from binaries.soliditylang.org on first compile.
 * In a locked-down network (CI sandboxes, corporate egress allowlists) that host is
 * often unreachable, and `hardhat compile` fails for reasons that have nothing to do
 * with the contracts. The npm `solc` package ships the same compiler as WebAssembly and
 * installs from the normal registry, so this script proves the Solidity is valid even
 * when Hardhat cannot fetch its toolchain.
 *
 * This is a syntax/semantics check, not a substitute for `npx hardhat test`, which runs
 * the behavioural suite against a real EVM.
 *
 *   node scripts/compile-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

let solc;
try {
  solc = require("solc");
} catch {
  console.error("solc is not installed. Run: npm install --no-save solc@0.8.24");
  process.exit(1);
}

const dir = path.join(__dirname, "..", "contracts");
const sources = {};
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sol"))) {
  sources[file] = { content: fs.readFileSync(path.join(dir, file), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const findImports = (p) => {
  const full = path.join(dir, path.basename(p));
  return fs.existsSync(full) ? { contents: fs.readFileSync(full, "utf8") } : { error: `not found: ${p}` };
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const problems = output.errors ?? [];
const errors = problems.filter((e) => e.severity === "error");
const warnings = problems.filter((e) => e.severity === "warning");

for (const w of warnings) console.warn(w.formattedMessage);
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}

console.log(`Compiled with solc ${solc.version()}`);
console.log(`Errors: 0   Warnings: ${warnings.length}`);
const LIMIT = 24576; // EIP-170 deployed-bytecode ceiling
for (const contracts of Object.values(output.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts)) {
    const size = c.evm.bytecode.object.length / 2;
    if (!size) continue;
    const flag = size > LIMIT ? "  OVER EIP-170 LIMIT" : "";
    console.log(`  ${name.padEnd(20)} ${String(size).padStart(6)} bytes${flag}`);
  }
}
