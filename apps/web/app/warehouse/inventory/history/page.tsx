"use client";

import { Suspense } from "react";

import { InventoryHistoryPage } from "../../../../src/components/inventory/InventoryHistoryPage";

export default function InventoryHistoryRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[200px] items-center justify-center p-6">
          <span className="text-sm text-ink-3">Загрузка…</span>
        </div>
      }
    >
      <InventoryHistoryPage />
    </Suspense>
  );
}
