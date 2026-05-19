"use client";

import { Suspense } from "react";
import { ProblemItemsPage } from "../../../src/components/warehouse/ProblemItemsPage";

export default function ProblemItemsRoute() {
  return (
    <Suspense
      fallback={
        <div className="p-6 flex items-center justify-center min-h-[200px]">
          <span className="text-sm text-ink-3">Загрузка…</span>
        </div>
      }
    >
      <ProblemItemsPage />
    </Suspense>
  );
}
