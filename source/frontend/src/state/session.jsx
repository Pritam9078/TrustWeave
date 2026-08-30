import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, setToken, getToken, ApiError } from "../lib/api.js";

/**
 * Session state.
 *
 * The capability list held here is a copy of what the server reported, used only to
 * decide what to *render*. It is never treated as permission. Every action still hits
 * an endpoint that re-derives the actor's rights server-side, so hiding a button is a
 * courtesy to the user rather than a security control — and someone who reaches a
 * hidden route by typing the URL gets a clean server-side denial, not a broken page.
 */

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!getToken()) { setSession(null); setLoading(false); return null; }
    try {
      const data = await api.session();
      setSession(data);
      setError(null);
      return data;
    } catch (err) {
      if (err instanceof ApiError && err.isAuthExpired) setSession(null);
      else setError(err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const signIn = useCallback(async (token) => {
    setToken(token);
    setLoading(true);
    return refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try { await api.post("/api/auth/logout"); } catch { /* sign out locally regardless */ }
    setToken(null);
    setSession(null);
  }, []);

  const can = useCallback((capability) => Boolean(session?.capabilities?.includes(capability)), [session]);
  const hasRole = useCallback((role) => Boolean(session?.roles?.some((r) => r.name === role)), [session]);

  return (
    <SessionContext.Provider value={{ session, loading, error, refresh, signIn, signOut, can, hasRole }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside a SessionProvider.");
  return ctx;
}
