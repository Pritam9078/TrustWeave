import { env } from "../../config/env.js";
import { TestRazorpayAdapter } from "./testAdapter.js";
import { LiveRazorpayAdapter } from "./liveAdapter.js";
import type { RazorpayAdapter } from "./types.js";

export * from "./types.js";
export { TestRazorpayAdapter } from "./testAdapter.js";

let instance: RazorpayAdapter | null = null;

export function createRazorpayAdapter(): RazorpayAdapter {
  const hasCreds = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  if (env.RAZORPAY_ADAPTER === "live" && !hasCreds) {
    throw new Error("RAZORPAY_ADAPTER=live but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.");
  }
  if ((env.RAZORPAY_ADAPTER === "live" || env.RAZORPAY_ADAPTER === "auto") && hasCreds) {
    return new LiveRazorpayAdapter(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET);
  }
  return new TestRazorpayAdapter(env.RAZORPAY_WEBHOOK_SECRET || undefined);
}

export function getRazorpayAdapter(): RazorpayAdapter {
  if (!instance) instance = createRazorpayAdapter();
  return instance;
}

export function setRazorpayAdapter(a: RazorpayAdapter) { instance = a; }
