"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { apiFetch } from "./api";

export type UserRole = "SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN";

/** @deprecated используй UserRole */
export type AdminRole = UserRole;

export type CurrentUser = {
  userId?: string;
  username: string;
  role: UserRole;
};

const STORAGE_KEY = "lr_user";

function readLocal(): CurrentUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CurrentUser>;
    if (
      typeof parsed?.username === "string" &&
      (parsed.role === "SUPER_ADMIN" || parsed.role === "WAREHOUSE" || parsed.role === "TECHNICIAN")
    ) {
      return {
        userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
        username: parsed.username,
        role: parsed.role,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Хук текущего пользователя. Считывает из localStorage для быстрой реакции,
 * затем синхронизируется с /api/auth/me (cookie-проверка на сервере).
 */
export function useCurrentUser(): {
  user: CurrentUser | null;
  loading: boolean;
  logout: () => Promise<void>;
} {
  const router = useRouter();
  const pathname = usePathname();
  // C6: always start with null to avoid SSR/CSR hydration mismatch.
  // localStorage is read in the useEffect below (client-only).
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Re-read localStorage on every route change. AppShell живёт в персистентном
  // layout и монтируется один раз — впервые на /login, где /api/auth/me ещё
  // отдаёт 401. После входа login-страница пишет lr_user и делает мягкую
  // навигацию (router.push), которая AppShell НЕ перемонтирует, поэтому эффект
  // ниже (deps []) не перезапускается и сайдбар остаётся пустым до F5. Этот
  // синхронный дешёвый re-read (без сети) подхватывает свежий lr_user при смене
  // маршрута — меню появляется сразу после первого входа.
  useEffect(() => {
    const local = readLocal();
    // Обновляем только если реально изменилось — иначе лишний ре-рендер и
    // затирание userId, синхронизированного из /api/auth/me (login пишет lr_user
    // без userId).
    setUser((prev) => {
      if (local === null) return prev;
      if (
        prev &&
        prev.username === local.username &&
        prev.role === local.role
      ) {
        return prev;
      }
      return local;
    });
  }, [pathname]);

  useEffect(() => {
    // Fast-path: read localStorage immediately so sidebar doesn't flash empty.
    // This runs client-side only, after hydration — no SSR mismatch.
    const local = readLocal();
    if (local) setUser(local);

    let cancelled = false;
    async function sync() {
      try {
        const res = await apiFetch<{ user: { userId: string; username: string; role: UserRole } }>("/api/auth/me");
        if (cancelled) return;
        const u: CurrentUser = { userId: res.user.userId, username: res.user.username, role: res.user.role };
        setUser(u);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
        }
      } catch {
        if (cancelled) return;
        setUser(null);
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    sync();
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // игнорируем — всё равно очищаем клиент
    }
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setUser(null);
    router.push("/");
    router.refresh();
  }, [router]);

  return { user, loading, logout };
}
