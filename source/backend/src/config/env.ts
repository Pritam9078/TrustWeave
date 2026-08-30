import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader — avoids a dotenv dependency and, more importantly, makes the
 * precedence explicit: real process env always wins over the file, so a deployment
 * secret can never be shadowed by a stray committed .env.
 */
function loadEnvFile(path = resolve(process.cwd(), ".env")) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const bool = (v: string | undefined, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: num(process.env.PORT, 4000),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  DATABASE_FILE: process.env.DATABASE_FILE ?? "./trustweave.db",
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173",
  HOST: process.env.HOST ?? "0.0.0.0",
  RATE_LIMIT_MAX: num(process.env.RATE_LIMIT_MAX, 600),
  RATE_LIMIT_WINDOW: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
  SESSION_TTL_MINUTES: num(process.env.SESSION_TTL_MINUTES, 480),
  CHALLENGE_TTL_SECONDS: num(process.env.CHALLENGE_TTL_SECONDS, 120),

  /**
   * Demo-only password login. The spec's primary auth path is DID challenge/signature;
   * password login exists so a reviewer can open the app without generating keypairs.
   * It is refused outright when NODE_ENV=production.
   */
  ALLOW_PASSWORD_LOGIN: bool(process.env.ALLOW_PASSWORD_LOGIN, true),

  LLM_PROVIDER: (process.env.LLM_PROVIDER ?? "mock") as "mock" | "anthropic",
  LLM_API_KEY: process.env.LLM_API_KEY ?? "",
  LLM_MODEL: process.env.LLM_MODEL || "claude-sonnet-4-6",

  RAZORPAY_ADAPTER: (process.env.RAZORPAY_ADAPTER ?? "auto") as "auto" | "test" | "live",
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID ?? "",
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET ?? "",
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",

  BLOCKCHAIN_ADAPTER: (process.env.BLOCKCHAIN_ADAPTER ?? "auto") as "auto" | "memory" | "evm",
  CHAIN_RPC_URL: process.env.CHAIN_RPC_URL ?? "",
  CHAIN_PRIVATE_KEY: process.env.CHAIN_PRIVATE_KEY ?? "",
  CHAIN_ID: process.env.CHAIN_ID ?? "11155111",
  IDENTITY_REGISTRY_ADDRESS: process.env.IDENTITY_REGISTRY_ADDRESS ?? "",
  ASSET_REGISTRY_ADDRESS: process.env.ASSET_REGISTRY_ADDRESS ?? "",
  AGENT_REGISTRY_ADDRESS: process.env.AGENT_REGISTRY_ADDRESS ?? "",
  PROOF_REGISTRY_ADDRESS: process.env.PROOF_REGISTRY_ADDRESS ?? "",
} as const;

/** Convenience projections used by the HTTP layer and the integration-status route. */
export const CORS_ORIGINS = env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
export const DATABASE_URL = env.DATABASE_FILE;

export function isProd() { return env.NODE_ENV === "production"; }

/** Fail fast at boot on configurations that are unsafe rather than merely incomplete. */
export function assertSafeConfig(log: { warn: (m: string) => void }) {
  if (isProd()) {
    if (env.ALLOW_PASSWORD_LOGIN) {
      throw new Error("ALLOW_PASSWORD_LOGIN must be false in production — DID challenge auth only.");
    }
    if (env.CORS_ORIGIN.includes("*")) throw new Error("Wildcard CORS_ORIGIN is not permitted in production.");
    if (!env.RAZORPAY_WEBHOOK_SECRET) throw new Error("RAZORPAY_WEBHOOK_SECRET is required in production.");
  } else {
    if (env.ALLOW_PASSWORD_LOGIN) log.warn("Password login is ENABLED (development convenience). Disable for production.");
    if (!env.RAZORPAY_WEBHOOK_SECRET) log.warn("RAZORPAY_WEBHOOK_SECRET unset — using the deterministic test adapter secret.");
  }
}
