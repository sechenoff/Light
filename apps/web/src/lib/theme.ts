"use client";

/**
 * Ночной режим — управление темой оформления.
 *
 * Тема = смена значений CSS-переменных (--c-*) через data-theme на <html>.
 * Весь UI сидит на семантических токенах, поэтому переключение мгновенно
 * применяется ко всем страницам без правки компонентов.
 *
 *  - "light"  — светлая (по умолчанию: клиентский портал /lk и все остальные
 *               видят светлую, пока явно не выбрали иное);
 *  - "dark"   — ночная;
 *  - "system" — следовать системной теме ОС (prefers-color-scheme).
 *
 * Анти-FOUC: инлайн-скрипт в <head> (layout.tsx) выставляет data-theme ДО
 * первого кадра, читая тот же ключ localStorage. Здесь — реактивный слой.
 */

import { useCallback, useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";
export const THEME_STORAGE_KEY = "lr:theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Разрешает предпочтение в фактическую тему. */
export function resolveTheme(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

function readStoredPref(): ThemePref {
  if (typeof window === "undefined") return "light";
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return raw === "dark" || raw === "system" || raw === "light" ? raw : "light";
}

/** Применяет тему к <html> (единственная точка мутации data-theme из JS). */
export function applyResolvedTheme(resolved: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function useTheme(): {
  theme: ThemePref;
  resolved: "light" | "dark";
  setTheme: (t: ThemePref) => void;
} {
  // C6-паттерн: стартуем с "light" (совпадает с SSR/анти-FOUC дефолтом),
  // реальное значение читаем в effect на клиенте — без hydration-mismatch.
  const [theme, setThemeState] = useState<ThemePref>("light");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  useEffect(() => {
    const pref = readStoredPref();
    setThemeState(pref);
    setResolved(resolveTheme(pref));
  }, []);

  // Пока выбран "system" — следим за сменой системной темы вживую.
  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const r = mq.matches ? "dark" : "light";
      setResolved(r);
      applyResolvedTheme(r);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemePref) => {
    setThemeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    }
    const r = resolveTheme(next);
    setResolved(r);
    applyResolvedTheme(r);
  }, []);

  return { theme, resolved, setTheme };
}
