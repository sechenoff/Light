"use client";

import { useMemo, useState, useCallback } from "react";
import Link from "next/link";

import { calculateCrewCost, type RoleBreakdown } from "../../src/lib/crewCalculator";
import { ROLES, type RoleId } from "../../src/lib/crewRates";
import { formatMoneyRub } from "../../src/lib/format";

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
    <div className="flex justify-between text-sm text-slate-600">
      <span className="text-slate-500">{label}</span>
      <span>
        <span className="text-slate-400 tabular-nums">{hours}ч × </span>
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
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200">
        <div>
          <span className="font-semibold text-slate-900">{line.label}</span>
          <span className="ml-2 text-slate-500 text-sm">× {line.count}</span>
        </div>
        <div className="text-right">
          <div className="font-bold text-slate-900 tabular-nums">{formatMoneyRub(line.totalForRole)}</div>
          {line.count > 1 && (
            <div className="text-xs text-slate-500 tabular-nums">
              {formatMoneyRub(line.totalPerPerson)} / чел.
            </div>
          )}
        </div>
      </div>

      {/* Breakdown for one person */}
      <div className="px-4 py-3 space-y-1.5">
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">Базовая смена (до 10 ч)</span>
          <span className="font-medium tabular-nums">{formatMoneyRub(line.baseShiftCost)}</span>
        </div>

        {hasOT && (
          <>
            <div className="border-t border-slate-100 pt-1.5 mt-1.5 text-xs font-medium text-slate-400 uppercase tracking-wide">
              Переработка
            </div>
            <OvertimeRow
              label="1–8 ч переработки"
              hours={line.overtimeTier1Hours}
              cost={line.overtimeTier1Cost}
            />
            <OvertimeRow
              label="9–14 ч переработки"
              hours={line.overtimeTier2Hours}
              cost={line.overtimeTier2Cost}
            />
            <OvertimeRow
              label="15+ ч переработки"
              hours={line.overtimeTier3Hours}
              cost={line.overtimeTier3Cost}
            />
          </>
        )}

        {/* Per-person total */}
        <div className="flex justify-between text-sm pt-1.5 border-t border-slate-100 mt-1.5">
          <span className="text-slate-600">
            Итого на 1 чел.{" "}
            {hasOT && (
              <span className="text-slate-400">
                (смена + {formatMoneyRub(line.totalOvertimeCostPerPerson)} ОТ)
              </span>
            )}
          </span>
          <span className="font-semibold tabular-nums">{formatMoneyRub(line.totalPerPerson)}</span>
        </div>

        {line.count > 1 && (
          <div className="flex justify-between text-sm text-slate-700 bg-slate-50 -mx-4 px-4 py-2 mt-1 border-t border-slate-200">
            <span>
              Итого × {line.count} чел.
            </span>
            <span className="font-bold tabular-nums">{formatMoneyRub(line.totalForRole)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type CountState = Record<RoleId, string>;

const DEFAULT_COUNTS: CountState = {
  GAFFER: "",
  KEY_GRIP: "",
  BEST_BOY: "",
  PROGRAMMER: "",
  GRIP: "",
};

function PrintHeader({
  hours,
  hoursLabel,
  totalCrewSize,
  grandTotal,
  now,
}: {
  hours: number | null;
  hoursLabel: string;
  totalCrewSize: number;
  grandTotal: number;
  now: string;
}) {
  return (
    <div className="hidden print:block mb-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">
            Калькуляция ставок осветителей
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">Техническая группа · съёмочный день</p>
        </div>
        <div className="text-right text-sm text-slate-500">
          <div>{now}</div>
        </div>
      </div>
      <div className="mt-3 flex gap-6 text-sm border-t border-slate-200 pt-3">
        <div><span className="text-slate-500">Рабочих часов:</span> <span className="font-semibold">{hoursLabel}</span></div>
        <div><span className="text-slate-500">Человек в команде:</span> <span className="font-semibold">{totalCrewSize}</span></div>
        {hours !== null && hours > 10 && (
          <div><span className="text-slate-500">Переработка:</span> <span className="font-semibold text-amber-700">{+(hours - 10).toFixed(2)} ч</span></div>
        )}
        <div className="ml-auto"><span className="text-slate-500">Итого:</span> <span className="font-bold text-lg">{formatMoneyRub(grandTotal)}</span></div>
      </div>
    </div>
  );
}

export default function CrewCalculatorPage() {
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
  const hoursLabel =
    hours !== null
      ? hours === 0
        ? "0 ч (базовая смена)"
        : `${hours} ч`
      : "—";

  const printDate = useMemo(() => {
    return new Date().toLocaleString("ru-RU", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }, []);

  const exportPdf = useCallback(() => {
    window.print();
  }, []);

  function reset() {
    setCounts(DEFAULT_COUNTS);
    setHoursRaw("");
  }

  return (
    <div className="p-4 max-w-5xl mx-auto">
      {/* PDF header — visible only in print */}
      <PrintHeader
        hours={hours}
        hoursLabel={hoursLabel}
        totalCrewSize={totalCrewSize}
        grandTotal={result.grandTotal}
        now={printDate}
      />

      {/* Screen header */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-6 print:hidden">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Калькулятор ставок технической группы
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Расчёт стоимости съёмочного дня с учётом переработок
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <Link href="/bookings" className="text-slate-600 hover:text-slate-900">
            История броней
          </Link>
          <Link href="/equipment" className="text-slate-600 hover:text-slate-900">
            Оборудование
          </Link>
          <Link href="/finance" className="text-slate-600 hover:text-slate-900">
            Финансы
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-5">
        {/* ── Left: Input form — hidden in print ── */}
        <div className="col-span-12 lg:col-span-5 print:hidden">
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
              <div className="text-sm font-semibold text-slate-800">Параметры расчёта</div>
            </div>

            <div className="p-4 space-y-4">
              {/* Hours */}
              <div>
                <label className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                  Рабочих часов
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    className="w-32 rounded border border-slate-300 px-3 py-2 bg-white text-lg font-semibold text-center"
                    placeholder="0"
                    value={hoursRaw}
                    onChange={(e) => setHoursRaw(e.target.value)}
                  />
                  <span className="text-sm text-slate-500">
                    {hours !== null && hours > 10
                      ? `(${10} базовых + ${+(hours - 10).toFixed(2)} ч ОТ)`
                      : hours !== null && hours <= 10
                        ? "базовая смена"
                        : ""}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  До 10 ч — одна базовая смена. Переработка считается прогрессивно.
                </p>
              </div>

              {/* Role counts */}
              <div>
                <label className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                  Состав команды
                </label>
                <div className="mt-2 space-y-2">
                  {ROLES.map((role) => {
                    const val = counts[role.id];
                    const n = parseCount(val);
                    return (
                      <div key={role.id} className="flex items-center gap-3">
                        <div className="flex-1">
                          <div className="text-sm font-medium text-slate-800">{role.label}</div>
                          <div className="text-xs text-slate-400">
                            {formatMoneyRub(role.shiftRate)} / смена
                          </div>
                        </div>
                        <div className="flex items-center rounded border border-slate-300 overflow-hidden">
                          <button
                            type="button"
                            className="h-9 w-9 text-lg text-slate-600 bg-white hover:bg-slate-50 disabled:opacity-40"
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
                            className="h-9 w-12 border-x border-slate-300 text-center bg-white text-sm font-medium"
                            placeholder="0"
                            value={val}
                            onChange={(e) => {
                              const raw = e.target.value.replace(/[^\d]/g, "");
                              setCounts((p) => ({ ...p, [role.id]: raw }));
                            }}
                          />
                          <button
                            type="button"
                            className="h-9 w-9 text-lg text-slate-600 bg-white hover:bg-slate-50"
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

              <div className="flex justify-between items-center pt-2 border-t border-slate-100">
                <div className="text-xs text-slate-500">
                  Всего человек: <span className="font-medium">{totalCrewSize}</span>
                  {hours !== null && (
                    <span>
                      {" · "}рабочих часов: <span className="font-medium">{hoursLabel}</span>
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="text-xs text-slate-400 hover:text-slate-700"
                  onClick={reset}
                >
                  Сбросить
                </button>
              </div>
            </div>
          </div>

          {/* Overtime reference */}
          <div className="mt-4 rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Ставки переработки
            </div>
            <div className="overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2">Роль</th>
                    <th className="text-right px-3 py-2">Смена</th>
                    <th className="text-right px-3 py-2">ОТ 1–8ч</th>
                    <th className="text-right px-3 py-2">ОТ 9–14ч</th>
                    <th className="text-right px-3 py-2">ОТ 15+</th>
                  </tr>
                </thead>
                <tbody>
                  {ROLES.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium text-slate-800">{r.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoneyRub(r.shiftRate)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700">{formatMoneyRub(r.overtime.tier1)}/ч</td>
                      <td className="px-3 py-2 text-right tabular-nums text-orange-700">{formatMoneyRub(r.overtime.tier2)}/ч</td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-700">{formatMoneyRub(r.overtime.tier3)}/ч</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ── Right: Results — full width in print ── */}
        <div className="col-span-12 lg:col-span-7 print:col-span-12 space-y-4">
          {/* Guard: no hours */}
          {hours === null && (
            <div className="print:hidden rounded-lg border border-slate-200 bg-white px-6 py-12 text-center text-slate-400">
              Укажите количество рабочих часов и состав команды слева.
            </div>
          )}

          {/* Guard: hours set but no crew */}
          {hours !== null && result.lines.length === 0 && (
            <div className="print:hidden rounded-lg border border-slate-200 bg-white px-6 py-12 text-center text-slate-400">
              Добавьте хотя бы одного специалиста.
            </div>
          )}

          {/* Role cards — screen only */}
          <div className="print:hidden space-y-4">
            {result.lines.map((line) => (
              <RoleCard key={line.role} line={line} />
            ))}
          </div>

          {/* Print table — hidden on screen */}
          {result.lines.length > 0 && (
            <div className="hidden print:block">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b-2 border-slate-300 text-left">
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
                    <tr key={l.role} className="border-b border-slate-200">
                      <td className="py-2 pr-3 font-medium">{l.label}</td>
                      <td className="py-2 px-3 text-center">{l.count}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{formatMoneyRub(l.baseShiftCost)}</td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {l.overtimeTier1Hours > 0
                          ? `${l.overtimeTier1Hours}ч · ${formatMoneyRub(l.overtimeTier1Cost)}`
                          : "—"}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {l.overtimeTier2Hours > 0
                          ? `${l.overtimeTier2Hours}ч · ${formatMoneyRub(l.overtimeTier2Cost)}`
                          : "—"}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {l.overtimeTier3Hours > 0
                          ? `${l.overtimeTier3Hours}ч · ${formatMoneyRub(l.overtimeTier3Cost)}`
                          : "—"}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums font-medium">{formatMoneyRub(l.totalPerPerson)}</td>
                      <td className="py-2 pl-3 text-right tabular-nums font-bold">{formatMoneyRub(l.totalForRole)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-900">
                    <td colSpan={7} className="py-3 font-bold text-right pr-3">ИТОГО ПО КОМАНДЕ</td>
                    <td className="py-3 pl-3 text-right font-bold text-lg tabular-nums">{formatMoneyRub(result.grandTotal)}</td>
                  </tr>
                </tfoot>
              </table>

              {/* Overtime breakdown for print */}
              {hours !== null && hours > 10 && (
                <div className="mt-6 border border-slate-200 rounded p-3">
                  <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
                    Детализация переработки
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
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
                          <tr key={l.role} className="border-b border-slate-100">
                            <td className="py-1">{l.label}</td>
                            <td className="py-1 text-right">{l.count}</td>
                            <td className="py-1 text-right tabular-nums">+{formatMoneyRub(l.totalOvertimeCostPerPerson)}</td>
                            <td className="py-1 text-right tabular-nums font-medium">+{formatMoneyRub(l.totalOvertimeCostPerPerson * l.count)}</td>
                          </tr>
                        ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-300">
                        <td colSpan={3} className="pt-1.5 font-semibold text-right pr-3">Всего переработка</td>
                        <td className="pt-1.5 text-right font-bold tabular-nums">
                          +{formatMoneyRub(result.lines.reduce((s, l) => s + l.totalOvertimeCostPerPerson * l.count, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* Rates reference for print */}
              <div className="mt-6 border border-slate-200 rounded p-3">
                <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
                  Применённые ставки
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="pb-1 text-left">Роль</th>
                      <th className="pb-1 text-right">Смена (до 10ч)</th>
                      <th className="pb-1 text-right">ОТ 1–8ч/ч</th>
                      <th className="pb-1 text-right">ОТ 9–14ч/ч</th>
                      <th className="pb-1 text-right">ОТ 15+ч/ч</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROLES.map((r) => (
                      <tr key={r.id} className="border-b border-slate-100">
                        <td className="py-1">{r.label}</td>
                        <td className="py-1 text-right tabular-nums">{formatMoneyRub(r.shiftRate)}</td>
                        <td className="py-1 text-right tabular-nums">{formatMoneyRub(r.overtime.tier1)}</td>
                        <td className="py-1 text-right tabular-nums">{formatMoneyRub(r.overtime.tier2)}</td>
                        <td className="py-1 text-right tabular-nums">{formatMoneyRub(r.overtime.tier3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Grand total — screen */}
          {result.lines.length > 0 && (
            <div className="print:hidden rounded-lg border-2 border-slate-900 bg-slate-900 text-white overflow-hidden">
              <div className="px-5 py-4 flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-300">
                    Итого за съёмочный день
                  </div>
                  <div className="text-slate-400 text-xs mt-0.5">
                    {totalCrewSize} чел. · {hoursLabel}
                    {hours !== null && hours > 10 && (
                      <span className="text-amber-400">
                        {" "}· переработка {+(hours - 10).toFixed(2)} ч
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-3xl font-bold tabular-nums">
                  {formatMoneyRub(result.grandTotal)}
                </div>
              </div>

              {/* Per-role summary strip */}
              {result.lines.length > 1 && (
                <div className="border-t border-slate-700 px-5 py-3 flex flex-wrap gap-x-6 gap-y-1">
                  {result.lines.map((l) => (
                    <div key={l.role} className="text-xs text-slate-400">
                      {l.label}{" "}
                      <span className="text-slate-300 font-medium">
                        ×{l.count} — {formatMoneyRub(l.totalForRole)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Export button */}
              <div className="border-t border-slate-700 px-5 py-3">
                <button
                  type="button"
                  onClick={exportPdf}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-white text-slate-900 px-4 py-3 text-sm font-semibold hover:bg-slate-100 transition-colors shadow-sm"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Экспорт PDF
                </button>
              </div>
            </div>
          )}

          {/* Overtime breakdown summary — screen */}
          {result.lines.length > 0 && hours !== null && hours > 10 && (
            <div className="print:hidden rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide mb-2">
                Детализация переработки
              </div>
              <div className="space-y-1">
                {result.lines.map((l) => {
                  if (l.totalOvertimeCostPerPerson === 0) return null;
                  return (
                    <div key={l.role} className="flex justify-between text-sm">
                      <span className="text-amber-800">
                        {l.label} ×{l.count}
                      </span>
                      <span className="tabular-nums text-amber-900 font-medium">
                        +{formatMoneyRub(l.totalOvertimeCostPerPerson * l.count)}
                      </span>
                    </div>
                  );
                })}
                <div className="flex justify-between text-sm font-semibold border-t border-amber-200 pt-1 mt-1">
                  <span className="text-amber-800">Всего переработка</span>
                  <span className="tabular-nums text-amber-900">
                    +{formatMoneyRub(
                      result.lines.reduce(
                        (s, l) => s + l.totalOvertimeCostPerPerson * l.count,
                        0,
                      ),
                    )}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

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
