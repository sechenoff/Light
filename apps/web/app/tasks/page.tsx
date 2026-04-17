"use client";

import { Suspense } from "react";
import { TasksPage } from "../../src/components/tasks/TasksPage";

export default function TasksRoute() {
  return (
    <Suspense
      fallback={
        <div className="p-6 flex items-center justify-center min-h-[200px]">
          <span className="text-sm text-ink-3">Загрузка…</span>
        </div>
      }
    >
      <TasksPage />
    </Suspense>
  );
}
