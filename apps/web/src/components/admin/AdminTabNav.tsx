"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface AdminTabNavProps {
  counts?: { users?: number; slang?: number; imports?: number };
}

interface TabDef {
  href: string;
  label: string;
  icon: ReactNode;
  count?: number;
}

// Инлайн SVG-иконки 16px (стиль lucide, stroke 1.5) вместо emoji —
// единообразный рендер на всех платформах и корректный цвет через currentColor.
function TabIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  users: (
    <TabIcon>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </TabIcon>
  ),
  clients: (
    <TabIcon>
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </TabIcon>
  ),
  messageCircle: (
    <TabIcon>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </TabIcon>
  ),
  fileText: (
    <TabIcon>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
      <path d="M10 9H8" />
    </TabIcon>
  ),
  truck: (
    <TabIcon>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M14 8h5l3 5v4a1 1 0 0 1-1 1h-2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
    </TabIcon>
  ),
  clipboardList: (
    <TabIcon>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </TabIcon>
  ),
  shield: (
    <TabIcon>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </TabIcon>
  ),
  settings: (
    <TabIcon>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </TabIcon>
  ),
  key: (
    <TabIcon>
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </TabIcon>
  ),
};

export function AdminTabNav({ counts }: AdminTabNavProps) {
  const pathname = usePathname();

  // admin-03: /admin/audit и /admin/roles были рабочими, но недостижимыми из UI
  // (ни в меню, ни в табах). Аудит — ключевой инструмент руководителя. Добавлены.
  // admin-01: «Настройки» теперь ведут на реальную /settings/organization
  // (страница /admin/settings редиректит туда же).
  const tabs: TabDef[] = [
    { href: "/admin/users", label: "Пользователи", icon: ICONS.users, count: counts?.users },
    { href: "/admin/clients", label: "Клиенты", icon: ICONS.clients },
    { href: "/admin/slang", label: "Словарь сленга", icon: ICONS.messageCircle, count: counts?.slang },
    { href: "/admin/imports", label: "Импорт прайсов", icon: ICONS.fileText, count: counts?.imports },
    { href: "/admin/vehicles", label: "Транспорт", icon: ICONS.truck },
    { href: "/admin/audit", label: "Аудит", icon: ICONS.clipboardList },
    { href: "/admin/roles", label: "Права", icon: ICONS.shield },
    { href: "/settings/organization", label: "Настройки", icon: ICONS.settings },
    { href: "/admin/more", label: "Кладовщики", icon: ICONS.key },
  ];

  return (
    // overflow-x-auto: вкладки не помещаются на 375px — скроллится сам таб-бар,
    // а не вся страница (иначе горизонтальный overflow всех /admin-страниц).
    <nav
      aria-label="Разделы админки"
      className="flex gap-0.5 border-b border-border overflow-x-auto"
    >
      {tabs.map((tab) => {
        const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={[
              "-mb-px px-3.5 py-2.5 text-sm border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0",
              isActive
                ? "text-ink font-medium border-b-2 border-ink bg-surface"
                : "text-ink-2 border-transparent hover:text-ink hover:bg-surface-muted",
            ].join(" ")}
          >
            {tab.icon}
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
    </nav>
  );
}
