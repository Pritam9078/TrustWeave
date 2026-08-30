import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SessionProvider } from "./state/session.jsx";
import { Shell, RequireSession, RequireCapability } from "./components/Shell.jsx";
import Landing from "./pages/Landing.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import { ApprovalList, ApprovalDetail } from "./pages/workspace/Approvals.jsx";
import { PaymentList, PaymentCreate, PaymentDetail } from "./pages/workspace/Payments.jsx";
import { AssetList, AssetCreate, AssetDetail } from "./pages/workspace/Assets.jsx";
import { AgentList, AgentCreate, AgentDetail } from "./pages/workspace/Agents.jsx";
import Assistant from "./pages/workspace/Assistant.jsx";
import Knowledge from "./pages/workspace/Knowledge.jsx";
import { AuditTrail, Proofs } from "./pages/workspace/AuditTrail.jsx";
import { IdentityList, IdentityCreate, IdentityDetail } from "./pages/admin/Identities.jsx";
import { Roles } from "./pages/admin/Roles.jsx";
import Scopes from "./pages/admin/Scopes.jsx";
import { PolicyList, PolicyCreate, PolicyDetail } from "./pages/admin/Policies.jsx";
import Simulator from "./pages/admin/Simulator.jsx";
import { Security, Integrations } from "./pages/admin/Security.jsx";

/**
 * Route tree.
 *
 * Every guarded route wears its required capability explicitly. This is presentation
 * routing — the same capability is enforced independently on the server for each
 * endpoint these pages call, so the guards here shape the experience without being
 * load-bearing for security.
 */
export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />

          <Route path="/app" element={<RequireSession><Shell><Dashboard /></Shell></RequireSession>} />

          <Route path="/app/approvals" element={<Guard cap="PAYMENT_READ"><ApprovalList /></Guard>} />
          <Route path="/app/approvals/:id" element={<Guard cap="PAYMENT_READ"><ApprovalDetail /></Guard>} />

          <Route path="/app/payments" element={<Guard cap="PAYMENT_READ"><PaymentList /></Guard>} />
          <Route path="/app/payments/new" element={<Guard cap="PAYMENT_CREATE"><PaymentCreate /></Guard>} />
          <Route path="/app/payments/:id" element={<Guard cap="PAYMENT_READ"><PaymentDetail /></Guard>} />

          <Route path="/app/assets" element={<Guard cap="ASSET_READ"><AssetList /></Guard>} />
          <Route path="/app/assets/new" element={<Guard cap="ASSET_CREATE"><AssetCreate /></Guard>} />
          <Route path="/app/assets/:id" element={<Guard cap="ASSET_READ"><AssetDetail /></Guard>} />

          <Route path="/app/agents" element={<Guard cap="AGENT_READ"><AgentList /></Guard>} />
          <Route path="/app/agents/new" element={<Guard cap="AGENT_REGISTER"><AgentCreate /></Guard>} />
          <Route path="/app/agents/:id" element={<Guard cap="AGENT_READ"><AgentDetail /></Guard>} />

          <Route path="/app/assistant" element={<Guard cap="AGENT_INVOKE"><Assistant /></Guard>} />
          <Route path="/app/knowledge" element={<Guard cap="KNOWLEDGE_READ"><Knowledge /></Guard>} />
          <Route path="/app/audit" element={<Guard cap="AUDIT_READ"><AuditTrail /></Guard>} />
          <Route path="/app/proofs" element={<Guard cap="PROOF_VERIFY"><Proofs /></Guard>} />

          <Route path="/app/admin/identities" element={<Guard cap="IDENTITY_READ"><IdentityList /></Guard>} />
          <Route path="/app/admin/identities/new" element={<Guard cap="IDENTITY_CREATE"><IdentityCreate /></Guard>} />
          <Route path="/app/admin/identities/:id" element={<Guard cap="IDENTITY_READ"><IdentityDetail /></Guard>} />
          <Route path="/app/admin/roles" element={<Guard cap="ROLE_READ"><Roles /></Guard>} />
          <Route path="/app/admin/scopes" element={<Guard cap="SCOPE_READ"><Scopes /></Guard>} />
          <Route path="/app/admin/policies" element={<Guard cap="POLICY_READ"><PolicyList /></Guard>} />
          <Route path="/app/admin/policies/new" element={<Guard cap="POLICY_CREATE"><PolicyCreate /></Guard>} />
          <Route path="/app/admin/policies/:id" element={<Guard cap="POLICY_READ"><PolicyDetail /></Guard>} />
          <Route path="/app/admin/simulator" element={<Guard cap="PERMISSION_SIMULATE"><Simulator /></Guard>} />
          <Route path="/app/admin/security" element={<Guard cap="SECURITY_READ"><Security /></Guard>} />
          <Route path="/app/admin/integrations" element={<Guard cap="INTEGRATION_READ"><Integrations /></Guard>} />

          <Route path="/" element={<Landing />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}

function Guard({ cap, children }) {
  return (
    <RequireSession>
      <Shell>
        <RequireCapability capability={cap}>{children}</RequireCapability>
      </Shell>
    </RequireSession>
  );
}
