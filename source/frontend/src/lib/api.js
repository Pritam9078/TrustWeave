/**
 * The single HTTP boundary.
 *
 * Every request goes through here so session handling, error shaping and the 401/403
 * distinction are decided in one place. Note what this file deliberately does NOT do:
 * it never attaches a role, capability or organization header. The server derives the
 * actor entirely from the session token — a client that could describe its own
 * privileges would be a client that could forge them.
 */

const BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
const TOKEN_KEY = "trustweave.session";

export function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* private browsing mode — the session simply won't persist a reload */ }
}

/**
 * A failed request carries the server's machine-readable code and, for authorization
 * denials, the full evaluation trace. The UI uses that trace to explain *why* an action
 * was refused rather than showing a bare "Forbidden" — the denial reason is one of the
 * most useful things this system produces, and discarding it would be a waste.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || "Request failed.");
    this.status = status;
    this.code = code || "UNKNOWN";
    this.details = details || null;
    this.evaluation = details?.evaluation ?? null;
    this.reasonCodes = details?.reasonCodes ?? [];
    this.issues = details?.issues ?? null;
  }
  get isDenial() { return this.status === 403; }
  get isAuthExpired() { return this.status === 401; }
}

async function request(method, path, body, opts = {}) {
  const headers = { "content-type": "application/json" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", `Cannot reach the API at ${BASE}. Is the backend running?`);
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json().catch(() => ({})) : await response.text();

  if (!response.ok) {
    if (response.status === 401 && !opts.allowAnonymous) {
      // The session is gone; stop pretending to be signed in.
      setToken(null);
    }
    throw new ApiError(response.status, payload?.error, payload?.message, payload?.details);
  }
  return payload;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  patch: (path, body) => request("PATCH", path, body),
  del: (path) => request("DELETE", path),
  login: (email, password) => request("POST", "/api/auth/login", { email, password }, { allowAnonymous: true }),
  challenge: (did) => request("POST", "/api/auth/challenge", { did }, { allowAnonymous: true }),
  verify: (payload) => request("POST", "/api/auth/verify", payload, { allowAnonymous: true }),
  authConfig: () => request("GET", "/api/auth/config", undefined, { allowAnonymous: true }),
  session: () => request("GET", "/api/session"),
};

export const API_BASE = BASE;
