"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { FeedbackComposer } from "./FeedbackComposer";

// Маршруты, где плавающую кнопку не показываем (kiosk / unauth).
const HIDE_ON_PREFIXES = [
  "/login",
  "/warehouse/scan",
  "/gaffer", // у gaffer-CRM свой контур
];

function shouldHide(pathname: string | null): boolean {
  if (!pathname) return true;
  return HIDE_ON_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname === p);
}

/**
 * Глобальный плавающий виджет «Сообщить» — fixed bottom-right, доступен на
 * всех аутентифицированных страницах (кроме kiosk и login). Открывает
 * slide-over с формой обратной связи.
 *
 * Чтобы виджет не блокировал sticky-нижние панели на мобильных
 * (например, /crew-calculator), он смещён в правый край и приподнят.
 */
export function FeedbackWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return null;
  if (shouldHide(pathname)) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Сообщить о баге или предложить улучшение"
        className="
          group fixed z-40
          bottom-4 right-4 lg:bottom-5 lg:right-5
          h-11 lg:h-12
          pl-3 pr-4 lg:pl-3.5 lg:pr-5
          rounded-full
          bg-ink text-surface
          shadow-[0_4px_12px_rgba(9,9,11,0.18),0_2px_4px_rgba(9,9,11,0.12)]
          hover:shadow-[0_8px_20px_rgba(9,9,11,0.24),0_4px_8px_rgba(9,9,11,0.16)]
          hover:-translate-y-0.5 transition-all duration-150
          flex items-center gap-2
          text-sm font-semibold
        "
        title="Сообщить о проблеме или предложить идею"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="hidden sm:inline">Сообщить</span>
      </button>

      <FeedbackComposer
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
