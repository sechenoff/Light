"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { GafferUserProvider, useGafferUser } from "../../src/components/gaffer/GafferUserContext";

// Public paths that don't require auth guard
const PUBLIC_PATHS = ["/gaffer/login"];

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

  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col">
      {/* Top header */}
      <header className="bg-accent text-white flex items-center justify-between px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <span
            className="font-sans font-semibold text-sm tracking-wide"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif", letterSpacing: "1.8px", textTransform: "uppercase", fontSize: "12px" }}
          >
            <span className="text-white font-bold tracking-normal text-[14px] normal-case mr-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>Гаффер</span>CRM
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/gaffer/settings"
            className="text-accent-border hover:text-white transition-colors text-xs"
            title="Настройки"
            aria-label="Настройки"
          >
            ⚙️
          </Link>
          <span className="text-accent-border text-xs hidden sm:block truncate max-w-[140px]">
            {user.email}
          </span>
          <button
            onClick={logout}
            className="text-accent-border hover:text-white transition-colors text-xs whitespace-nowrap"
          >
            Выйти
          </button>
        </div>
      </header>

      {/* Main content area */}
      <main className="flex-1 max-w-[480px] mx-auto w-full pb-20 px-0">
        {children}
      </main>

      {/* Bottom tabbar (mobile) / top nav (desktop >= 768px) */}
      <GafferTabbar pathname={pathname} />
    </div>
  );
}

function GafferTabbar({ pathname }: { pathname: string }) {
  const tabs = [
    { href: "/gaffer", label: "Дашборд", icon: "◉" },
    { href: "/gaffer/projects", label: "Проекты", icon: "▤" },
    { href: "/gaffer/contacts", label: "Контакты", icon: "☺" },
  ];

  function isActive(href: string) {
    if (href === "/gaffer") return pathname === "/gaffer";
    return pathname.startsWith(href);
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 border-t border-border bg-surface z-40 md:static md:border-t-0 md:border-b md:border-border md:order-first">
      <div className="grid grid-cols-3 max-w-[480px] mx-auto">
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
