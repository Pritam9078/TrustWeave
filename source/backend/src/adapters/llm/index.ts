import { env } from "../../config/env.js";
import { MockLLMProvider } from "./mockProvider.js";
import { AnthropicLLMProvider } from "./anthropicProvider.js";
import type { LLMProvider } from "./types.js";

export * from "./types.js";
export { MockLLMProvider } from "./mockProvider.js";

let instance: LLMProvider | null = null;

export function createLLMProvider(): LLMProvider {
  if (env.LLM_PROVIDER === "anthropic" && env.LLM_API_KEY) {
    return new AnthropicLLMProvider(env.LLM_API_KEY, env.LLM_MODEL);
  }
  return new MockLLMProvider();
}

export function getLLMProvider(): LLMProvider {
  if (!instance) instance = createLLMProvider();
  return instance;
}

export function setLLMProvider(p: LLMProvider) { instance = p; }
