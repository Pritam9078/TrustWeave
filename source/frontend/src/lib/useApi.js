import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * Data fetching with every state the UI actually has to render: loading, empty, error,
 * denied, and loaded. Collapsing "denied" into "error" is the usual shortcut and it is
 * exactly wrong here — a 403 is a *result*, carrying the reason the authorization engine
 * refused, and the user deserves to see it rather than a generic failure.
 */
export function useApi(path, { skip = false } = {}) {
  const [state, setState] = useState({ status: skip ? "idle" : "loading", data: null, error: null });

  const load = useCallback(async () => {
    if (skip || !path) { setState({ status: "idle", data: null, error: null }); return; }
    setState((s) => ({ ...s, status: s.data ? "refreshing" : "loading" }));
    try {
      const data = await api.get(path);
      setState({ status: "loaded", data, error: null });
    } catch (err) {
      const denied = err instanceof ApiError && err.isDenial;
      setState({ status: denied ? "denied" : "error", data: null, error: err });
    }
  }, [path, skip]);

  useEffect(() => { load(); }, [load]);

  return { ...state, reload: load };
}

/** Mutations, with the same careful separation of denial from failure. */
export function useMutation(fn) {
  const [state, setState] = useState({ status: "idle", error: null, data: null });

  const run = useCallback(async (...args) => {
    setState({ status: "running", error: null, data: null });
    try {
      const data = await fn(...args);
      setState({ status: "success", error: null, data });
      return { ok: true, data };
    } catch (err) {
      const denied = err instanceof ApiError && err.isDenial;
      setState({ status: denied ? "denied" : "error", error: err, data: null });
      return { ok: false, error: err };
    }
  }, [fn]);

  const reset = useCallback(() => setState({ status: "idle", error: null, data: null }), []);
  return { ...state, run, reset };
}
