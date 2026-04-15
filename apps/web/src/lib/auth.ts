"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
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
  const [user, setUser] = useState<CurrentUser | null>(() => readLocal());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
