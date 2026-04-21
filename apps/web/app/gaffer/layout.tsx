"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { GafferUserProvider, useGafferUser } from "../../src/components/gaffer/GafferUserContext";

// Public paths that don't require auth guard
const PUBLIC_PATHS = ["/gaffer/login", "/gaffer/register"];

function GafferShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useGafferUser();
  const router = useRouter();
  const pathname = usePathname();

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));

  useEffect(() => {
    if (loading || isPublic) return;
    if (!user) {
      router.replace("/gaffer/login");
      return;
    }
    if (!user.onboardingCompletedAt && pathname !== "/gaffer/welcome") {
      router.replace("/gaffer/welcome");
    }
  }, [loading, user, pathname, isPublic, router]);

  // On public pages just render children
  if (isPublic) {
    return <>{children}</>;
  }

  // Loading skeleton
  if (loading) {
    return (
      <div className="min-h-screen bg-surface-2 flex items-center justify-center">
        <div className="space-y-3 w-64">
          <div className="h-4 bg-border rounded animate-pulse" />
          <div className="h-4 bg-border rounded animate-pulse w-3/4" />
          <div className="h-4 bg-border rounded animate-pulse w-1/2" />
        </div>
      </div>
    );
  }

  // Not authenticated — nothing to render while redirect happens
  if (!user) return null;

  const userInitials = (user.email || "?").slice(0, 2).toUpperCase();

  return (
    <div className="gaffer-root" data-theme="light">
      <div className="min-h-screen bg-[#fafafa] flex flex-col md:flex-row">
        {/* Sidebar on desktop (>= 768px) */}
        <GafferSidebar
          pathname={pathname}
          userEmail={user.email}
          userInitials={userInitials}
          onLogout={logout}
        />

        {/* Mobile column: top header + main + bottom tabbar */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top header — mobile only */}
          <header className="md:hidden bg-accent text-white flex items-center justify-between px-4 py-3 shrink-0">
            <div className="flex items-center gap-3">
              <span
                className="font-sans font-semibold text-sm tracking-wide"
                style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif", letterSpacing: "1.8px", textTransform: "uppercase", fontSize: "12px" }}
              >
                <span className="text-white font-bold tracking-normal text-[14px] normal-case mr-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>Гаффер</span>CRM
              </span>
            </div>
            <div className="flex items-center gap-3">
              {pathname === "/gaffer" && (
                <span className="bg-accent-soft text-accent border border-accent-border rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize">
                  {new Date().toLocaleDateString("ru-RU", { month: "long" })}
                </span>
              )}
              <Link
                href="/gaffer/settings"
                className="text-accent-border hover:text-white transition-colors text-xs"
                title="Настройки"
                aria-label="Настройки"
              >
                ⚙️
              </Link>
              <span className="bg-accent-soft text-accent w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold">
                {userInitials}
              </span>
              <button
                onClick={logout}
                className="text-accent-border hover:text-white transition-colors text-xs whitespace-nowrap"
                aria-label="Выйти"
              >
                Выйти
              </button>
            </div>
          </header>

          {/* Desktop top strip — avatar chip, right-aligned */}
          <div className="hidden md:flex items-center justify-end gap-3 px-8 py-3 border-b border-border bg-surface shrink-0">
            <span
              className="bg-accent-soft text-accent w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold"
              title={user.email}
            >
              {userInitials}
            </span>
          </div>

          {/* Main content area: 480px on mobile, wider on desktop */}
          <main className="flex-1 w-full pb-20 md:pb-8 px-0 md:px-8 mx-auto max-w-[480px] md:max-w-[960px]">
            {children}
          </main>
        </div>

        {/* Bottom tabbar — mobile only */}
        <GafferTabbar pathname={pathname} />
      </div>
    </div>
  );
}

function GafferSidebar({
  pathname,
  userEmail,
  userInitials,
  onLogout,
}: {
  pathname: string;
  userEmail: string;
  userInitials: string;
  onLogout: () => void;
}) {
  const tabs = [
    { href: "/gaffer", label: "Дашборд", icon: "◉" },
    { href: "/gaffer/projects", label: "Проекты", icon: "▤" },
    { href: "/gaffer/contacts", label: "Контакты", icon: "☺" },
    { href: "/gaffer/obligations", label: "Обязательства", icon: "⚖" },
  ];

  function isActive(href: string) {
    if (href === "/gaffer") return pathname === "/gaffer";
    return pathname.startsWith(href);
  }

  return (
    <aside
      className="hidden md:flex md:flex-col md:w-[240px] md:shrink-0 md:bg-accent md:text-white md:min-h-screen md:border-r md:border-white/10"
      aria-label="Боковая навигация"
    >
      {/* Brand */}
      <div className="px-5 py-5 border-b border-white/10">
        <div
          className="text-[11px] font-semibold tracking-[1.8px] uppercase text-accent-border"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
        >
          Light Rental
        </div>
        <div
          className="mt-1 text-[16px] font-bold text-white"
          style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          Гаффер <span className="text-accent-border font-semibold">CRM</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {tabs.map((tab) => {
          const active = isActive(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-[13px] font-semibold tracking-wide transition-colors ${
                active
                  ? "bg-white/10 text-white"
                  : "text-accent-border hover:bg-white/5 hover:text-white"
              }`}
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              <span className="text-[18px] w-5 text-center">{tab.icon}</span>
              <span className="uppercase tracking-[0.08em]">{tab.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer: user + logout */}
      <div className="px-3 py-4 border-t border-white/10 space-y-2">
        <Link
          href="/gaffer/settings"
          className="flex items-center gap-3 px-3 py-2 rounded-md text-[12px] text-accent-border hover:bg-white/5 hover:text-white transition-colors"
        >
          <span className="text-[14px]">⚙️</span>
          <span>Настройки</span>
        </Link>
        <div className="flex items-center gap-3 px-3 py-2">
          <span className="bg-white/10 text-white w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0">
            {userInitials}
          </span>
          <span className="text-[11px] text-accent-border truncate flex-1" title={userEmail}>
            {userEmail}
          </span>
        </div>
        <button
          onClick={onLogout}
          className="w-full text-left px-3 py-2 rounded-md text-[12px] text-accent-border hover:bg-white/5 hover:text-white transition-colors"
        >
          Выйти →
        </button>
      </div>
    </aside>
  );
}

function GafferTabbar({ pathname }: { pathname: string }) {
  const tabs = [
    { href: "/gaffer", label: "Дашборд", icon: "◉" },
    { href: "/gaffer/projects", label: "Проекты", icon: "▤" },
    { href: "/gaffer/contacts", label: "Контакты", icon: "☺" },
    { href: "/gaffer/obligations", label: "Долги", icon: "⚖" },
  ];

  function isActive(href: string) {
    if (href === "/gaffer") return pathname === "/gaffer";
    return pathname.startsWith(href);
  }

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t border-border bg-surface z-40">
      <div className="grid grid-cols-4 max-w-[480px] mx-auto">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex flex-col items-center py-2.5 pb-3 text-[11px] font-semibold tracking-[0.08em] uppercase transition-colors ${
              isActive(tab.href)
                ? "text-accent-bright"
                : "text-ink-3"
            }`}
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            <span className="text-[18px] mb-0.5 tracking-normal">{tab.icon}</span>
            {tab.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export default function GafferLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <GafferUserProvider>
      <GafferShell>{children}</GafferShell>
    </GafferUserProvider>
  );
}
