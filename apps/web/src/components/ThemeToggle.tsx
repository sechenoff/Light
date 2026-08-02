"use client";

/**
 * Переключатель темы для сайдбара AppShell. Сегментированный контрол
 * Светлая / Ночь / Система с иконками (без эмодзи — SVG, правило no-emoji-icons).
 */

import { useTheme, type ThemePref } from "../lib/theme";

function IconSun() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
function IconMoon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function IconAuto() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 18v3" />
    </svg>
  );
}

const OPTIONS: { key: ThemePref; label: string; icon: React.ReactNode }[] = [
  { key: "light", label: "Светлая", icon: <IconSun /> },
  { key: "dark", label: "Ночь", icon: <IconMoon /> },
  { key: "system", label: "Система", icon: <IconAuto /> },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Тема оформления"
      className="flex items-center gap-0.5 rounded-lg bg-white/5 p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = theme === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => setTheme(opt.key)}
            className={`flex h-7 flex-1 items-center justify-center rounded-md transition-colors ${
              active
                ? "bg-white/15 text-white"
                : "text-slate-400 hover:text-white hover:bg-white/10"
            }`}
          >
            {opt.icon}
          </button>
        );
      })}
    </div>
  );
}
