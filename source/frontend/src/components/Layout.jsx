import React from "react";
import {
  ShieldCheck,
  Activity,
  Plus,
  Fingerprint,
  Ban,
  Boxes,
  SlidersHorizontal,
  ChevronRight,
  User,
  Database,
  TrendingUp,
  LogOut,
} from "lucide-react";
import { getIdentity, logout, getWorkspace } from "../lib/session.js";
import { api } from "../lib/api.js";

/**
 * TrustWeave — shared design tokens
 * -----------------------------------------------------------------------
 * Color
 *   --ink        #14151A   primary text / headline serif
 *   --ink-soft   #6B6D76   secondary text
 *   --line       #E7E6E2   hairline borders
 *   --paper      #FFFFFF   page background
 *   --accent     #C4172C   TrustWeave red (brand, blocks, alerts)
 *   --accent-tint#FBEAEA   red tint (selected rows / active panels)
 *   --amber      #B7791F   monitoring / review states
 *   --amber-tint #FBF3E3
 *   --mono-tint  #F6F6F4   subtle panel fill
 *
 * Type
 *   Display  — Georgia/"Iowan Old Style"-style serif, bold, tight tracking
 *   UI/Data  — ui-monospace, "SFMono-Regular", "IBM Plex Mono", monospace
 *   Body     — system sans, Inter-esque
 *
 * Layout
 *   237px fixed left rail · top bar with breadcrumb · two-pane content
 *   Square corners throughout except small radii on pills/buttons (2–3px)
 * -----------------------------------------------------------------------
 */

export const NAV_OPERATIONS = [
  { key: "overview", label: "Overview", icon: Activity, href: "#/overview", workspaces: ["admin", "manager", "auditor", "user"] },
  { key: "payment-request", label: "Payment request", icon: Plus, href: "#/payment-request", workspaces: ["admin", "manager", "user"] },
  { key: "proof-explorer", label: "Proof explorer", icon: Fingerprint, href: "#/proof-explorer", workspaces: ["admin", "manager", "auditor"] },
  { key: "blocked-requests", label: "Blocked requests", icon: Ban, href: "#/blocked-requests", countKey: "blocked", workspaces: ["admin", "manager"] },
];

export const NAV_SYSTEM = [
  { key: "agents", label: "Agents", icon: Boxes, href: "#/agents", countKey: "agents", workspaces: ["admin", "manager"] },
  { key: "agent-reputation", label: "Reputation", icon: TrendingUp, href: "#/agent-reputation", workspaces: ["admin"] },
  { key: "policies", label: "Policies", icon: SlidersHorizontal, href: "#/policies", workspaces: ["admin", "manager"] },
];

function NavRow({ item, active, count }) {
  const Icon = item.icon;
  return (
    <a
      href={item.href}
      className={[
        "group flex items-center justify-between px-3 py-[7px] border-l-2 transition-colors",
        active
          ? "border-[#C4172C] bg-[#FBEAEA] text-[#C4172C]"
          : "border-transparent text-[#4B4D55] hover:bg-[#F6F6F4] hover:text-[#14151A]",
      ].join(" ")}
    >
      <span className="flex items-center gap-2.5">
        <Icon size={15} strokeWidth={1.75} className={active ? "text-[#C4172C]" : "text-[#8A8C94]"} />
        <span className="text-[13px] font-medium tracking-[-0.01em]">{item.label}</span>
      </span>
      {count !== undefined ? (
        <span
          className={[
            "font-mono text-[11px] tabular-nums",
            active ? "text-[#C4172C]" : "text-[#9A9CA4]",
          ].join(" ")}
        >
          {count}
        </span>
      ) : null}
    </a>
  );
}

