import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { Loader2, CheckCircle2, Circle, ArrowRight, FlaskConical } from "lucide-react";

const STAGES = [
  { key: "authorized", label: "Authorization" },
  { key: "test_mode", label: "Razorpay Test Mode" },
  { key: "order", label: "Creating payment/order" },
  { key: "webhook", label: "Webhook received" },
  { key: "captured", label: "Payment status" },
];

export default function RazorpayExecution({ param: intentId }) {
  const [intentData, setIntentData] = useState(null);
  const [execution, setExecution] = useState(null);
  const [error, setError] = useState(null);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (!intentId) return;
    let cancelled = false;

    async function run() {
      try {
        const data = await api.getPaymentIntent(intentId);
        if (cancelled) return;
        setIntentData(data);
        setStage(1);

        const exec = data.execution ?? (await api.executePaymentIntent(intentId));
        if (cancelled) return;
        setExecution(exec);
        setStage(3);

        if (!data.proof) {
          await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:4000"}/api/dev/simulate-webhook/${exec.id}`, { method: "POST" });
        }
        if (cancelled) return;
        setStage(4);

        const refreshed = await api.getPaymentIntent(intentId);
        if (cancelled) return;
        setIntentData(refreshed);
        setExecution(refreshed.execution);
        setStage(5);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [intentId]);

  if (!intentId) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "Razorpay execution"]}>
        <PageHeader eyebrow="Razorpay execution" title="No request selected." subtitle="Start a payment request first." />
      </Shell>
    );
  }

  return (
    <Shell active="payment-request" testMode crumbs={["Workspace", "Finance ops", "Razorpay execution"]}>
      <PageHeader
        eyebrow="Execution / Test mode"
        title="Executing through Razorpay."
        subtitle="This is a sandbox transaction. No real funds move in this environment."
        right={
          <span className="flex items-center gap-1.5 border border-[#B7791F] text-[#B7791F] bg-[#FBF3E3] text-[10px] font-mono uppercase tracking-[0.08em] px-3 py-1.5">
            <FlaskConical size={12} /> Test mode
          </span>
        }
      />

      {error && <div className="mb-5 border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>}

      <div className="border border-[#E7E6E2] max-w-2xl">
        <div className="p-6 space-y-4">
          {STAGES.map((s, i) => {
            const done = stage > i;
            const active = stage === i + 1;
            return (
              <div key={s.key} className="flex items-center gap-3">
                {done ? (
                  <CheckCircle2 size={16} className="text-[#3B8F5C] shrink-0" />
                ) : active ? (
                  <Loader2 size={16} className="text-[#C4172C] animate-spin shrink-0" />
                ) : (
                  <Circle size={16} className="text-[#D6D5D0] shrink-0" />
                )}
                <span className={`text-[13px] ${done || active ? "text-[#14151A]" : "text-[#B4B6BC]"}`}>{s.label}</span>
              </div>
            );
          })}
        </div>

        {execution && (
          <div className="px-6 py-5 border-t border-[#E7E6E2] bg-[#FAFAF9] space-y-2">
            <Row label="Order ID" value={execution.razorpayOrderId} />
            <Row label="Payment ID" value={execution.paymentId ?? "pending"} />
            <Row label="Status" value={execution.status} highlight={execution.status === "CAPTURED"} />
          </div>
        )}

        {stage >= 5 && (
          <div className="px-6 py-5 border-t border-[#E7E6E2]">
            <a
              href={`#/audit-timeline/${intentId}`}
              className="flex items-center justify-center gap-1.5 bg-[#C4172C] text-white text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#A81225] transition-colors"
            >
              View audit timeline &amp; proof <ArrowRight size={13} />
            </a>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Row({ label, value, highlight }) {
  return (
    <div className="flex items-center justify-between text-[13px]">
      <span className="text-[#9A9CA4]">{label}</span>
      <span className={`font-mono ${highlight ? "text-[#3B8F5C]" : "text-[#14151A]"}`}>{value}</span>
    </div>
  );
}
