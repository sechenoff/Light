"use client";

import Link from "next/link";

/**
 * Общая обёртка для /gaffer/login и /gaffer/register.
 * Подложка bg-accent + бренд + белая карточка с табами «Сотрудник / Гаффер».
 */
export function GafferAuthCard({
  activeTab,
  subtitle,
  children,
}: {
  activeTab: "employee" | "gaffer";
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-h-screen flex flex-col items-center bg-accent pt-14 px-5 pb-8"
      style={{ minHeight: "640px" }}
    >
      {/* Brand */}
      <div className="text-center mb-9">
        <div
          className="text-white font-semibold text-[22px] tracking-tight mb-[6px]"
          style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          Light Rental
        </div>
        <div
          className="text-accent-border text-[11px] font-semibold tracking-[1.8px] uppercase"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
        >
          {subtitle}
        </div>
      </div>

      {/* Card */}
      <div
        className="w-full bg-surface rounded-lg overflow-hidden shadow-[0_14px_28px_rgba(9,9,11,.22)] border border-white/10"
        style={{ maxWidth: "360px" }}
      >
        {/* Tabs */}
        <div className="grid grid-cols-2 border-b border-border bg-[#fafafa]">
          <Link
            href="/login"
            className={`py-[14px] text-center text-[12px] font-semibold tracking-[1.2px] uppercase border-b-2 transition-colors ${
              activeTab === "employee"
                ? "text-accent border-accent-bright bg-surface"
                : "text-ink-3 border-transparent hover:text-ink"
            }`}
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            Сотрудник
          </Link>
          <button
            type="button"
            disabled
            className={`py-[14px] text-center text-[12px] font-semibold tracking-[1.2px] uppercase border-b-2 ${
              activeTab === "gaffer"
                ? "text-accent border-accent-bright bg-surface"
                : "text-ink-3 border-transparent"
            }`}
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            Гаффер
          </button>
        </div>

        {/* Body */}
        <div className="px-[26px] py-[28px]">{children}</div>
      </div>
    </div>
  );
}

/** Цветной Google-логотип для OAuth-кнопок. */
export function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.26-.17-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 009 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.98 10.72a5.4 5.4 0 010-3.44V4.94H.96a9 9 0 000 8.12l3.02-2.34z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A9 9 0 009 0 9 9 0 00.96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

/** Telegram-логотип для OAuth-кнопок. */
export function TelegramIcon() {
  return (
    <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
      <circle cx="9" cy="9" r="9" fill="#2CA5E0" />
      <path
        fill="#fff"
        d="M13.54 5.2 11.9 12.9c-.13.55-.47.68-.95.42l-2.6-1.92-1.26 1.2c-.14.14-.26.26-.52.26l.18-2.62 4.78-4.32c.21-.18-.04-.28-.32-.1L5.3 9.54l-2.56-.8c-.56-.18-.57-.56.12-.83L12.82 4.4c.46-.16.87.11.72.8z"
      />
    </svg>
  );
}
