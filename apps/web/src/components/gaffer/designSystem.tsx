"use client";

import React from "react";

// ── Helpers ──────────────────────────────────────────────────────────────────

function cx(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export interface PanelProps {
  children: React.ReactNode;
  className?: string;
}

export function Panel({ children, className }: PanelProps) {
  return (
    <div
      className={cx(
        "bg-gaffer-bg-panel border border-gaffer-border rounded-md shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── PanelTitle ────────────────────────────────────────────────────────────────

export interface PanelTitleProps {
  children: React.ReactNode;
  icon?: React.ReactNode;
  count?: number;
  /** Free-form right-side hint text (e.g. "сортировка по сумме", "5 человек"). */
  rightHint?: string;
}

export function PanelTitle({ children, icon, count, rightHint }: PanelTitleProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      {icon != null && (
        <span className="flex-shrink-0 text-gaffer-fg-muted">{icon}</span>
      )}
      <span className="flex-1 text-sm font-medium text-gaffer-fg">
        {children}
      </span>
      {rightHint != null && (
        <span className="text-xs text-gaffer-fg-muted">{rightHint}</span>
      )}
      {count != null && (
        <Tag tone="neutral">{count}</Tag>
      )}
    </div>
  );
}

// ── KPI ───────────────────────────────────────────────────────────────────────

export type KpiTone = "default" | "pos" | "neg" | "warn";

export interface KpiProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: KpiTone;
  /** When true, the card gets a full colored background matching the tone (pos → green-soft, neg → rose-soft). */
  colored?: boolean;
}

const kpiAccentVar: Record<KpiTone, string> = {
  default: "var(--gaffer-accent)",
  pos: "var(--gaffer-pos)",
  neg: "var(--gaffer-neg)",
  warn: "var(--gaffer-warn)",
};

const kpiColoredBg: Partial<Record<KpiTone, string>> = {
  pos: "bg-gaffer-pos-soft border-gaffer-pos/30",
  neg: "bg-gaffer-neg-soft border-gaffer-neg/30",
};

const kpiColoredLabel: Partial<Record<KpiTone, string>> = {
  pos: "text-gaffer-pos",
  neg: "text-gaffer-neg",
};

export function KPI({ label, value, sub, tone = "default", colored = false }: KpiProps) {
  if (colored && (tone === "pos" || tone === "neg")) {
    const bgClass = kpiColoredBg[tone] ?? "";
    const textClass = kpiColoredLabel[tone] ?? "text-gaffer-fg";
    return (
      <div className={`rounded-md border p-3 ${bgClass}`}>
        <div className={`text-xs font-semibold uppercase tracking-wide mb-1 ${textClass}`}>{label}</div>
        <div className={`font-mono text-[28px] leading-none font-semibold ${textClass}`}>
          {value}
        </div>
        {sub != null && (
          <div className={`text-xs mt-1 opacity-70 ${textClass}`}>{sub}</div>
        )}
      </div>
    );
  }

  return (
    <Panel className="overflow-hidden">
      <div className="flex">
        {/* Accent strip */}
        <div
          data-tone={tone}
          style={{ width: 3, background: kpiAccentVar[tone], flexShrink: 0 }}
        />
        <div className="flex-1 px-3 py-3">
          <div className="text-xs text-gaffer-fg-muted mb-1">{label}</div>
          <div className="font-mono text-[28px] leading-none text-gaffer-fg font-semibold">
            {value}
          </div>
          {sub != null && (
            <div className="text-xs text-gaffer-fg-muted mt-1">{sub}</div>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ── Segmented ─────────────────────────────────────────────────────────────────

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** When true, container takes full width and each option stretches equally. */
  fullWidth?: boolean;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  fullWidth = false,
}: SegmentedProps<T>) {
  return (
    <div
      className={cx(
        "gap-0.5 p-0.5 bg-gaffer-bg-sub rounded-md",
        fullWidth ? "flex w-full" : "inline-flex",
      )}
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={cx(
              "px-3 py-1 text-sm rounded transition-colors",
              fullWidth ? "flex-1 justify-center" : "",
              active
                ? "bg-gaffer-bg-panel border border-gaffer-border-strong shadow-sm text-gaffer-fg font-medium"
                : "bg-transparent text-gaffer-fg-muted hover:text-gaffer-fg",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Tag ───────────────────────────────────────────────────────────────────────

export type TagTone = "pos" | "neg" | "warn" | "info" | "neutral";

export interface TagProps {
  tone: TagTone;
  children: React.ReactNode;
}

const tagClasses: Record<TagTone, string> = {
  pos: "bg-gaffer-pos-soft text-gaffer-pos",
  neg: "bg-gaffer-neg-soft text-gaffer-neg",
  warn: "bg-gaffer-warn-soft text-gaffer-warn",
  info: "bg-gaffer-info-soft text-gaffer-info",
  neutral: "bg-gaffer-bg-sub text-gaffer-fg-muted",
};

export function Tag({ tone, children }: TagProps) {
  return (
    <span
      data-tag-tone={tone}
      className={cx(
        "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium",
        tagClasses[tone],
      )}
    >
      {children}
    </span>
  );
}

// ── BalanceBar ────────────────────────────────────────────────────────────────

export interface BalanceBarProps {
  received: number;
  paid: number;
  remaining: number;
  total: number;
}

export function BalanceBar({ received, paid, remaining, total }: BalanceBarProps) {
  const r = Math.max(0, received);
  const p = Math.max(0, paid);
  const rem = Math.max(0, remaining);
  const denom = Math.max(1, total, r + p + rem);

  const rW = (r / denom) * 100;
  const pW = (p / denom) * 100;
  const remW = (rem / denom) * 100;
  // Clamp total to 100% for rounding
  const clamp = (v: number) => Math.min(100, Math.max(0, v));

  const height = 6;
  const radius = 3;

  return (
    <svg
      width="100%"
      height={height}
      aria-label={`Получено ${r}, выплачено ${p}, осталось ${rem}`}
      style={{ display: "block" }}
    >
      {/* received (pos) */}
      <rect
        x="0"
        y="0"
        width={`${clamp(rW)}%`}
        height={height}
        rx={radius}
        style={{ fill: "var(--gaffer-pos)" }}
      />
      {/* paid (accent/indigo) */}
      <rect
        x={`${clamp(rW)}%`}
        y="0"
        width={`${clamp(pW)}%`}
        height={height}
        rx={radius}
        style={{ fill: "var(--gaffer-accent)" }}
      />
      {/* remaining (border-strong) */}
      <rect
        x={`${clamp(rW + pW)}%`}
        y="0"
        width={`${clamp(remW)}%`}
        height={height}
        rx={radius}
        style={{ fill: "var(--gaffer-border-strong)" }}
      />
    </svg>
  );
}

// ── Donut ─────────────────────────────────────────────────────────────────────

export interface DonutSegment {
  value: number;
  color: string;
  label: string;
}

export interface DonutProps {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
}

export function Donut({ segments, size = 120, thickness = 16 }: DonutProps) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const cx2 = size / 2;
  const cy2 = size / 2;
  const circumference = 2 * Math.PI * r;

  const ariaLabel = `Donut: ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}, всего ${total}`;

  if (total === 0) {
    return (
      <svg
        role="img"
        width={size}
        height={size}
        aria-label={ariaLabel}
        style={{ transform: "rotate(-90deg)" }}
      >
        <circle
          cx={cx2}
          cy={cy2}
          r={r}
          stroke="#e5e7eb"
          strokeWidth={thickness}
          fill="none"
        />
      </svg>
    );
  }

  let offset = 0;
  return (
    <svg
      role="img"
      width={size}
      height={size}
      aria-label={ariaLabel}
      style={{ transform: "rotate(-90deg)" }}
    >
      {/* Background ring */}
      <circle
        cx={cx2}
        cy={cy2}
        r={r}
        stroke="#e5e7eb"
        strokeWidth={thickness}
        fill="none"
      />
      {segments.map((seg, i) => {
        const len = (seg.value / total) * circumference;
        const dasharray = `${len} ${circumference - len}`;
        const dashoffset = -offset;
        offset += len;
        return (
          <circle
            key={i}
            cx={cx2}
            cy={cy2}
            r={r}
            stroke={seg.color}
            strokeWidth={thickness}
            fill="none"
            strokeDasharray={dasharray}
            strokeDashoffset={dashoffset}
            strokeLinecap="butt"
          />
        );
      })}
    </svg>
  );
}

// ── Eyebrow ───────────────────────────────────────────────────────────────────

export interface EyebrowProps {
  children: React.ReactNode;
}

export function Eyebrow({ children }: EyebrowProps) {
  return (
    <div className="text-xs uppercase tracking-wide text-gaffer-fg-subtle font-medium">
      {children}
    </div>
  );
}

// ── H1Title ───────────────────────────────────────────────────────────────────

export interface H1TitleProps {
  children: React.ReactNode;
}

export function H1Title({ children }: H1TitleProps) {
  return (
    <h1 className="text-[28px] font-semibold text-gaffer-fg leading-tight">
      {children}
    </h1>
  );
}

// ── H1Subtitle ────────────────────────────────────────────────────────────────

export interface H1SubtitleProps {
  children: React.ReactNode;
}

export function H1Subtitle({ children }: H1SubtitleProps) {
  return (
    <div className="text-sm text-gaffer-fg-muted mt-1">{children}</div>
  );
}
