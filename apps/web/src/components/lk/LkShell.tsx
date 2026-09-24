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
      <header className="bg-inverse text-on-inverse">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <Link href="/lk" className="inline-flex items-center min-h-10 sm:min-h-0 font-medium tracking-tight">
            Светобаза · Личный кабинет
          </Link>
          {/* На тёмной шапке — on-inverse, а не surface: ночью surface тёмный,
              и имя с «Выйти» терялись на bg-inverse. */}
          <div className="flex items-center gap-3 text-sm text-on-inverse/80">
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
              className="inline-flex items-center h-10 sm:h-8 px-3 rounded border border-on-inverse/30 hover:bg-on-inverse/10 transition-colors"
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
