"use client";

import React from "react";
import Link from "next/link";
import {
  Panel,
  PanelTitle,
} from "../designSystem";
import { formatRub, pluralize } from "../../../lib/format";
import type {
  GafferDashboardClientDebt,
  GafferDashboardTeamDebt,
  GafferDashboardVendorDebt,
} from "../../../lib/gafferApi";

// ── Helper ────────────────────────────────────────────────────────────────────

function formatDayMonth(isoStr: string): string {
  const d = new Date(isoStr);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ── ClientsWithDebtPanel ──────────────────────────────────────────────────────

export function ClientsWithDebtPanel({
  rows,
}: {
  rows: GafferDashboardClientDebt[];
}) {
  return (
    <Panel className="flex flex-col">
      <PanelTitle rightHint="сортировка по сумме">Заказчики с долгом</PanelTitle>
      <div className="border-t border-gaffer-divider">
        {rows.length === 0 ? (
          <div className="py-6 text-center text-gaffer-fg-muted text-sm">
            Нет долгов по клиентам
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-gaffer-divider">
            {rows.map((r) => {
              const projectStr = `${r.projectCount}\u00a0${pluralize(r.projectCount, "проект", "проекта", "проектов")}`;
              const paymentStr = r.lastPaymentAt
                ? `последний платёж ${formatDayMonth(r.lastPaymentAt)}`
                : "без платежей";
              return (
                <Link
                  key={r.id}
                  href={`/gaffer/contacts/${r.id}`}
                  className="flex items-center justify-between py-2 hover:bg-gaffer-bg-hover -mx-3 px-3 rounded transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.name}</div>
                    <div className="text-xs text-gaffer-fg-muted truncate">
                      {`${projectStr} · ${paymentStr}`}
                    </div>
                  </div>
                  <div className="text-sm font-medium tabular-nums whitespace-nowrap ml-3">
                    {formatRub(r.remaining)}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ── TeamWithDebtPanel ─────────────────────────────────────────────────────────

type CombinedDebtRow =
  | (GafferDashboardTeamDebt & { kind: "TEAM" })
  | (GafferDashboardVendorDebt & { kind: "VENDOR" });

export function TeamWithDebtPanel({
  team,
  vendors,
}: {
  team: GafferDashboardTeamDebt[];
  vendors: GafferDashboardVendorDebt[];
}) {
  const combined: CombinedDebtRow[] = [
    ...team.map((t) => ({ ...t, kind: "TEAM" as const })),
    ...vendors.map((v) => ({ ...v, kind: "VENDOR" as const })),
  ].sort((a, b) => Number(b.remaining) - Number(a.remaining));

  const total = combined.length;
  const countHint =
    total === 0
      ? undefined
      : `${total} ${pluralize(total, "человек", "человека", "человек")}`;

  return (
    <Panel className="flex flex-col">
      <PanelTitle rightHint={countHint}>Команда с долгом</PanelTitle>
      <div className="border-t border-gaffer-divider">
        {combined.length === 0 ? (
          <div className="py-6 text-center text-gaffer-fg-muted text-sm">
            Нет долгов по команде
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-gaffer-divider">
            {combined.map((r) => {
              const projectStr = `${r.projectCount}\u00a0${pluralize(r.projectCount, "проект", "проекта", "проектов")}`;
              const secondaryLine = r.roleLabel
                ? `${r.roleLabel.toLowerCase()} · ${projectStr}`
                : projectStr;
              return (
                <Link
                  key={`${r.kind}-${r.id}`}
                  href={`/gaffer/contacts/${r.id}`}
                  className="flex items-center justify-between py-2 hover:bg-gaffer-bg-hover -mx-3 px-3 rounded transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.name}</div>
                    <div className="text-xs text-gaffer-fg-muted truncate">
                      {secondaryLine}
                    </div>
                  </div>
                  <div className="text-sm font-medium tabular-nums whitespace-nowrap ml-3">
                    {formatRub(r.remaining)}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}
