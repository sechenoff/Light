"use client";

/**
 * Единый каркас страниц админки — один стандарт ширины для всех вкладок.
 *
 * До 2026-08 каждая вкладка задавала контейнер сама: users/audit/vehicles —
 * полная ширина, clients — max-w-5xl, slang — max-w-6xl, roles — 1280px,
 * more — 5xl. При переключении вкладок страница «прыгала». Теперь:
 *
 *  - таб-бар (AdminTabNav) — полосой на всю ширину, как FinanceTabNav;
 *  - контент — на полную ширину контентной области, канонические отступы
 *    `p-4 lg:p-6` (стандарт ширины страниц внутри AppShell, без max-w/mx-auto);
 *    у полосы табов те же горизонтальные отступы, края совпадают на любой ширине;
 *  - фон страницы — от body (surface-muted), как во всём приложении. Свой фон
 *    здесь не задаём: surface-subtle в ночной теме светлее карточек;
 *  - запас под плавающую кнопку «Сообщить» даёт <main> в AppShell
 *    (pb-20 lg:pb-24), здесь его не дублировать.
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
    <div>
      <div className="bg-surface border-b border-border px-4 lg:px-6">
        <AdminTabNav counts={counts} />
      </div>
      <div className="p-4 lg:p-6">{children}</div>
    </div>
  );
}
