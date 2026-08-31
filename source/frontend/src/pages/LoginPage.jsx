import React, { useState } from "react";
import { login } from "../lib/session.js";
import { api } from "../lib/api.js";
import { ShieldCheck, ArrowRight, Loader2, Mail, Lock } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  async function handleContinue(e) {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required");
      return;
    }
    
    setChecking(true);
    setError(null);
    try {
      const response = await api.loginPassword(email.trim(), password);
      
      // Store session data including token, identity, roles, and target workspace
      login({
        token: response.token,
        identity: response.identity,
        roles: response.roles,
        workspace: response.workspace,
        loggedInAt: new Date().toISOString()
      });
      
      window.location.hash = "#/overview";
    } catch (err) {
      setError(
        err.status === 401 || err.status === 400
          ? "Invalid email or password."
          : `Could not reach the backend (${err.message}). Is it running?`,
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-slate-50 flex items-center justify-center px-6" style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <a href="#/" className="flex justify-center mb-4 hover:opacity-90 transition-opacity">
            <img src="/trustweave-lockup.svg" alt="TrustWeave Logo" className="h-[72px]" />
          </a>
          <p className="text-sm text-slate-500 text-center font-medium mb-6">
            Sign in to access your administrative console and monitor intelligent agent authorizations.
          </p>
          
        </div>

        <form onSubmit={handleContinue} className="bg-white rounded-2xl shadow-xl border border-slate-100 p-8">
          
          <div className="mb-5">
            <label className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2 block">
              Email Address
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Mail size={16} className="text-slate-400" />
              </div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@northwind.test"
                className="w-full border border-slate-200 rounded-lg pl-10 pr-4 py-3 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-red-600 focus:ring-2 focus:ring-red-600/20 transition-all"
                disabled={checking}
              />
            </div>
          </div>

          <div className="mb-6">
            <label className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2 block">
              Password
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock size={16} className="text-slate-400" />
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full border border-slate-200 rounded-lg pl-10 pr-4 py-3 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-red-600 focus:ring-2 focus:ring-red-600/20 transition-all"
                disabled={checking}
              />
            </div>
          </div>

          {error && (
            <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 flex items-start">
              <div className="text-sm font-medium text-red-800 leading-relaxed">{error}</div>
            </div>
          )}

          <button
            type="submit"
            disabled={checking}
            className="w-full flex items-center justify-center gap-2 bg-[#C4172C] text-white text-sm font-bold uppercase tracking-wider px-4 py-3.5 rounded-xl shadow-md hover:bg-[#A81225] hover:shadow-lg transition-all active:scale-[0.98] disabled:opacity-70 disabled:pointer-events-none"
          >
            {checking ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
            {checking ? "Authenticating…" : "Sign In"}
          </button>
        </form>

        <p className="text-center text-xs font-medium text-slate-400 mt-8">
          <a href="#/" className="hover:text-slate-600 transition-colors">← Return to overview</a>
        </p>
      </div>
    </div>
  );
}
