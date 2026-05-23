"use client";

import { Suspense, useMemo, useState, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  calcPersonCost,
  type CalculationResult,
  type CrewInput,
  RATE_CARDS,
  type RateCard,
  type RateCardId,
  type RateCardPositionKey,
  type RoleBreakdown,
  type RoleConfig,
  ROLES,
  type RoleId,
} from "@light-rental/shared";
import { formatMoneyRub } from "../../src/lib/format";

// ─── Rate cards integration ───────────────────────────────────────────────────

// Public toggle ids — exclude "custom" which is a Gaffer-CRM-only sentinel.
type ToggleCardId = Exclude<RateCardId, "custom">;
const TOGGLE_CARD_IDS: ToggleCardId[] = ["rates_2026", "rates_2024"];
const DEFAULT_CARD: ToggleCardId = "rates_2026";

const TOGGLE_LABELS: Record<ToggleCardId, { short: string; long: string }> = {
  rates_2026: { short: "Новые", long: "Тариф 2026" },
  rates_2024: { short: "Старые", long: "Тариф 2024" },
};

// Map calculator's RoleId enum to RateCard position keys.
const ROLE_TO_POSITION: Record<RoleId, RateCardPositionKey> = {
  GAFFER: "gaffer",
  KEY_GRIP: "key_grip",
  BEST_BOY: "best_boy",
  PROGRAMMER: "programmer",
  GRIP: "grip",
};

/**
 * Build a RoleConfig[] list (calculator's native shape) from a RateCard.
 * Keeps the existing Russian role labels from ROLES, replaces only rate values.
 */
function buildRolesFromCard(card: RateCard): RoleConfig[] {
  return ROLES.map((existing) => {
    const data = card.positions[ROLE_TO_POSITION[existing.id]];
    return {
      id: existing.id,
      label: existing.label,
      shiftRate: data.shiftRate,
      overtime: {
        tier1: data.ot1Rate,
        tier2: data.ot2Rate,
        tier3: data.ot3Rate,
      },
    };
  });
}

/**
 * Same logic as shared `calculateCrewCost`, but parameterised by an explicit
 * roles list so the page can switch between rate cards without touching the
 * shared package contract.
 */
function calculateForRoles(
  roles: RoleConfig[],
  crew: CrewInput,
  hours: number | null | undefined,
): CalculationResult {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) {
    return { lines: [], grandTotal: 0 };
  }
  const lines: RoleBreakdown[] = [];
  for (const role of roles) {
    const count = crew[role.id] ?? 0;
    if (!Number.isFinite(count) || count <= 0) continue;
    const perPerson = calcPersonCost(role, hours);
    const totalForRole = Math.round(perPerson.totalPerPerson * count);
    lines.push({
      role: role.id,
      label: role.label,
      count,
      hoursWorked: hours,
      ...perPerson,
      totalForRole,
    });
  }
  return { lines, grandTotal: lines.reduce((s, l) => s + l.totalForRole, 0) };
}

function parseCardId(raw: string | null | undefined): ToggleCardId {
  return raw === "rates_2024" || raw === "rates_2026" ? raw : DEFAULT_CARD;
}

