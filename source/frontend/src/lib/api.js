import { getToken, logout } from "./session.js";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4001";

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  
  if (res.status === 401 && path !== "/api/auth/login") {
    logout();
    throw new Error("Session expired. Please log in again.");
  }
  
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message ?? body?.error ?? `Request failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Thin client over the backend's API contract (see backend/src/routes/).
 */
export const api = {
  loginPassword: (email, password) => request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  
  listAgents: () => request("/api/agents").then(r => r.agents),
  getAgent: (id) => request(`/api/agents/${id}`),
  createAgent: (input) => request("/api/agents", { method: "POST", body: JSON.stringify(input) }),
  getAgentOnChain: (id) => request(`/api/agents/${id}/on-chain`),
  updateAgentStatus: (id, status) => request(`/api/agents/${id}/freeze`, { method: "POST", body: JSON.stringify({ status }) }),

  listPaymentIntents: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/payment-intents${qs ? `?${qs}` : ""}`).then(r => r.intents);
  },
  createPaymentIntent: (input) => {
    if (input.rawRequest) {
      return request("/api/agents/task", {
        method: "POST",
        body: JSON.stringify({ instruction: input.rawRequest, execute: true })
      }).then(r => {
        if (r.toolCall?.data?.id) return { intentId: r.toolCall.data.id };
        throw new Error(r.note ?? "The agent failed to create a payment intent.");
      });
    }
    return request("/api/payment-intents", { method: "POST", body: JSON.stringify(input) });
  },
  getPaymentIntent: (id) => request(`/api/payment-intents/${id}`),
  authorizePaymentIntent: (id) => request(`/api/payment-intents/${id}/authorize`, { method: "POST" }),
  approvePaymentIntent: (id, input) => request(`/api/payment-intents/${id}/approve`, { method: "POST", body: JSON.stringify(input) }),
  executePaymentIntent: (id) => request(`/api/payment-intents/${id}/execute`, { method: "POST" }),

  listPolicies: () => request("/api/policies").then(r => r.policies.map(p => {
    const rules = p.conditions?.rules || [];
    return {
      ...p,
      status: p.status === "ACTIVE" ? "LIVE" : p.status === "DISABLED" ? "MONITORING" : p.status,
      transactionLimit: rules.find(r => r.type === "AMOUNT_MAX")?.value || 0,
      dailyLimit: rules.find(r => r.type === "VELOCITY")?.value || 0,
      allowlist: rules.find(r => r.type === "MERCHANT_ALLOWLIST")?.values || [],
      approvalThreshold: rules.find(r => r.type === "APPROVAL_THRESHOLD")?.value,
    };
  })),
  getPolicy: (id) => request(`/api/policies/${id}`),
  createPolicy: (input) => {
    const rules = [
      { type: "AMOUNT_MAX", value: input.transactionLimit },
      { type: "VELOCITY", interval: "daily", value: input.dailyLimit },
    ];
    if (input.allowlist && input.allowlist.length > 0) rules.push({ type: "MERCHANT_ALLOWLIST", values: input.allowlist });
    if (input.approvalThreshold) rules.push({ type: "APPROVAL_THRESHOLD", value: input.approvalThreshold });
    
    return request("/api/policies", { 
      method: "POST", 
      body: JSON.stringify({
        policyKey: "pol_" + Math.random().toString(36).slice(2, 8),
        name: input.name,
        conditions: { rules }
      }) 
    }).then(r => {
      return {
        ...r.policy,
        transactionLimit: input.transactionLimit,
        dailyLimit: input.dailyLimit,
        allowlist: input.allowlist || [],
        approvalThreshold: input.approvalThreshold,
        status: r.policy.status === "ACTIVE" ? "LIVE" : r.policy.status === "DISABLED" ? "MONITORING" : r.policy.status
      };
    });
  },
  updatePolicyStatus: (id, status) => {
    const endpoint = status === "LIVE" ? "activate" : "disable";
    return request(`/api/policies/${id}/${endpoint}`, { method: "POST" }).then(r => {
      const p = r.policy;
      const rules = p.conditions?.rules || [];
      return {
        ...p,
        status: p.status === "ACTIVE" ? "LIVE" : p.status === "DISABLED" ? "MONITORING" : p.status,
        transactionLimit: rules.find(r => r.type === "AMOUNT_MAX")?.value || 0,
        dailyLimit: rules.find(r => r.type === "VELOCITY")?.value || 0,
        allowlist: rules.find(r => r.type === "MERCHANT_ALLOWLIST")?.values || [],
        approvalThreshold: rules.find(r => r.type === "APPROVAL_THRESHOLD")?.value,
      };
    });
  },

  listProofs: () => request("/api/proofs").then(r => r.proofs),
  getProof: (id) => request(`/api/proofs/${id}`),
  verifyProof: (id) => request(`/api/proofs/${id}/verify`, { method: "POST" }),

  getMetrics: () => request("/api/metrics"),
  health: () => request("/health"),
};

export class ApiError extends Error {}
