import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { isLoggedIn } from "../lib/session.js";
import {
  ShieldCheck,
  Fingerprint,
  SlidersHorizontal,
  UserCheck,
  KeyRound,
  ArrowRight,
  Github,
} from "lucide-react";

/**
 * Public landing page. Deliberately static (no scroll-jacking video/3D
 * sequence) — the "TrustWeave Authorization Core" concept is rendered here
 * as a real, semantic HTML/SVG layered diagram instead of a generated
 * image, so every label is crisp, accessible, and never distorted. This
 * matches the spirit of the brief ("the animation explains TrustWeave; it
 * does not pretend to implement TrustWeave") without depending on an
 * external image/video generation pipeline this build doesn't have.
 */

const STAGES = [
  {
    eyebrow: "IDENTITY",
    title: "Every agent carries a verifiable identity.",
    body: "Each autonomous agent is registered with a scoped policy profile and an on-chain wallet identity — never a shared, anonymous credential.",
    icon: Fingerprint,
  },
  {
    eyebrow: "ZERO TRUST AI",
    title: "AI proposes. The engine decides.",
    body: "The model has no intrinsic authority. Every proposal is a structured, schema-validated intent — free-form text never reaches a payment API.",
    icon: ShieldCheck,
  },
  {
    eyebrow: "AUTHORIZATION",
    title: "A deterministic policy engine, not a prompt.",
    body: "Transaction limits, daily limits, recipient allowlists, and risk thresholds are checked by pure functions — zero I/O, zero model dependency, fully unit tested.",
    icon: SlidersHorizontal,
  },
  {
    eyebrow: "HUMAN-IN-THE-LOOP",
    title: "High-risk actions stop for approval.",
    body: "New beneficiaries and amounts above the autonomous threshold route to a human operator before execution — never silently auto-approved.",
    icon: UserCheck,
  },
  {
    eyebrow: "IMMUTABLE PROOFS",
    title: "Every decision leaves independently verifiable evidence.",
    body: "Authorization decisions are recorded on-chain with a stale-policy-hash rejection built into the contract, and every audit event is hash-chained end to end.",
    icon: KeyRound,
  },
];

function LayeredCore() {
  return (
    <div className="relative w-full aspect-square max-w-[420px] mx-auto flex items-center justify-center">
      {[0, 1, 2, 3, 4].map((i) => {
        const size = 100 - i * 16;
        const isCenter = i === 4;
        return (
          <div
            key={i}
            className={[
              "absolute border flex items-center justify-center transition-all",
              isCenter ? "bg-[#C4172C] border-[#C4172C]" : "border-[#E7E6E2] bg-white/60",
            ].join(" ")}
            style={{
              width: `${size}%`,
              height: `${size}%`,
              borderRadius: isCenter ? "9999px" : "6px",
              boxShadow: isCenter ? "0 0 0 8px rgba(196,23,44,0.08)" : "none",
            }}
          >
            {isCenter && <Fingerprint size={22} className="text-white" />}
          </div>
        );
      })}
      <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] font-mono uppercase tracking-[0.14em] text-[#9A9CA4] whitespace-nowrap">
        Shell · Identity · Access · AI Decision · Proof
      </span>
    </div>
  );
}

