/**
 * Shared building blocks for the Gaffer project wizard.
 *
 * Used on both the "new project" page and the edit mode of the project detail
 * page so that both surfaces look identical.
 */

import type React from "react";

export const ROLE_OPTIONS = [
  "Осветитель / Grip",
  "Best Boy",
  "Key Grip",
  "Пультовик",
  "DIT",
  "Gaffer",
] as const;

export interface SelectedMember {
  contactId: string;
  shifts: number;
  hours: number;
  plannedAmount: number;
  /** Present when the member is already persisted (edit mode). */
  memberId?: string;
}

// ─── Cost computation helpers ─────────────────────────────────────────────────

export function calcMemberCost(
  shiftRate: number,
  ot1Rate: number,
  ot2Rate: number,
  ot3Rate: number,
  shifts: number,
  hoursPerShift: number,
): { total: number; otText: string | null } {
  const BASE = 10;
  const T1_MAX = 8;
  const T2_MAX = 14; // cumulative: tier 2 covers hours 9–14 = 6 hours
  const otPerShift = Math.max(0, hoursPerShift - BASE);
  const ot1 = Math.min(otPerShift, T1_MAX);
  const ot2 = Math.min(Math.max(0, otPerShift - T1_MAX), T2_MAX - T1_MAX);
  const ot3 = Math.max(0, otPerShift - T2_MAX);
  const perShift = shiftRate + Math.round(ot1 * ot1Rate + ot2 * ot2Rate + ot3 * ot3Rate);
  const total = Math.round(perShift * shifts);
  if (otPerShift === 0) return { total, otText: null };
  const tier = ot3 > 0 ? 3 : ot2 > 0 ? 2 : 1;
  const otText = `+${otPerShift} ч ОТ · тир ${tier}`;
  return { total, otText };
}

export function deriveOtRates(shiftRate: number): {
  overtimeTier1Rate: number;
  overtimeTier2Rate: number;
  overtimeTier3Rate: number;
} {
  const hourRate = Math.round(shiftRate / 10);
  return {
    overtimeTier1Rate: hourRate,
    overtimeTier2Rate: hourRate * 2,
    overtimeTier3Rate: hourRate * 4,
  };
}

// ─── UI atoms ─────────────────────────────────────────────────────────────────

export function WizardStep({
  n,
  title,
  subtitle,
}: {
  n: number;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-baseline gap-3 px-4 pt-6 pb-2">
      <span className="w-6 h-6 rounded-full bg-accent-bright text-white text-[12px] font-bold flex items-center justify-center shrink-0">
        {n}
      </span>
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      <span className="text-[11.5px] text-ink-3">{subtitle}</span>
    </div>
  );
}

export function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded text-[12px] font-medium border transition-colors ${
        active
          ? "bg-accent-bright text-white border-accent-bright"
          : "bg-surface text-ink-2 border-border hover:bg-[#fafafa]"
      }`}
    >
      {children}
    </button>
  );
}

export function SummaryRow({
  label,
  sub,
  value,
  tone = "neutral",
  big = false,
}: {
  label: string;
  sub?: string;
  value: string;
  tone?: "neutral" | "rose" | "emerald";
  big?: boolean;
}) {
  const isEmerald = tone === "emerald";
  return (
    <div
      className={`px-3 py-2.5 flex items-center justify-between border-b border-border last:border-b-0 ${
        isEmerald ? "bg-emerald-soft border-t border-emerald-border" : ""
      }`}
    >
      <div>
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
      </div>
      <div
        className={`mono-num font-semibold ${big ? "text-[16px]" : "text-[13.5px]"} ${
          tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