/** «2026-05-01» → «1 мая 2026» */
function formatEffectiveFrom(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HOUR_PRESETS = [8, 10, 12, 14, 16] as const;

type CrewPreset = { id: string; label: string; sub: string; counts: Partial<Record<RoleId, number>> };

const CREW_PRESETS: CrewPreset[] = [
  {
    id: "minimal",
    label: "Минимум",
    sub: "Gaffer + Grip",
    counts: { GAFFER: 1, GRIP: 1 },
  },
  {
    id: "standard",
    label: "Стандарт",
    sub: "Gaffer + Key Grip + 2 Grip",
    counts: { GAFFER: 1, KEY_GRIP: 1, GRIP: 2 },
  },
  {
    id: "large",
    label: "Большая съёмка",
    sub: "Полный сетап с пультовиком",
    counts: { GAFFER: 1, KEY_GRIP: 1, BEST_BOY: 1, PROGRAMMER: 1, GRIP: 3 },
  },
];

const BASE_SHIFT = 10;

// Tariff palette (semantic) — base / OT1 / OT2 / OT3 progression
const TIER_PALETTE = {
  base: { bg: "bg-slate-soft", fg: "text-slate", border: "border-slate-border", solid: "bg-slate" },
  ot1: { bg: "bg-amber-soft", fg: "text-amber", border: "border-amber-border", solid: "bg-amber" },
  ot2: { bg: "bg-amber-soft", fg: "text-amber", border: "border-amber-border", solid: "bg-amber" },
  ot3: { bg: "bg-rose-soft", fg: "text-rose", border: "border-rose-border", solid: "bg-rose" },
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseCount(raw: string): number {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseHours(raw: string): number | null {
  if (raw === "" || raw === null) return null;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function hoursDescriptor(h: number | null): string {
  if (h === null) return "";
  if (h === 0) return "не указано";
  if (h <= 6) return "короткий день";
  if (h <= 10) return "базовая смена";
  if (h <= 12) return "стандартная переработка";
  if (h <= 18) return "длинная съёмка";
  return "экстремальная переработка";
}

type CountState = Record<RoleId, string>;
const DEFAULT_COUNTS: CountState = {
  GAFFER: "",
  KEY_GRIP: "",
  BEST_BOY: "",
  PROGRAMMER: "",
  GRIP: "",
};

// Read state from URL search params on mount
function readUrlState(sp: URLSearchParams): { counts: CountState; hours: string; cardId: ToggleCardId } {
  const counts: CountState = { ...DEFAULT_COUNTS };
  for (const role of ROLES) {
    const v = sp.get(role.id.toLowerCase());
    if (v && /^\d+$/.test(v) && parseInt(v, 10) > 0) counts[role.id] = v;
  }
  const h = sp.get("h");
  const hours = h && /^\d+(\.\d+)?$/.test(h) ? h : "";
  const cardId = parseCardId(sp.get("rc"));
  return { counts, hours, cardId };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Horizontal ribbon showing how the worked hours split across base + OT tiers.
 * Pure visual primitive — one unit = one hour, segments colour-coded by tariff.
 */
function HourRibbon({ hours }: { hours: number }) {
  // Cap visual at 24h, but show actual segments scaled
  const cap = Math.max(hours, BASE_SHIFT, 14);
  const segments: { tier: keyof typeof TIER_PALETTE; from: number; to: number; label: string }[] = [];

  // Base (0 → min(hours, 10))
  segments.push({ tier: "base", from: 0, to: Math.min(hours, 10), label: "База" });
  if (hours > 10) segments.push({ tier: "ot1", from: 10, to: Math.min(hours, 18), label: "OT 1–8" });
  if (hours > 18) segments.push({ tier: "ot2", from: 18, to: Math.min(hours, 24), label: "OT 9–14" });
  if (hours > 24) segments.push({ tier: "ot3", from: 24, to: hours, label: "OT 15+" });

  // Tick marks
  const ticks = [0, 4, 8, 10, 14, 18, 24].filter((t) => t <= Math.max(cap, hours));

  return (
    <div className="space-y-2">
      <div className="relative h-9 rounded-md overflow-hidden border border-border bg-surface-subtle">
        {segments.map((seg, i) => {
          const widthPct = ((seg.to - seg.from) / cap) * 100;
          const leftPct = (seg.from / cap) * 100;
          const palette = TIER_PALETTE[seg.tier];
          return (
            <div
              key={i}
              className={`absolute top-0 bottom-0 ${palette.bg} ${i === 0 ? "" : "border-l border-white"}`}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              title={`${seg.label}: ${seg.from}–${seg.to.toFixed(seg.to % 1 === 0 ? 0 : 1)} ч`}
            >
              {widthPct > 12 && (
                <div className={`absolute inset-0 flex items-center px-2 text-[10px] font-cond font-semibold uppercase tracking-wider ${palette.fg}`}>
                  {seg.label}
                </div>
              )}
            </div>
          );
        })}
        {/* Base shift marker line at 10h */}
        {cap > 10 && (
          <div
            className="absolute top-0 bottom-0 w-px bg-ink/40"
            style={{ left: `${(10 / cap) * 100}%` }}
            aria-hidden
          />
        )}
        {/* Current position marker */}
        <div
          className="absolute -top-1 -bottom-1 w-px bg-ink"
          style={{ left: `${(hours / cap) * 100}%` }}
          aria-hidden
        >
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-ink" />
        </div>
      </div>
      {/* Tick labels */}
      <div className="relative h-3 text-[10px] font-cond text-ink-3 tabular-nums">
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute -translate-x-1/2"
            style={{ left: `${(t / cap) * 100}%` }}
          >
            {t}ч
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Compact role row: stepper on left, stacked-bar breakdown on right.
 * Shows base/OT split visually + total per role.
 */
function RoleRow({
  role,
  count,
  hours,
  onChange,
}: {
  role: typeof ROLES[number];
  count: number;
  hours: number | null;
  onChange: (next: number) => void;
}) {
  const breakdown = useMemo(() => {
    if (hours === null || count === 0) return null;
    const per = calcPersonCost(role, hours);
    const total = per.totalPerPerson * count;
    return { ...per, total };
  }, [role, hours, count]);

  const segments = useMemo(() => {
    if (!breakdown) return [];
    const total = breakdown.totalPerPerson;
    return [
      { key: "base", value: breakdown.baseShiftCost, palette: TIER_PALETTE.base },
      { key: "ot1", value: breakdown.overtimeTier1Cost, palette: TIER_PALETTE.ot1 },
      { key: "ot2", value: breakdown.overtimeTier2Cost, palette: TIER_PALETTE.ot2 },
      { key: "ot3", value: breakdown.overtimeTier3Cost, palette: TIER_PALETTE.ot3 },
    ]
      .filter((s) => s.value > 0)
      .map((s) => ({ ...s, pct: total > 0 ? (s.value / total) * 100 : 0 }));
  }, [breakdown]);

  const isActive = count > 0;

  return (
    <div
      className={`group py-3 px-3 -mx-3 rounded-md transition-colors ${
        isActive ? "bg-accent-soft/40" : "hover:bg-surface-subtle"
      }`}
    >
      {/* Top row: name | stepper | total */}
      <div className="flex items-center gap-3">
        {/* Role name + rate */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink truncate">{role.label}</div>
          <div className="text-xs text-ink-3 mono-num">
            {formatMoneyRub(role.shiftRate)} ₽ / смена
          </div>
        </div>

        {/* Stepper */}
        <div className="shrink-0">
          <div className="inline-flex items-center rounded-md border border-border bg-surface overflow-hidden">
            <button
              type="button"
              aria-label={`Убрать ${role.label}`}
              className="h-8 w-8 text-base text-ink-2 bg-surface hover:bg-surface-subtle disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              disabled={count <= 0}
              onClick={() => onChange(Math.max(0, count - 1))}
            >
              −
            </button>
            <div className="h-8 w-10 border-x border-border bg-surface flex items-center justify-center text-sm font-semibold mono-num">
              {count || 0}
            </div>
            <button
              type="button"
              aria-label={`Добавить ${role.label}`}
              className="h-8 w-8 text-base text-ink-2 bg-surface hover:bg-surface-subtle transition-colors"
              onClick={() => onChange(count + 1)}
            >
              +
            </button>
          </div>
        </div>

        {/* Total — appears only when active */}
        {isActive && breakdown && (
          <div className="text-right shrink-0 min-w-[88px]">
            <div className="text-sm font-semibold text-ink mono-num whitespace-nowrap">
              {formatMoneyRub(breakdown.total)} ₽
            </div>
            {count > 1 && (
              <div className="text-[10px] text-ink-3 mono-num whitespace-nowrap leading-tight">
                {formatMoneyRub(breakdown.totalPerPerson)} × {count}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom row: bar + legend (full-width when active) */}
      {isActive && breakdown ? (
        <div className="mt-2.5 space-y-1">
          {/* Stacked bar */}
          <div className="flex h-2 rounded-full overflow-hidden bg-surface-subtle">
            {segments.map((s) => (
              <div
                key={s.key}
                className={s.palette.solid}
                style={{ width: `${s.pct}%` }}
                title={`${formatMoneyRub(s.value)} ₽`}
              />
            ))}
          </div>
          {/* Compact legend under bar */}
          {breakdown.totalOvertimeCostPerPerson > 0 && (
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-cond uppercase tracking-wide text-ink-3">
              <span>
                база <span className="text-ink-2 mono-num">{formatMoneyRub(breakdown.baseShiftCost)}</span>
              </span>
              <span aria-hidden>·</span>
              <span className="text-amber">
                ОТ <span className="text-amber mono-num">+{formatMoneyRub(breakdown.totalOvertimeCostPerPerson)}</span>
              </span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Per-role detail row inside the printable summary table.
 * Carries all numeric fields for the PDF reader.
 */
function PrintRow({ l }: { l: RoleBreakdown }) {
  return (
    <tr className="border-b border-border">
      <td className="py-2 pr-3 font-medium">{l.label}</td>
      <td className="py-2 px-3 text-center mono-num">{l.count}</td>
      <td className="py-2 px-3 text-right mono-num">{formatMoneyRub(l.baseShiftCost)}</td>
      <td className="py-2 px-3 text-right mono-num">
        {l.overtimeTier1Hours > 0 ? `${l.overtimeTier1Hours}ч · ${formatMoneyRub(l.overtimeTier1Cost)}` : "—"}
      </td>
      <td className="py-2 px-3 text-right mono-num">
        {l.overtimeTier2Hours > 0 ? `${l.overtimeTier2Hours}ч · ${formatMoneyRub(l.overtimeTier2Cost)}` : "—"}
      </td>
      <td className="py-2 px-3 text-right mono-num">
        {l.overtimeTier3Hours > 0 ? `${l.overtimeTier3Hours}ч · ${formatMoneyRub(l.overtimeTier3Cost)}` : "—"}
      </td>
      <td className="py-2 px-3 text-right mono-num font-medium">{formatMoneyRub(l.totalPerPerson)}</td>
      <td className="py-2 pl-3 text-right mono-num font-bold">{formatMoneyRub(l.totalForRole)}</td>
    </tr>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CrewCalculatorPage() {
  // Next.js 14 requires useSearchParams consumers to be wrapped in <Suspense>
  // or the page falls back to fully client-rendered. See project convention
  // in CLAUDE.md — same pattern as /bookings, /tasks.
  return (
    <Suspense fallback={null}>
      <CrewCalculatorPageInner />
    </Suspense>
  );
}

function CrewCalculatorPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [counts, setCounts] = useState<CountState>(DEFAULT_COUNTS);
  const [hoursRaw, setHoursRaw] = useState("");
  const [cardId, setCardId] = useState<ToggleCardId>(DEFAULT_CARD);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from URL once
  useEffect(() => {
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    const initial = readUrlState(sp);
    setCounts({ ...DEFAULT_COUNTS, ...initial.counts });
    setHoursRaw(initial.hours);
    setCardId(initial.cardId);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync state → URL (debounced via microtask)
  useEffect(() => {
    if (!hydrated) return;
    const sp = new URLSearchParams();
    if (hoursRaw) sp.set("h", hoursRaw);
    for (const role of ROLES) {
      const v = counts[role.id];
      if (v && parseCount(v) > 0) sp.set(role.id.toLowerCase(), v);
    }
    if (cardId !== DEFAULT_CARD) sp.set("rc", cardId);
    const q = sp.toString();
    router.replace(q ? `?${q}` : "?", { scroll: false });
  }, [counts, hoursRaw, cardId, hydrated, router]);

  const hours = useMemo(() => parseHours(hoursRaw), [hoursRaw]);

  const activeCard = RATE_CARDS[cardId];
  const activeRoles = useMemo(() => buildRolesFromCard(activeCard), [activeCard]);

  const crew = useMemo<Partial<Record<RoleId, number>>>(
    () =>
      Object.fromEntries(
        ROLES.map((r) => [r.id, parseCount(counts[r.id])]),
      ) as Record<RoleId, number>,
    [counts],
  );

  const result = useMemo(
    () => calculateForRoles(activeRoles, crew, hours),
    [activeRoles, crew, hours],
  );

  // Base-shift comparison (same crew, exactly 10h, same rate card)
  const baseResult = useMemo(
    () => calculateForRoles(activeRoles, crew, BASE_SHIFT),
    [activeRoles, crew],
  );
  const overtimePremium = result.grandTotal - baseResult.grandTotal;

  const totalCrewSize = result.lines.reduce((s, l) => s + l.count, 0);
  const totalOvertimeCost = result.lines.reduce((s, l) => s + l.totalOvertimeCostPerPerson * l.count, 0);
  const effectiveRate = hours && hours > 0 && totalCrewSize > 0 ? result.grandTotal / hours / totalCrewSize : 0;

  const hoursLabel =
    hours !== null
      ? hours === 0
        ? "0 ч"
        : `${hours} ч`
      : "—";

  const overtimeHours = hours !== null && hours > BASE_SHIFT ? +(hours - BASE_SHIFT).toFixed(2) : 0;

  // Print date — empty during SSR, filled after mount
  const [printDate, setPrintDate] = useState("");
  useEffect(() => {
    setPrintDate(
      new Date().toLocaleString("ru-RU", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }, []);

  const setRoleCount = useCallback((roleId: RoleId, next: number) => {
    setCounts((p) => ({ ...p, [roleId]: next > 0 ? String(next) : "" }));
    setActivePreset(null);
  }, []);

  const applyPreset = useCallback((preset: CrewPreset) => {
    const next: CountState = { ...DEFAULT_COUNTS };
    for (const [k, v] of Object.entries(preset.counts)) {
      next[k as RoleId] = v ? String(v) : "";
    }
    setCounts(next);
    setActivePreset(preset.id);
  }, []);

  const reset = useCallback(() => {
    setCounts(DEFAULT_COUNTS);
    setHoursRaw("");
    setActivePreset(null);
  }, []);

  const exportPdf = useCallback(() => window.print(), []);

  // Determine current preset match (e.g. if user manually replicates "Стандарт")
  const matchingPreset = useMemo(() => {
    if (totalCrewSize === 0) return null;
    return CREW_PRESETS.find((p) => {
      for (const role of ROLES) {
        const expected = p.counts[role.id] ?? 0;
        const actual = parseCount(counts[role.id]);
        if (expected !== actual) return false;
      }
      return true;
    }) ?? null;
  }, [counts, totalCrewSize]);

  // ───────────────────────────────────────────────────────────────────────────
  return (
    <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto pb-32 lg:pb-6">
      {/* ─── Print-only header ─── */}
      <div className="hidden print:block mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-ink">Калькуляция ставок осветителей</h1>
            <p className="text-sm text-ink-3 mt-0.5">
              Техническая группа · съёмочный день · {TOGGLE_LABELS[cardId].long} (с {formatEffectiveFrom(activeCard.effectiveFrom)})
            </p>
          </div>
          <div className="text-right text-sm text-ink-3">
            <div>{printDate}</div>
          </div>
        </div>
        <div className="mt-3 flex gap-6 text-sm border-t border-border pt-3">
          <div><span className="text-ink-3">Рабочих часов:</span> <span className="font-semibold">{hoursLabel}</span></div>
          <div><span className="text-ink-3">Человек в команде:</span> <span className="font-semibold">{totalCrewSize}</span></div>
          {overtimeHours > 0 && (
            <div><span className="text-ink-3">Переработка:</span> <span className="font-semibold text-amber">{overtimeHours} ч</span></div>
          )}
          <div className="ml-auto"><span className="text-ink-3">Итого:</span> <span className="font-bold text-lg mono-num">{formatMoneyRub(result.grandTotal)} ₽</span></div>
        </div>
      </div>

      {/* ─── Screen header ─── */}
      <header className="print:hidden mb-6">
        <div className="flex items-baseline justify-between gap-4 flex-wrap mb-1">
          <span className="eyebrow">Калькулятор · Техническая группа</span>

          {/* Rate card toggle */}
          <div className="flex items-center gap-2.5">
            <span className="eyebrow">Тариф</span>
            <div role="radiogroup" aria-label="Версия тарифа" className="inline-flex rounded-md border border-border bg-surface overflow-hidden">
              {TOGGLE_CARD_IDS.map((id) => {
                const active = cardId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setCardId(id)}
                    className={`h-8 px-3 text-xs font-semibold uppercase tracking-wide font-cond transition-colors ${
                      active
                        ? "bg-ink text-surface"
                        : "bg-surface text-ink-2 hover:bg-surface-subtle"
                    }`}
                    title={`${TOGGLE_LABELS[id].long} · с ${formatEffectiveFrom(RATE_CARDS[id].effectiveFrom)}`}
                  >
                    {TOGGLE_LABELS[id].short}
                  </button>
                );
              })}
            </div>
            <span className="text-[11px] text-ink-3 italic hidden sm:inline">
              с {formatEffectiveFrom(activeCard.effectiveFrom)}
            </span>
          </div>
        </div>
        <h1 className="font-cond text-3xl sm:text-4xl font-bold text-ink leading-tight tracking-tight">
          Расчёт смены осветителей
        </h1>
        <p className="text-sm text-ink-2 mt-2 max-w-2xl">
          Базовая смена до 10 часов плюс прогрессивная переработка по трём ставкам.
          Активный тариф — <span className="font-semibold text-ink">{TOGGLE_LABELS[cardId].long}</span>{" "}
          (с {formatEffectiveFrom(activeCard.effectiveFrom)}). Параметры сохраняются в URL —
          можно поделиться ссылкой на расчёт.
        </p>
      </header>

      {/* ─── HERO KPI strip ─── */}
      <section className="print:hidden mb-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border rounded-lg overflow-hidden border border-border">
          {/* Total */}
          <div className="bg-ink text-surface p-5">
            <div className="text-[10px] font-cond uppercase tracking-widest text-ink-3">Итого за день</div>
            <div className="font-cond font-bold mono-num leading-none mt-2 text-4xl sm:text-5xl">
              {formatMoneyRub(result.grandTotal)}
              <span className="ml-1 text-2xl sm:text-3xl text-ink-3 font-normal"> ₽</span>
            </div>
            <div className="mt-3 text-xs text-ink-3 min-h-[1rem]">
              {overtimePremium > 0 ? (
                <span>
                  <span className="text-amber-soft/90">+{formatMoneyRub(overtimePremium)} ₽</span>{" "}
                  за переработку
                </span>
              ) : totalCrewSize > 0 ? (
                <span>базовая смена · без переработок</span>
              ) : (
                <span>заполните состав и часы</span>
              )}
            </div>
          </div>

          {/* Effective rate */}
          <div className="bg-surface p-5">
            <div className="eyebrow">Ставка / час / человек</div>
            <div className="font-cond font-bold mono-num leading-none mt-2 text-3xl sm:text-4xl text-ink">
              {effectiveRate > 0 ? formatMoneyRub(Math.round(effectiveRate)) : "—"}
              {effectiveRate > 0 && <span className="ml-1 text-xl sm:text-2xl text-ink-3 font-normal"> ₽</span>}
            </div>
            <div className="mt-3 text-xs text-ink-2 min-h-[1rem]">
              {hours !== null && totalCrewSize > 0 ? (
                <span>
                  {totalCrewSize} {totalCrewSize === 1 ? "человек" : "чел."} · {hoursLabel}
                  {overtimeHours > 0 && (
                    <span className="text-amber"> · +{overtimeHours} ч ОТ</span>
                  )}
                </span>
              ) : (
                <span className="text-ink-3">эффективная ставка</span>
              )}
            </div>
          </div>

          {/* Composition */}
          <div className="bg-surface p-5">
            <div className="eyebrow">Команда</div>
            <div className="font-cond font-bold mono-num leading-none mt-2 text-3xl sm:text-4xl text-ink">
              {totalCrewSize || "—"}
              {totalCrewSize > 0 && <span className="ml-1 text-xl sm:text-2xl text-ink-3 font-normal"> чел.</span>}
            </div>
            <div className="mt-3 text-xs text-ink-2 min-h-[1rem] truncate">
              {result.lines.length > 0 ? (
                <span title={result.lines.map((l) => `${l.label} ×${l.count}`).join(" · ")}>
                  {result.lines.map((l) => `${l.label.split(" ")[0]}×${l.count}`).join(" · ")}
                </span>
              ) : (
                <span className="text-ink-3">никого не выбрано</span>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="print:hidden grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ── LEFT: Input form ── */}
        <aside className="lg:col-span-5 space-y-5">
          {/* Hours panel */}
          <section className="rounded-lg border border-border bg-surface overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div>
                <div className="eyebrow">01 — Часы</div>
                <div className="text-sm font-semibold text-ink mt-0.5">Длительность съёмочного дня</div>
              </div>
              {hours !== null && (
                <div className="text-xs text-ink-3 italic">{hoursDescriptor(hours)}</div>
              )}
            </header>
            <div className="p-4 space-y-3">
              {/* Quick pills */}
              <div className="flex gap-1.5 flex-wrap">
                {HOUR_PRESETS.map((h) => {
                  const active = hours === h;
                  return (
                    <button
                      key={h}
                      type="button"
                      onClick={() => setHoursRaw(String(h))}
                      className={`h-9 px-3 rounded-md text-sm font-semibold mono-num border transition-colors ${
                        active
                          ? "bg-ink text-surface border-ink"
                          : "bg-surface text-ink border-border hover:border-ink hover:bg-surface-subtle"
                      }`}
                    >
                      {h}ч
                    </button>
                  );
                })}
                {/* Custom input */}
                <div className="flex items-center rounded-md border border-border bg-surface overflow-hidden flex-1 min-w-[110px]">
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    inputMode="decimal"
                    className="h-9 flex-1 w-full px-2.5 bg-transparent text-sm font-semibold mono-num focus:outline-none focus:ring-2 focus:ring-accent-bright/30"
                    placeholder="N"
                    value={hoursRaw}
                    onChange={(e) => setHoursRaw(e.target.value)}
                    aria-label="Произвольное количество часов"
                  />
                  <div className="px-2 text-xs text-ink-3 border-l border-border h-9 flex items-center">
                    часов
                  </div>
                </div>
              </div>

              {/* Hour ribbon */}
              {hours !== null && hours > 0 && (
                <div className="pt-2 animate-[slidein_180ms_ease-out]">
                  <HourRibbon hours={hours} />
                </div>
              )}

              {/* OT alert */}
              {overtimeHours > 0 && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-soft border border-amber-border text-xs">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber shrink-0 mt-px" aria-hidden>
                    <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                  </svg>
                  <div className="text-amber leading-snug">
                    <span className="font-semibold">Переработка {overtimeHours} ч.</span>{" "}
                    Считается прогрессивно: первые 8 ч ОТ × 1, следующие 6 ч × 2, далее × 4 от базовой почасовой.
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Crew panel */}
          <section className="rounded-lg border border-border bg-surface overflow-hidden">
            <header className="px-4 py-3 border-b border-border">
              <div className="flex items-center justify-between">
                <div>
                  <div className="eyebrow">02 — Состав</div>
                  <div className="text-sm font-semibold text-ink mt-0.5">Кто работает на смене</div>
                </div>
                {totalCrewSize > 0 && (
                  <button
                    type="button"
                    onClick={reset}
                    className="text-xs text-ink-3 hover:text-ink underline-offset-2 hover:underline"
                  >
                    сбросить
                  </button>
                )}
              </div>

              {/* Presets */}
              <div className="mt-3 flex gap-1.5 flex-wrap">
                {CREW_PRESETS.map((p) => {
                  const active = activePreset === p.id || matchingPreset?.id === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p)}
                      className={`group h-auto py-1.5 px-2.5 rounded-md text-left border transition-colors ${
                        active
                          ? "bg-accent-soft text-accent border-accent-border"
                          : "bg-surface text-ink-2 border-border hover:border-ink hover:bg-surface-subtle"
                      }`}
                    >
                      <div className="text-xs font-semibold leading-tight">{p.label}</div>
                      <div className="text-[10px] text-ink-3 leading-tight mt-0.5">{p.sub}</div>
                    </button>
                  );
                })}
              </div>
            </header>

            <div className="px-3 py-2 divide-y divide-border/60">
              {activeRoles.map((role) => {
                const n = parseCount(counts[role.id]);
                return (
                  <RoleRow
                    key={role.id}
                    role={role}
                    count={n}
                    hours={hours}
                    onChange={(next) => setRoleCount(role.id, next)}
                  />
                );
              })}
            </div>
          </section>

          {/* Rates reference (collapsed) */}
          <details className="rounded-lg border border-border bg-surface overflow-hidden">
            <summary className="px-4 py-3 cursor-pointer flex items-center justify-between hover:bg-surface-subtle">
              <div>
                <div className="eyebrow">Справочник · {TOGGLE_LABELS[cardId].long}</div>
                <div className="text-sm font-semibold text-ink mt-0.5">
                  Применённые ставки <span className="text-ink-3 font-normal text-xs">· с {formatEffectiveFrom(activeCard.effectiveFrom)}</span>
                </div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3 transition-transform" aria-hidden>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </summary>
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-xs">
                <thead className="bg-surface-subtle">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-ink-2">Роль</th>
                    <th className="text-right px-3 py-2 font-semibold text-ink-2">Смена</th>
                    <th className="text-right px-3 py-2 font-semibold text-ink-2">ОТ 1–8</th>
                    <th className="text-right px-3 py-2 font-semibold text-ink-2">ОТ 9–14</th>
                    <th className="text-right px-3 py-2 font-semibold text-ink-2">ОТ 15+</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRoles.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2 font-medium text-ink">{r.label}</td>
                      <td className="px-3 py-2 text-right mono-num">{formatMoneyRub(r.shiftRate)}</td>
                      <td className="px-3 py-2 text-right mono-num text-ink-2">{formatMoneyRub(r.overtime.tier1)}<span className="text-ink-3">/ч</span></td>
                      <td className="px-3 py-2 text-right mono-num text-amber">{formatMoneyRub(r.overtime.tier2)}<span className="text-ink-3">/ч</span></td>
                      <td className="px-3 py-2 text-right mono-num text-rose">{formatMoneyRub(r.overtime.tier3)}<span className="text-ink-3">/ч</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </aside>

        {/* ── RIGHT: Results ── */}
        <main className="lg:col-span-7 space-y-5">
          {/* Empty state */}
          {(hours === null || result.lines.length === 0) && (
            <div className="rounded-lg border border-dashed border-border bg-surface-muted px-6 py-16 text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-surface-subtle flex items-center justify-center mb-3">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-3" aria-hidden>
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <div className="text-sm font-semibold text-ink">
                {hours === null ? "Укажите часы" : "Добавьте людей"}
              </div>
              <div className="text-xs text-ink-3 mt-1 max-w-xs mx-auto">
                {hours === null
                  ? "Выберите длительность смены — слева есть быстрые пресеты на 8, 10, 12, 14 и 16 часов."
                  : "Нажмите на любой пресет состава или соберите команду вручную."}
              </div>
            </div>
          )}

          {/* Detailed breakdown table */}
          {result.lines.length > 0 && (
            <section className="rounded-lg border border-border bg-surface overflow-hidden">
              <header className="px-5 py-3.5 border-b border-border flex items-center justify-between">
                <div>
                  <div className="eyebrow">Детализация</div>
                  <div className="text-sm font-semibold text-ink mt-0.5">Постатейный разбор</div>
                </div>
                <div className="text-xs text-ink-3">
                  <span className="mono-num font-medium text-ink-2">{result.lines.length}</span>{" "}
                  {result.lines.length === 1 ? "позиция" : "позиций"}
                </div>
              </header>
              <div className="divide-y divide-border">
                {result.lines.map((line) => {
                  const sharePct = result.grandTotal > 0 ? (line.totalForRole / result.grandTotal) * 100 : 0;
                  return (
                    <article key={line.role} className="px-5 py-4">
                      {/* Title row */}
                      <div className="flex items-baseline justify-between gap-3 mb-2.5">
                        <div className="flex items-baseline gap-2 min-w-0">
                          <span className="font-semibold text-ink truncate">{line.label}</span>
                          <span className="text-xs text-ink-3 mono-num shrink-0">×{line.count}</span>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-cond font-bold text-lg text-ink mono-num leading-none">
                            {formatMoneyRub(line.totalForRole)}
                            <span className="text-ink-3 font-normal text-sm"> ₽</span>
                          </div>
                          <div className="text-[10px] text-ink-3 mt-0.5 mono-num">
                            {sharePct.toFixed(0)}% от итога
                          </div>
                        </div>
                      </div>

                      {/* Stacked-bar viz of one person's cost */}
                      <PersonStackVis line={line} />

                      {/* Per-person breakdown text */}
                      {line.count > 1 && line.totalOvertimeCostPerPerson > 0 && (
                        <div className="mt-2 text-xs text-ink-3 mono-num">
                          {formatMoneyRub(line.totalPerPerson)} ₽ × {line.count} чел.
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>

              {/* Footer: grand total + actions */}
              <footer className="bg-surface-subtle border-t border-border px-5 py-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <div className="eyebrow">Итого по команде</div>
                    <div className="font-cond font-bold text-3xl text-ink mono-num leading-none mt-0.5">
                      {formatMoneyRub(result.grandTotal)}
                      <span className="text-ink-3 font-normal text-xl"> ₽</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={exportPdf}
                      className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-accent-bright text-surface text-sm font-semibold hover:bg-accent transition-colors shadow-xs"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M6 9V2h12v7" />
                        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                        <rect x="6" y="14" width="12" height="8" rx="1" />
                      </svg>
                      Печать / PDF
                    </button>
                  </div>
                </div>
              </footer>
            </section>
          )}

          {/* OT detail + base comparison */}
          {result.lines.length > 0 && overtimeHours > 0 && (
            <section className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {/* OT detail */}
              <div className="rounded-lg border border-amber-border bg-amber-soft/40 p-4">
                <div className="eyebrow text-amber">Переработка по ролям</div>
                <div className="mt-2 space-y-1.5">
                  {result.lines
                    .filter((l) => l.totalOvertimeCostPerPerson > 0)
                    .map((l) => (
                      <div key={l.role} className="flex justify-between items-baseline text-sm">
                        <span className="text-ink-2 truncate pr-2">
                          {l.label} <span className="text-ink-3 mono-num">×{l.count}</span>
                        </span>
                        <span className="mono-num font-medium text-amber shrink-0">
                          +{formatMoneyRub(l.totalOvertimeCostPerPerson * l.count)} ₽
                        </span>
                      </div>
                    ))}
                  <div className="flex justify-between items-baseline text-sm font-semibold border-t border-amber-border pt-1.5 mt-1.5">
                    <span className="text-amber">Всего переработка</span>
                    <span className="mono-num text-amber">+{formatMoneyRub(totalOvertimeCost)} ₽</span>
                  </div>
                </div>
              </div>

              {/* Base comparison */}
              <div className="rounded-lg border border-border bg-surface p-4">
                <div className="eyebrow">Если бы смена была 10 ч</div>
                <div className="mt-2 space-y-2">
                  <div className="flex justify-between items-baseline text-sm">
                    <span className="text-ink-2">Базовая смена</span>
                    <span className="mono-num font-medium text-ink-2">{formatMoneyRub(baseResult.grandTotal)} ₽</span>
                  </div>
                  <div className="flex justify-between items-baseline text-sm">
                    <span className="text-ink-2">Текущая смена</span>
                    <span className="mono-num font-semibold text-ink">{formatMoneyRub(result.grandTotal)} ₽</span>
                  </div>
                  <div className="flex justify-between items-baseline text-sm border-t border-border pt-2 mt-2">
                    <span className="text-amber font-semibold">Доплата за {overtimeHours} ч ОТ</span>
                    <span className="mono-num font-bold text-amber">+{formatMoneyRub(overtimePremium)} ₽</span>
                  </div>
                </div>
              </div>
            </section>
          )}
        </main>
      </div>

      {/* ── Mobile sticky bottom bar ── */}
      {result.lines.length > 0 && (
        <div className="print:hidden lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border bg-surface/95 backdrop-blur px-4 py-3 shadow-[0_-8px_24px_rgba(9,9,11,0.08)]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-cond uppercase tracking-widest text-ink-3">Итого</div>
              <div className="font-cond font-bold text-xl text-ink mono-num leading-none truncate">
                {formatMoneyRub(result.grandTotal)} ₽
              </div>
            </div>
            <button
              type="button"
              onClick={exportPdf}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-accent-bright text-surface text-sm font-semibold shadow-xs"
              aria-label="Печать / Экспорт PDF"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 9V2h12v7" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" rx="1" />
              </svg>
              PDF
            </button>
          </div>
        </div>
      )}

      {/* ─── Print-only table ─── */}
      {result.lines.length > 0 && (
        <div className="hidden print:block mt-4">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b-2 border-ink text-left">
                <th className="py-2 pr-3 font-semibold">Роль</th>
                <th className="py-2 px-3 text-center font-semibold">Чел.</th>
                <th className="py-2 px-3 text-right font-semibold">Смена</th>
                <th className="py-2 px-3 text-right font-semibold">ОТ 1–8ч</th>
                <th className="py-2 px-3 text-right font-semibold">ОТ 9–14ч</th>
                <th className="py-2 px-3 text-right font-semibold">ОТ 15+ч</th>
                <th className="py-2 px-3 text-right font-semibold">На 1 чел.</th>
                <th className="py-2 pl-3 text-right font-semibold">Итого</th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map((l) => (
                <PrintRow key={l.role} l={l} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink">
                <td colSpan={7} className="py-3 font-bold text-right pr-3">ИТОГО ПО КОМАНДЕ</td>
                <td className="py-3 pl-3 text-right font-bold text-lg mono-num">{formatMoneyRub(result.grandTotal)} ₽</td>
              </tr>
            </tfoot>
          </table>

          {/* OT print breakdown */}
          {overtimeHours > 0 && (
            <div className="mt-6 border border-border rounded p-3">
              <div className="text-xs font-semibold text-ink-2 uppercase tracking-wide mb-2">
                Детализация переработки
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-ink-3">
                    <th className="pb-1">Роль</th>
                    <th className="pb-1 text-right">Чел.</th>
                    <th className="pb-1 text-right">ОТ на 1 чел.</th>
                    <th className="pb-1 text-right">ОТ итого</th>
                  </tr>
                </thead>
                <tbody>
                  {result.lines
                    .filter((l) => l.totalOvertimeCostPerPerson > 0)
                    .map((l) => (
                      <tr key={l.role} className="border-b border-border/60">
                        <td className="py-1">{l.label}</td>
                        <td className="py-1 text-right mono-num">{l.count}</td>
                        <td className="py-1 text-right mono-num">+{formatMoneyRub(l.totalOvertimeCostPerPerson)}</td>
                        <td className="py-1 text-right mono-num font-medium">+{formatMoneyRub(l.totalOvertimeCostPerPerson * l.count)}</td>
                      </tr>
                    ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border">
                    <td colSpan={3} className="pt-1.5 font-semibold text-right pr-3">Всего переработка</td>
                    <td className="pt-1.5 text-right font-bold mono-num">+{formatMoneyRub(totalOvertimeCost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Rates ref print */}
          <div className="mt-6 border border-border rounded p-3">
            <div className="text-xs font-semibold text-ink-2 uppercase tracking-wide mb-2">
              Применённые ставки · {TOGGLE_LABELS[cardId].long} (с {formatEffectiveFrom(activeCard.effectiveFrom)})
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-ink-3">
                  <th className="pb-1 text-left">Роль</th>
                  <th className="pb-1 text-right">Смена (до 10ч)</th>
                  <th className="pb-1 text-right">ОТ 1–8ч/ч</th>
                  <th className="pb-1 text-right">ОТ 9–14ч/ч</th>
                  <th className="pb-1 text-right">ОТ 15+ч/ч</th>
                </tr>
              </thead>
              <tbody>
                {activeRoles.map((r) => (
                  <tr key={r.id} className="border-b border-border/60">
                    <td className="py-1">{r.label}</td>
                    <td className="py-1 text-right mono-num">{formatMoneyRub(r.shiftRate)}</td>
                    <td className="py-1 text-right mono-num">{formatMoneyRub(r.overtime.tier1)}</td>
                    <td className="py-1 text-right mono-num">{formatMoneyRub(r.overtime.tier2)}</td>
                    <td className="py-1 text-right mono-num">{formatMoneyRub(r.overtime.tier3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <style jsx global>{`
        @media print {
          @page {
            size: A4;
            margin: 18mm 16mm 18mm 16mm;
          }
          body {
            background: white !important;
            color: black !important;
            font-size: 11pt !important;
          }
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
      `}</style>
    </div>
  );
}

// ─── Sub-component: per-person stacked viz ───────────────────────────────────
// Visualises a single role's per-person cost as a stacked bar with legend.
function PersonStackVis({ line }: { line: RoleBreakdown }) {
  const total = line.totalPerPerson;
  const items = [
    { key: "base", label: "База", hoursLabel: "до 10 ч", value: line.baseShiftCost, hours: BASE_SHIFT, palette: TIER_PALETTE.base },
    { key: "ot1", label: "ОТ 1–8", hoursLabel: `${line.overtimeTier1Hours} ч × ${formatMoneyRub(line.overtimeTier1Hours > 0 ? line.overtimeTier1Cost / line.overtimeTier1Hours : 0)} ₽/ч`, value: line.overtimeTier1Cost, hours: line.overtimeTier1Hours, palette: TIER_PALETTE.ot1 },
    { key: "ot2", label: "ОТ 9–14", hoursLabel: `${line.overtimeTier2Hours} ч × ${formatMoneyRub(line.overtimeTier2Hours > 0 ? line.overtimeTier2Cost / line.overtimeTier2Hours : 0)} ₽/ч`, value: line.overtimeTier2Cost, hours: line.overtimeTier2Hours, palette: TIER_PALETTE.ot2 },
    { key: "ot3", label: "ОТ 15+", hoursLabel: `${line.overtimeTier3Hours} ч × ${formatMoneyRub(line.overtimeTier3Hours > 0 ? line.overtimeTier3Cost / line.overtimeTier3Hours : 0)} ₽/ч`, value: line.overtimeTier3Cost, hours: line.overtimeTier3Hours, palette: TIER_PALETTE.ot3 },
  ].filter((i) => i.value > 0);

  return (
    <div className="space-y-2">
      {/* Stacked bar */}
      <div className="flex h-2 rounded-full overflow-hidden bg-surface-subtle">
        {items.map((i) => (
          <div
            key={i.key}
            className={i.palette.solid}
            style={{ width: `${(i.value / total) * 100}%` }}
            title={`${i.label}: ${formatMoneyRub(i.value)} ₽`}
          />
        ))}
      </div>
      {/* Legend grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5 text-xs">
        {items.map((i) => (
          <div key={i.key} className="flex items-baseline gap-1.5 min-w-0">
            <span className={`inline-block w-2 h-2 rounded-sm ${i.palette.solid} shrink-0`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-cond uppercase tracking-wide text-ink-3 truncate">
                {i.label}
              </div>
              <div className="mono-num text-ink-2 text-[11px] leading-tight">
                {formatMoneyRub(i.value)} ₽
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