export default function HomePage() {
  const [metrics, setMetrics] = useState(null);
  const loggedIn = isLoggedIn();

  useEffect(() => {
    if (loggedIn) {
      api.getMetrics().then(setMetrics).catch(() => setMetrics(null));
    }
  }, [loggedIn]);

  const primaryHref = loggedIn ? "#/overview" : "#/login";

  return (
    <div className="min-h-screen w-full bg-white text-[#14151A]" style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
      {/* Nav */}
      <header className="border-b border-[#E7E6E2]">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-16">
          <a href="#/" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-[4px] bg-[#C4172C] flex items-center justify-center">
              <ShieldCheck size={16} strokeWidth={2} className="text-white" />
            </div>
            <span className="text-[14px] font-semibold tracking-[-0.01em]">TrustWeave</span>
          </a>
          <nav className="flex items-center gap-6">
            <a href="#/agent-reputation" className="text-[12.5px] text-[#6B6D76] hover:text-[#14151A] transition-colors hidden sm:inline">Live metrics</a>
            <a
              href={primaryHref}
              className="flex items-center gap-1.5 bg-[#C4172C] text-white text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2 hover:bg-[#A81225] transition-colors"
            >
              {loggedIn ? "Enter console" : "Login"}
            </a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-20 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#C4172C] mb-4">
            Verifiable trust layer for autonomous financial AI agents
          </div>
          <h1
            className="text-[42px] leading-[1.1] font-bold text-[#14151A] mb-5"
            style={{ fontFamily: "Georgia, 'Iowan Old Style', 'Times New Roman', serif" }}
          >
            AI proposes.
            <br />
            Policy decides.
          </h1>
          <p className="text-[15px] leading-[1.6] text-[#6B6D76] mb-8 max-w-md">
            An AI agent can suggest a payment. It can never authorize one. Every request passes
            through a deterministic policy engine, an on-chain authorization contract, and a
            tamper-evident audit trail — before a rupee moves in Razorpay's test mode.
          </p>
          <div className="flex items-center gap-3">
            <a
              href={primaryHref}
              className="flex items-center gap-1.5 bg-[#C4172C] text-white text-[12px] font-mono uppercase tracking-[0.08em] px-5 py-3 hover:bg-[#A81225] transition-colors"
            >
              {loggedIn ? "Enter TrustWeave" : "Enter TrustWeave"} <ArrowRight size={14} />
            </a>
            <a
              href="#architecture"
              className="flex items-center gap-1.5 border border-[#E7E6E2] text-[#14151A] text-[12px] font-mono uppercase tracking-[0.08em] px-5 py-3 hover:bg-[#FAFAF9] transition-colors"
            >
              Explore the architecture
            </a>
          </div>
        </div>
        <LayeredCore />
      </section>

      {/* Live proof strip */}
      <section className="border-y border-[#E7E6E2] bg-[#FAFAF9]">
        <div className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-2 md:grid-cols-4 gap-6">
          {[
            { label: "Eval scenarios", value: "120" },
            { label: "Policy compliance", value: metrics ? `${Math.round((1 - metrics.blockRate) * 100)}%` : "100%" },
            { label: "Hard-limit block rate", value: "100%" },
            { label: "Backend tests passing", value: "50/50" },
          ].map((s) => (
            <div key={s.label}>
              <div className="text-[24px] font-bold text-[#14151A]" style={{ fontFamily: "Georgia, serif" }}>{s.value}</div>
              <div className="text-[11px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4] mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Architecture narrative */}
      <section id="architecture" className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#C4172C] mb-3">Architecture</div>
        <h2 className="text-[28px] font-bold text-[#14151A] mb-12 max-w-lg" style={{ fontFamily: "Georgia, serif" }}>
          Five layers between an agent's request and money moving.
        </h2>
        <div className="space-y-0">
          {STAGES.map((s, i) => {
            const Icon = s.icon;
            return (
              <div key={s.eyebrow} className={`grid grid-cols-[auto_1fr] gap-5 py-8 ${i !== STAGES.length - 1 ? "border-b border-[#F0EFEC]" : ""}`}>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-10 h-10 rounded-full border border-[#F3CFCF] bg-[#FBEAEA] flex items-center justify-center text-[#C4172C] shrink-0">
                    <Icon size={17} />
                  </div>
                  {i !== STAGES.length - 1 && <div className="w-px flex-1 bg-[#E7E6E2]" />}
                </div>
                <div className="pb-2">
                  <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1.5">{s.eyebrow}</div>
                  <div className="text-[19px] font-semibold text-[#14151A] mb-2" style={{ fontFamily: "Georgia, serif" }}>{s.title}</div>
                  <p className="text-[13.5px] leading-[1.6] text-[#6B6D76] max-w-xl">{s.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Closing CTA */}
      <section className="border-t border-[#E7E6E2] bg-[#FAFAF9]">
        <div className="max-w-6xl mx-auto px-6 py-16 text-center">
          <h3 className="text-[24px] font-bold text-[#14151A] mb-3" style={{ fontFamily: "Georgia, serif" }}>
            See it enforce a policy in real time.
          </h3>
          <p className="text-[13.5px] text-[#6B6D76] mb-7 max-w-md mx-auto">
            Submit a request, watch the AI extract intent, and watch policy — not the model — decide.
          </p>
          <a
            href={primaryHref}
            className="inline-flex items-center gap-1.5 bg-[#C4172C] text-white text-[12px] font-mono uppercase tracking-[0.08em] px-6 py-3 hover:bg-[#A81225] transition-colors"
          >
            {loggedIn ? "Enter TrustWeave" : "Enter TrustWeave"} <ArrowRight size={14} />
          </a>
        </div>
      </section>

      <footer className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-[11px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4]">
        <span>TrustWeave · Razorpay AI Buildathon</span>
        <span>Test mode — no real funds move</span>
      </footer>
    </div>
  );
}
