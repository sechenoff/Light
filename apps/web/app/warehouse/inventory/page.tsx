"use client";

import { Suspense } from "react";

import { InventoryStartPage } from "../../../src/components/inventory/InventoryStartPage";

export default function InventoryRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[200px] items-center justify-center p-6">
          <span className="text-sm text-ink-3">Загрузка…</span>
        </div>
      }
    >
      <InventoryStartPage />
    </Suspense>
  );
}
