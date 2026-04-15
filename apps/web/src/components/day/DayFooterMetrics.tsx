"use client";

import type { ReactNode } from "react";

export function DayFooterMetrics({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 pt-3 border-t border-dashed border-border text-xs text-ink-3">
      {children}
    </div>
  );
}
