"use client";
import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LkShell } from "../../src/components/lk/LkShell";

// Auth routes that bypass LkShell (no session required).
// The shell would redirect unauthenticated users to /lk/login,
// creating a redirect loop if /lk/login itself rendered LkShell.
const AUTH_ROUTES = ["/lk/login", "/lk/login/sent", "/lk/verify"];

export default function LkLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuthRoute = AUTH_ROUTES.includes(pathname ?? "");

  if (isAuthRoute) {
    return (
      <div className="min-h-screen bg-surface text-ink flex items-center justify-center px-4">
        {children}
      </div>
    );
  }

  return <LkShell>{children}</LkShell>;
}
