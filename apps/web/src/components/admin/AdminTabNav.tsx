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

  // admin-03: /admin/audit и /admin/roles были рабочими, но недостижимыми из UI
  // (ни в меню, ни в табах). Аудит — ключевой инструмент руководителя. Добавлены.
  // admin-01: «Настройки» теперь ведут на реальную /settings/organization
  // (страница /admin/settings редиректит туда же).
  const tabs: TabDef[] = [
    { href: "/admin/users", label: "👤 Пользователи", count: counts?.users },
    { href: "/admin/slang", label: "🗣 Словарь сленга", count: counts?.slang },
    { href: "/admin/imports", label: "📑 Импорт прайсов", count: counts?.imports },
    { href: "/admin/vehicles", label: "🚐 Транспорт" },
    { href: "/admin/audit", label: "📋 Аудит" },
    { href: "/admin/roles", label: "🛡 Права" },
    { href: "/settings/organization", label: "⚙️ Настройки" },
    { href: "/admin/more", label: "🔑 Кладовщики" },
  ];

  return (
    // overflow-x-auto: 8 вкладок не помещаются на 375px — скроллится сам таб-бар,
    // а не вся страница (иначе горизонтальный overflow всех /admin-страниц).
    <div className="flex gap-0.5 border-b border-border overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={[
              "-mb-px px-3.5 py-2.5 text-sm border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0",
              isActive
                ? "text-ink font-medium border-b-2 border-ink bg-surface"
                : "text-ink-2 border-transparent hover:text-ink hover:bg-surface-muted",
            ].join(" ")}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={[
                  "mono-num text-[10.5px] px-1.5 py-0.5 rounded-full",
                  isActive
                    ? "bg-accent-soft text-accent"
                    : "bg-surface-muted text-ink-3",
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
