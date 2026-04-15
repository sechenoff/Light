"use client";

import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "rose" | "amber";

const VARIANT_CLASSES: Record<Variant, { bg: string; border: string; accent: string }> = {
  rose: {
    bg: "bg-rose-soft",
    border: "border-rose",
    accent: "text-rose",
  },
  amber: {
    bg: "bg-amber-soft",
    border: "border-amber",
    accent: "text-amber",
  },
};

export function DayAlert({
  variant,
  title,
  count,
  linkHref,
  linkLabel = "Все →",
  children,
}: {
  variant: Variant;
  title: string;
  count?: number;                   // опциональный бейдж
  linkHref?: string;                // если есть — рендерит Link
  linkLabel?: string;
  children?: ReactNode;             // список элементов
}) {
  const c = VARIANT_CLASSES[variant];
  return (
    <div className={`${c.bg} border-l-4 ${c.border} rounded px-4 py-3`}>
      <div className="flex justify-between items-start gap-2">
        <p className={`text-sm font-semibold ${c.accent}`}>
          {title}
          {typeof count === "number" && (
            <span className={`ml-2 inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 rounded-full text-[11px] text-white ${variant === "rose" ? "bg-rose" : "bg-amber"}`}>
              {count}
            </span>
          )}
        </p>
        {linkHref && (
          <Link href={linkHref} className="text-xs text-accent hover:underline shrink-0">
            {linkLabel}
          </Link>
        )}
      </div>
      {children && <div className="mt-2 text-sm text-ink-2">{children}</div>}
    </div>
  );
}
