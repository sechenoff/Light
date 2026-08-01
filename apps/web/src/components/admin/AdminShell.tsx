"use client";

/**
 * Единый каркас страниц админки — один стандарт ширины для всех вкладок.
 *
 * До 2026-08 каждая вкладка задавала контейнер сама: users/audit/vehicles —
 * полная ширина, clients — max-w-5xl, slang — max-w-6xl, roles — 1280px,
 * more — 5xl. При переключении вкладок страница «прыгала». Теперь:
 *
 *  - таб-бар (AdminTabNav) — полосой на всю ширину, как FinanceTabNav;
 *  - контент — канонический контейнер `max-w-7xl mx-auto px-4 sm:px-6 py-5`,
 *    тот же, что во всех разделах «Финансов».
 *
 * Не меняй ширину в отдельной вкладке — только здесь.
 */

import type { ReactNode } from "react";
import { AdminTabNav, type AdminTabNavProps } from "./AdminTabNav";

export function AdminShell({
  counts,
  children,
}: {
  counts?: AdminTabNavProps["counts"];
  children: ReactNode;
}) {
  return (
    <div className="pb-10 bg-surface-subtle min-h-screen">
      <div className="bg-surface px-4 sm:px-6">
        <AdminTabNav counts={counts} />
      </div>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">{children}</div>
    </div>
  );
}
