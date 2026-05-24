"use client";
import { ReactNode } from "react";
import Link from "next/link";
import { useLkSession } from "../../hooks/useLkSession";
import { lkApi } from "../../lib/lkApi";
import { LkNav } from "./LkNav";

export function LkShell({ children }: { children: ReactNode }) {
  const { me, loading } = useLkSession();

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center text-ink-2">
        Загрузка…
      </div>
    );
  }

  if (!me) {
    if (typeof window !== "undefined") {
      window.location.href = "/lk/login";
    }
    return null;
  }

  return (
    <div className="min-h-screen bg-surface text-ink">
      <header className="bg-ink text-surface">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <Link href="/lk" className="font-medium tracking-tight">
            Светобаза · Личный кабинет
          </Link>
          <div className="flex items-center gap-3 text-sm text-surface/80">
            <span className="hidden sm:inline">{me.client.name}</span>
            <button
              onClick={async () => {
                try {
                  await lkApi.logout();
                } catch {
                  // ignore — redirect regardless
                }
                window.location.href = "/lk/login";
              }}
              className="px-3 py-1 rounded-md border border-surface/30 hover:bg-surface/10"
            >
              Выйти
            </button>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-3">
          <LkNav />
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
