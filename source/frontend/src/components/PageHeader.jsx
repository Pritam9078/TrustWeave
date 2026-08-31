import React from "react";

/**
 * Eyebrow + big serif headline + supporting line, matching every TrustWeave
 * screen ("Policy is the hard boundary.", "Agents with a bounded remit.", …).
 */
export default function PageHeader({ eyebrow, title, subtitle, accent = "#C4172C", right = null }) {
  return (
    <div className="flex items-start justify-between mb-7">
      <div className="max-w-[640px]">
        <div
          className="text-[11px] font-mono uppercase tracking-[0.14em] mb-2"
          style={{ color: accent }}
        >
          {eyebrow}
        </div>
        <h1
          className="text-[34px] leading-[1.15] font-bold text-[#14151A] mb-2"
          style={{ fontFamily: "Georgia, 'Iowan Old Style', 'Times New Roman', serif" }}
        >
          {title}
        </h1>
        {subtitle && <p className="text-[14px] leading-[1.5] text-[#6B6D76]">{subtitle}</p>}
      </div>
      {right ?? (
        <button
          disabled
          className="shrink-0 text-[11px] font-mono uppercase tracking-[0.08em] text-[#C7C6C1] border border-[#EDECE8] px-3 py-2 cursor-not-allowed"
        >
          Back to overview
        </button>
      )}
    </div>
  );
}
