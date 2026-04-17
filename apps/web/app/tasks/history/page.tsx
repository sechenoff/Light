"use client";

import { Suspense } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { TaskHistoryPage } from "../../../src/components/tasks/TaskHistoryPage";

export default function TasksHistoryRoute() {
  const { loading } = useRequireRole(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="p-6 flex items-center justify-center min-h-[200px]">
          <span className="text-sm text-ink-3">Загрузка…</span>
        </div>
      }
    >
      <TaskHistoryPage />
    </Suspense>
  );
}
