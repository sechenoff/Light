"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { calculateCrewCost, type RoleBreakdown, ROLES, type RoleId } from "@light-rental/shared";
import { formatRub, formatMoneyRub } from "../../../src/lib/format";

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

// ─── Sub-components ───────────────────────────────────────────────────────────

function OvertimeRow({
  label,
  hours,
  cost,
}: {
  label: string;
  hours: number;
  cost: number;
}) {
  if (hours === 0) return null;
  return (
    <div className="flex justify-between text-[12px] text-ink-2">
      <span className="text-ink-3">{label}</span>
      <span>
        <span className="text-ink-3 tabular-nums">{hours}ч × </span>
        <span className="tabular-nums">{formatMoneyRub(cost / hours)}/ч = </span>
        <span className="font-medium tabular-nums">{formatMoneyRub(cost)}</span>
      </span>
    </div>
  );
}

function RoleCard({ line }: { line: RoleBreakdown }) {
  const hasOT =
    line.overtimeTier1Hours > 0 ||
    line.overtimeTier2Hours > 0 ||
    line.overtimeTier3Hours > 0;

  return (
    <div className="rounded border border-border bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 bg-[#fafafa] border-b border-border">
        <div>
          <span className="font-semibold text-[13px] text-ink">{line.label}</span>
          <span className="ml-2 text-ink-3 text-[12px]">× {line.count}</span>
        </div>
        <div className="text-right">
          <div className="font-bold text-ink tabular-nums text-[13px]">{formatMoneyRub(line.totalForRole)}</div>
          {line.count > 1 && (
            <div className="text-[11px] text-ink-3 tabular-nums">
              {formatMoneyRub(line.totalPerPerson)} / чел.
            </div>
          )}
        </div>
      </div>

      <div className="px-3 py-2.5 space-y-1.5">
        <div className="flex justify-between text-[12px]">
          <span className="text-ink-3">Базовая смена (до 10 ч)</span>
          <span className="font-medium tabular-nums">{formatMoneyRub(line.baseShiftCost)}</span>
        </div>
        {hasOT && (
          <>
            <div className="border-t border-border pt-1.5 mt-1 text-[10.5px] font-semibold text-ink-3 uppercase tracking-wide">
              Переработка
            </div>
            <OvertimeRow label="1–8 ч переработки" hours={line.overtimeTier1Hours} cost={line.overtimeTier1Cost} />
            <OvertimeRow label="9–14 ч переработки" hours={line.overtimeTier2Hours} cost={line.overtimeTier2Cost} />
            <OvertimeRow label="15+ ч переработки" hours={line.overtimeTier3Hours} cost={line.overtimeTier3Cost} />
          </>
        )}
        <div className="flex justify-between text-[12px] pt-1.5 border-t border-border mt-1">
          <span className="text-ink-2">Итого на 1 чел.</span>
          <span className="font-semibold tabular-nums">{formatMoneyRub(line.totalPerPerson)}</span>
        </div>
        {line.count > 1 && (
          <div className="flex justify-between text-[12px] text-ink bg-[#fafafa] -mx-3 px-3 py-2 mt-1 border-t border-border">
            <span>Итого × {line.count} чел.</span>
            <span className="font-bold tabular-nums">{formatMoneyRub(line.totalForRole)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

type CountState = Record<RoleId, string>;

const DEFAULT_COUNTS: CountState = {
  GAFFER: "",
  KEY_GRIP: "",
  BEST_BOY: "",
  PROGRAMMER: "",
  GRIP: "",
};

function GafferCrewCalculatorContent() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = params.get("returnTo") ?? "/gaffer/projects/new";

  const [counts, setCounts] = useState<CountState>(DEFAULT_COUNTS);
  const [hoursRaw, setHoursRaw] = useState("");

  const hours = useMemo(() => parseHours(hoursRaw), [hoursRaw]);

  const crew = useMemo<Partial<Record<RoleId, number>>>(
    () =>
      Object.fromEntries(
        ROLES.map((r) => [r.id, parseCount(counts[r.id])]),
      ) as Record<RoleId, number>,
    [counts],
  );

  const result = useMemo(() => calculateCrewCost(crew, hours), [crew, hours]);
  const totalCrewSize = result.lines.reduce((s, l) => s + l.count, 0);
  const grandTotal = result.grandTotal;

  const hoursLabel =
    hours !== null
      ? hours === 0
        ? "0 ч (базовая смена)"
        : `${hours} ч`
      : "—";

  function reset() {
    setCounts(DEFAULT_COUNTS);
    setHoursRaw("");
  }

  function handleUse() {
    const amount = Math.round(grandTotal);
    router.push(`${returnTo}?crewAmount=${amount}`);
  }

  const hasResult = result.lines.length > 0;

  return (
    <div className="min-h-screen bg-surface pb-28">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        <Link href={returnTo} className="text-accent-bright hover:text-accent transition-colors text-[13px] shrink-0">
          ← Назад
        </Link>
        <div className="min-w-0">
          <h1 className="text-[16px] font-semibold text-ink">Расчёт стоимости команды</h1>
          <p className="text-[11.5px] text-ink-3">осветители · съёмочный день</p>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">
        {/* Hours input */}
        <div className="rounded border border-border bg-surface overflow-hidden">
          <div className="px-3 py-2 bg-[#fafafa] border-b border-border">
            <span className="text-[11.5px] font-semibold text-ink-2 uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>Параметры съёмочного дня</span>
          </div>
          <div className="p-3 space-y-4">
            <div>
              <label className="block text-[12px] text-ink-2 mb-1">Рабочих часов</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  placeholder="0"
                  value={hoursRaw}
                  onChange={(e) => setHoursRaw(e.target.value)}
                  className="w-28 px-[11px] py-[9px] border border-border rounded text-[14px] font-semibold text-center bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
                />
                <span className="text-[12px] text-ink-3">
                  {hours !== null && hours > 10
                    ? `(10 базовых + ${+(hours - 10).toFixed(2)} ч OT)`
                    : hours !== null && hours <= 10
                      ? "базовая смена"
                      : ""}
                </span>
              </div>
              <p className="text-[11px] text-ink-3 mt-1">До 10 ч — одна базовая смена. Переработка считается прогрессивно.</p>
            </div>

            {/* Role counts */}
            <div>
              <label className="block text-[12px] text-ink-2 mb-2">Состав команды</label>
              <div className="space-y-2.5">
                {ROLES.map((role) => {
                  const val = counts[role.id];
                  const n = parseCount(val);
                  return (
                    <div key={role.id} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">{role.label}</div>
                        <div className="text-[11px] text-ink-3">{formatMoneyRub(role.shiftRate)} / смена</div>
                      </div>
                      <div className="flex items-center rounded border border-border overflow-hidden shrink-0">
                        <button
                          type="button"
                          className="h-9 w-9 text-[17px] text-ink-2 bg-surface hover:bg-[#fafafa] disabled:opacity-40 transition-colors"
                          disabled={n <= 0}
                          onClick={() =>
                            setCounts((p) => ({
                              ...p,
                              [role.id]: String(Math.max(0, n - 1) || ""),
                            }))
                          }
                        >
                          −
                        </button>
                        <input
                          type="text"
                          inputMode="numeric"
                          className="h-9 w-12 border-x border-border text-center bg-surface text-[13px] font-medium text-ink focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent-border"
                          placeholder="0"
                          value={val}
                          onChange={(e) => {
                            const raw = e.target.value.replace(/[^\d]/g, "");
                            setCounts((p) => ({ ...p, [role.id]: raw }));
                          }}
                        />
                        <button
                          type="button"
                          className="h-9 w-9 text-[17px] text-ink-2 bg-surface hover:bg-[#fafafa] transition-colors"
                          onClick={() =>
                            setCounts((p) => ({
                              ...p,
                              [role.id]: String(n + 1),
                            }))
                          }
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-between items-center pt-2 border-t border-border">
              <span className="text-[11.5px] text-ink-3">
                Всего: <span className="font-medium text-ink">{totalCrewSize} чел.</span>
                {hours !== null && (
                  <> · <span className="font-medium text-ink">{hoursLabel}</span></>
                )}
              </span>
              <button
                type="button"
                className="text-[12px] text-ink-3 hover:text-ink transition-colors"
                onClick={reset}
              >
                Сбросить
              </button>
            </div>
          </div>
        </div>

        {/* Placeholder when nothing set */}
        {hours === null && (
          <div className="rounded border border-border bg-surface px-5 py-10 text-center text-[13px] text-ink-3">
            Укажите количество рабочих часов и состав команды выше.
          </div>
        )}
        {hours !== null && result.lines.length === 0 && (
          <div className="rounded border border-border bg-surface px-5 py-10 text-center text-[13px] text-ink-3">
            Добавьте хотя бы одного специалиста.
          </div>
        )}

        {/* Role cards */}
        <div className="space-y-3">
          {result.lines.map((line) => (
            <RoleCard key={line.role} line={line} />
          ))}
        </div>

        {/* Grand total summary */}
        {hasResult && (
          <div className="rounded border-2 border-ink bg-ink text-white overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-[11.5px] text-white/70">Итого за съёмочный день</p>
                <p className="text-[11px] text-white/50 mt-0.5">
                  {totalCrewSize} чел. · {hoursLabel}
                </p>
              </div>
              <div className="text-[24px] font-bold tabular-nums">
                {formatRub(grandTotal)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Sticky CTA */}
      <div className="fixed bottom-0 left-0 right-0 bg-surface border-t border-border px-4 py-3 flex gap-2">
        {hasResult ? (
          <button
            type="button"
            onClick={handleUse}
            className="flex-1 bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-3 text-[14px] transition-colors"
          >
            Использовать сумму {formatRub(grandTotal)}
          </button>
        ) : (
          <button
            type="button"
            disabled
            className="flex-1 bg-accent-bright text-white font-medium rounded px-4 py-3 text-[14px] opacity-40 cursor-not-allowed"
          >
            Использовать сумму
          </button>
        )}
        <Link
          href={returnTo}
          className="px-4 py-3 text-[14px] text-ink-2 border border-border rounded hover:bg-[#fafafa] transition-colors"
        >
          Отмена
        </Link>
      </div>
    </div>
  );
}

export default function GafferCrewCalculatorPage() {
  return (
    <Suspense fallback={
      <div className="p-4 space-y-3 animate-pulse">
        <div className="h-5 bg-border rounded w-1/2" />
        <div className="h-4 bg-border rounded w-1/3" />
      </div>
    }>
      <GafferCrewCalculatorContent />
    </Suspense>
  );
}
