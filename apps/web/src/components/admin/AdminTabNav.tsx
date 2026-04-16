"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface AdminTabNavProps {
  counts?: { users?: number; slang?: number; imports?: number };
}

interface TabDef {
  href: string;
  label: string;
  count?: number;
}

export function AdminTabNav({ counts }: AdminTabNavProps) {
  const pathname = usePathname();

  const tabs: TabDef[] = [
    { href: "/admin/users", label: "👤 Пользователи", count: counts?.users },
    { href: "/admin/slang", label: "🗣 Словарь сленга", count: counts?.slang },
    { href: "/admin/imports", label: "📑 Импорт прайсов", count: counts?.imports },
    { href: "/admin/settings", label: "⚙️ Настройки" },
  ];

  return (
    <div className="flex gap-0.5 border-b border-border">
      {tabs.map((tab) => {
        const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={[
              "-mb-px px-3.5 py-2.5 text-sm border-b-2 transition-colors flex items-center gap-2",
              isActive
                ? "text-ink font-medium border-b-2 border-ink bg-surface"
                : "text-ink-2 border-transparent hover:text-ink hover:bg-surface-2",
            ].join(" ")}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={[
                  "mono-num text-[10.5px] px-1.5 py-0.5 rounded-full",
                  isActive
                    ? "bg-accent-soft text-accent"
                    : "bg-surface-2 text-ink-3",
                ].join(" ")}
              >
                {tab.count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
