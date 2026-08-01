"use client";

/**
 * «Поломки» — активные ремонты + открытые потеряшки одним экраном
 * (сцена 3 мокапа v2). Read-only списки + CTA «Зарегистрировать поломку»
 * (ведёт в мастерскую /repair — существующий флоу поломки без возврата).
 *
 * Названия оборудования без barcode (конвенция «No Barcodes in UX»).
 */

import { useEffect, useState } from "react";
import { scanApi, type ProblemsData } from "./api";
import { isScanApiError } from "./types";
import { IconSearch, IconWrench } from "./workstationIcons";

const REPAIR_STATUS: Record<string, { label: string; cls: string }> = {
  WAITING_REPAIR: { label: "Ждёт ремонта", cls: "bg-amber-soft text-amber" },
  IN_REPAIR: { label: "В ремонте", cls: "bg-accent-soft text-accent-bright" },
  WAITING_PARTS: { label: "Ждёт детали", cls: "bg-amber-soft text-amber" },
};

const PROBLEM_STATUS: Record<string, { label: string; cls: string }> = {
  EXPECTED: { label: "Ожидается", cls: "bg-indigo-soft text-indigo" },
  SEARCHING: { label: "В розыске", cls: "bg-rose-soft text-rose" },
};

const PROBLEM_REASON: Record<string, string> = {
  LEFT_ON_SITE: "оставлен на площадке",
  LOST: "утерян",
  DESTROYED: "уничтожен",
  STOLEN: "украден",
};

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

export function ProblemsScreen() {
  const [data, setData] = useState<ProblemsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    scanApi
      .getProblems()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(isScanApiError(err) ? err.message : "Не удалось загрузить поломки");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12 text-sm text-rose">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 px-3 py-3 lg:px-5 lg:py-4">
      <a
        href="/repair"
        className="flex min-h-[60px] items-center gap-2.5 rounded-lg border border-amber-border bg-amber-soft p-3.5 text-amber transition-colors hover:bg-surface"
      >
        <IconWrench className="h-6 w-6 shrink-0" strokeWidth={2} />
        <span>
          <span className="block font-cond text-[16px] font-bold leading-tight">
            Зарегистрировать поломку
          </span>
          <span className="block text-[10.5px] opacity-75">
            без возврата — прямо со склада (мастерская)
          </span>
        </span>
      </a>

      {/* В ремонте */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
        <div className="flex items-center justify-between border-b border-border bg-surface-muted px-3.5 py-2.5">
          <h3 className="text-[12.5px] font-semibold">
            В ремонте{data ? ` · ${data.repairs.length}` : ""}
          </h3>
          <a href="/repair" className="text-[11.5px] text-accent-bright hover:underline">
            Мастерская →
          </a>
        </div>
        {!data ? (
          <div className="space-y-2 p-3.5">
            {[0, 1].map((i) => (
              <div key={i} className="h-[44px] animate-pulse rounded bg-surface-muted" />
            ))}
          </div>
        ) : data.repairs.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-sm text-ink-3">
            Активных ремонтов нет — всё оборудование в строю.
          </p>
        ) : (
          data.repairs.map((r) => {
            const st = REPAIR_STATUS[r.status] ?? {
              label: r.status,
              cls: "bg-surface-muted text-ink-2",
            };
            return (
              <div
                key={r.id}
                className="flex min-h-[52px] items-center gap-2.5 border-b border-surface-subtle px-3.5 py-2.5 last:border-b-0"
              >
                <span
                  aria-hidden
                  className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-amber-soft text-amber"
                >
                  <IconWrench className="h-[17px] w-[17px]" strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-semibold">
                    {r.equipmentName}
                    {r.quantity > 1 ? ` ×${r.quantity}` : ""}
                  </span>
                  <span className="block truncate text-[11px] text-ink-3">
                    {r.reason}
                    {r.sourceProject ? ` · с приёмки «${r.sourceProject}»` : ""}
                    {r.photosCount > 0 ? ` · ${r.photosCount} фото` : ""}
                    {` · ${shortDate(r.createdAt)}`}
                  </span>
                </span>
                <span
                  className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${st.cls}`}
                >
                  {st.label}
                </span>
              </div>
            );
          })
        )}
      </section>

      {/* Потеряшки */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
        <div className="flex items-center justify-between border-b border-border bg-surface-muted px-3.5 py-2.5">
          <h3 className="text-[12.5px] font-semibold">
            Потеряшки{data ? ` · ${data.problems.length}` : ""}
          </h3>
        </div>
        {!data ? (
          <div className="space-y-2 p-3.5">
            <div className="h-[44px] animate-pulse rounded bg-surface-muted" />
          </div>
        ) : data.problems.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-sm text-ink-3">
            Открытых потеряшек нет.
          </p>
        ) : (
          data.problems.map((p) => {
            const st = PROBLEM_STATUS[p.status] ?? {
              label: p.status,
              cls: "bg-surface-muted text-ink-2",
            };
            const searchingDays = p.status === "SEARCHING" ? daysSince(p.createdAt) : 0;
            return (
              <div
                key={p.id}
                className="flex min-h-[52px] items-center gap-2.5 border-b border-surface-subtle px-3.5 py-2.5 last:border-b-0"
              >
                <span
                  aria-hidden
                  className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-rose-soft text-rose"
                >
                  <IconSearch className="h-[17px] w-[17px]" strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-semibold">
                    {p.equipmentName}
                    {p.quantity > 1 ? ` ×${p.quantity}` : ""}
                  </span>
                  <span className="block truncate text-[11px] text-ink-3">
                    {PROBLEM_REASON[p.reason] ?? p.reason}
                    {p.sourceProject ? ` · ${p.sourceProject}` : ""}
                    {p.status === "EXPECTED" && p.expectedBackDate
                      ? ` · ждём ${shortDate(p.expectedBackDate)}`
                      : ""}
                    {searchingDays > 0 ? ` · в розыске ${searchingDays} дн` : ""}
                  </span>
                </span>
                <span
                  className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${st.cls}`}
                >
                  {st.label}
                </span>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