/** Left navigation rail. `active` = key from NAV_OPERATIONS / NAV_SYSTEM. */
export function Sidebar({ active = "overview", testMode = false, operator, role = "Finance operator", initials = "RK" }) {
  const operatorName = operator ?? (getIdentity()?.email || "User");
  const displayInitials = operator
    ? initials
    : operatorName
        .split(/[.\s]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0]?.toUpperCase())
        .join("") || "DO";

  const [counts, setCounts] = React.useState({ agents: 0, blocked: 0 });

  React.useEffect(() => {
    Promise.allSettled([api.listAgents(), api.listPaymentIntents({ limit: "100" })]).then(([aRes, iRes]) => {
      let agentsCount = counts.agents;
      let blockedCount = counts.blocked;
      if (aRes.status === "fulfilled") agentsCount = aRes.value.length;
      if (iRes.status === "fulfilled") blockedCount = aRes.value.filter(i => i.status === "BLOCKED").length;
      setCounts({ agents: agentsCount, blocked: blockedCount });
    });
  }, []);

  let currentWorkspace = getWorkspace();
  if (getIdentity()?.email === "opsmgr@northwind.test") {
    currentWorkspace = "user";
  }

  function handleLogout() {
    logout();
    window.location.hash = "#/";
  }

  const visibleOperations = NAV_OPERATIONS.filter(item => item.workspaces.includes(currentWorkspace));
  const visibleSystem = NAV_SYSTEM.filter(item => item.workspaces.includes(currentWorkspace));

  return (
    <aside className="w-[237px] shrink-0 border-r border-[#E7E6E2] bg-white flex flex-col h-full">
      <a href="#/" className="flex items-center gap-2.5 px-5 h-[64px] border-b border-[#E7E6E2] hover:bg-[#FAFAF9] transition-colors">
        <img src="/trustweave-icon.svg" alt="TrustWeave" className="w-7 h-7 rounded-[4px]" />
        <div className="leading-tight">
          <div className="text-[14px] font-semibold text-[#14151A] tracking-[-0.01em]">TrustWeave</div>
          <div className="text-[9px] font-mono uppercase tracking-[0.12em] text-[#9A9CA4]">Control plane</div>
        </div>
      </a>

      <nav className="flex-1 pt-5 overflow-y-auto">
        {visibleOperations.length > 0 && (
          <>
            <div className="px-5 mb-2 text-[10px] font-mono uppercase tracking-[0.14em] text-[#B4B6BC]">Operations</div>
            <div className="space-y-0.5 mb-6">
              {visibleOperations.map((item) => (
                <NavRow key={item.key} item={item} active={active === item.key} count={item.countKey ? counts[item.countKey] : undefined} />
              ))}
            </div>
          </>
        )}

        {visibleSystem.length > 0 && (
          <>
            <div className="px-5 mb-2 text-[10px] font-mono uppercase tracking-[0.14em] text-[#B4B6BC]">System</div>
            <div className="space-y-0.5">
              {visibleSystem.map((item) => (
                <NavRow key={item.key} item={item} active={active === item.key} count={item.countKey ? counts[item.countKey] : undefined} />
              ))}
            </div>
          </>
        )}
      </nav>


      <div className="flex items-center justify-between px-4 py-3 border-t border-[#E7E6E2]">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-full bg-[#F6F6F4] border border-[#E7E6E2] flex items-center justify-center text-[10px] font-mono font-semibold text-[#6B6D76] shrink-0">
            {displayInitials}
          </div>
          <div className="leading-tight min-w-0">
            <div className="text-[12px] text-[#14151A] font-medium truncate">{operatorName}</div>
            <div className="text-[9px] font-mono uppercase tracking-[0.08em] text-[#9A9CA4]">{role}</div>
          </div>
        </div>
        <button onClick={handleLogout} title="Exit console" className="text-[#B4B6BC] hover:text-[#C4172C] transition-colors shrink-0">
          <LogOut size={14} strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  );
}

/** Top bar with workspace breadcrumb + system status + operator chip. */
export function Topbar({ crumbs = ["Workspace"], active = "" }) {
  return (
    <header className="h-[64px] shrink-0 border-b border-[#E7E6E2] bg-white flex items-center justify-between px-8">
      <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.08em] text-[#9A9CA4]">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight size={12} className="text-[#D6D5D0]" />}
            <span className={i === crumbs.length - 1 ? "text-[#14151A]" : ""}>{c}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.08em] text-[#6B6D76]">
          <span className="w-1.5 h-1.5 bg-[#C4172C]" />
          All systems nominal
        </div>
        <div className="w-6 h-6 rounded-full bg-[#FBEAEA] border border-[#F3CFCF] flex items-center justify-center text-[9px] font-mono font-bold text-[#C4172C]">
          RK
        </div>
        <User size={16} strokeWidth={1.75} className="text-[#B4B6BC]" />
      </div>
    </header>
  );
}

/** Slim status footer shown on data-heavy screens. */
export function StatusFooter({ version = "TrustWeave Control Plane · v0.9.4", lastCommit = "09:41:21 IST" }) {
  return (
    <footer className="h-[36px] shrink-0 border-t border-[#E7E6E2] bg-white flex items-center justify-between px-8 text-[10px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4]">
      <span>{version}</span>
      <span className="flex items-center gap-1.5">
        <Database size={11} strokeWidth={1.75} />
        Ledger sync <span className="text-[#3B8F5C] normal-case tracking-normal">Healthy</span> · Last commit {lastCommit}
      </span>
    </footer>
  );
}

/** Page wrapper: sidebar + main column. Wrap page body in <main>. */
export default function Shell({ active, testMode, crumbs, children, footer = true }) {
  return (
    <div className="h-screen w-full flex bg-white text-[#14151A] antialiased" style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
      <Sidebar active={active} testMode={testMode} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar crumbs={crumbs} />
        <main className="flex-1 overflow-y-auto px-8 py-7">{children}</main>
        {footer && <StatusFooter />}
      </div>
    </div>
  );
}
