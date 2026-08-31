import React, { useEffect, useState } from "react";
import HomePage from "./pages/HomePage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import Overview from "./pages/Overview.jsx";
import PaymentRequest from "./pages/PaymentRequest.jsx";
import Agents from "./pages/Agents.jsx";
import Policies from "./pages/Policies.jsx";
import BlockedRequest from "./pages/BlockedRequest.jsx";
import ProofExplorer from "./pages/ProofExplorer.jsx";
import AIAnalysis from "./pages/AIAnalysis.jsx";
import Authorization from "./pages/Authorization.jsx";
import HumanApproval from "./pages/HumanApproval.jsx";
import RazorpayExecution from "./pages/RazorpayExecution.jsx";
import AuditTimeline from "./pages/AuditTimeline.jsx";
import AgentReputation from "./pages/AgentReputation.jsx";
import { isLoggedIn } from "./lib/session.js";

// Public routes: no login required, no console shell.
const PUBLIC_ROUTES = { "": HomePage, home: HomePage, login: LoginPage };

// Internal console routes — the PDF's "Buildathon Demo Route" (section 16):
// Overview -> Create Request -> AI Evidence -> Authorization ->
// Razorpay Test Execution -> Proof Explorer -> one blocked request.
// Routes accept an optional trailing /:param (e.g. #/ai-analysis/<intentId>).
const CONSOLE_ROUTES = {
  overview: Overview,
  "payment-request": PaymentRequest,
  agents: Agents,
  policies: Policies,
  "blocked-requests": BlockedRequest,
  "proof-explorer": ProofExplorer,
  "ai-analysis": AIAnalysis,
  authorization: Authorization,
  "human-approval": HumanApproval,
  "razorpay-execution": RazorpayExecution,
  "audit-timeline": AuditTimeline,
  "agent-reputation": AgentReputation,
};

function parseHash(hash) {
  const clean = hash.replace(/^#\/?/, "");
  const [route, param] = clean.split("/");
  return { route: route ?? "", param: param ?? null };
}

function useHashRoute() {
  const [state, setState] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setState(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return state;
}

export default function App() {
  const { route, param } = useHashRoute();

  if (route in PUBLIC_ROUTES) {
    const Page = PUBLIC_ROUTES[route];
    return <Page param={param} />;
  }

  const Page = CONSOLE_ROUTES[route];
  if (!Page) {
    // Unknown route: send to the landing page rather than a blank screen.
    window.location.hash = "#/";
    return <HomePage />;
  }

  if (!isLoggedIn()) {
    // Soft guard: this app has no real per-user auth to enforce server-side
    // for the UI shell itself (see backend/src/config/auth.ts — auth is a
    // single optional shared API key, checked on every actual API call
    // regardless of this redirect). This just keeps the demo flow honest —
    // arriving at a console screen without going through "demo access"
    // first sends you there, matching the original UI doc's prescribed
    // LOGIN -> DASHBOARD order.
    window.location.hash = "#/login";
    return <LoginPage />;
  }

  return <Page param={param} />;
}
