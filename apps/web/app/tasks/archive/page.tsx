"use client";

import { Suspense } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { TaskArchivePage } from "../../../src/components/tasks/TaskArchivePage";

export default function TasksArchiveRoute() {
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
      <TaskArchivePage />
    </Suspense>
  );
}
