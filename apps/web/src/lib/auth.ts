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

// ── Дедупликация /api/auth/me (перф-аудит 2026-08-02) ────────────────────────
// useCurrentUser вызывается из AppShell + useRequireRole на каждой странице:
// одна навигация давала 3-4 одинаковых GET /api/auth/me подряд. Модульный
// промис-кэш с коротким TTL схлопывает их в один сетевой запрос; параллельные
// вызыватели разделяют один in-flight промис.
// Кэшируем и успех, и 401 (user=null) — оба валидные ответы сервера; сетевые
// ошибки НЕ кэшируем (промис удаляется), чтобы обрыв сети не выглядел
// как разлогин на TTL.
const ME_CACHE_TTL_MS = 30_000;
type MeResponse = { user: { userId: string; username: string; role: UserRole } };
let meCache: { promise: Promise<CurrentUser | null>; at: number } | null = null;

function fetchMe(): Promise<CurrentUser | null> {
  const now = Date.now();
  if (meCache && now - meCache.at < ME_CACHE_TTL_MS) return meCache.promise;
  const promise = apiFetch<MeResponse>("/api/auth/me")
    .then((res): CurrentUser | null => ({
      userId: res.user.userId,
      username: res.user.username,
      role: res.user.role,
    }))
    .catch((err: unknown) => {
      // 401 — авторитетный ответ «не залогинен», его кэшировать можно.
      // Любая другая ошибка (сеть, 5xx) — не кэшируем, следующий вызов повторит.
      const msg = err instanceof Error ? err.message : "";
      if (!/401|Unauthorized|Требуется авторизация/i.test(msg)) meCache = null;
      return null;
    });
  meCache = { promise, at: now };
  return promise;
}

/** Сброс кэша /api/auth/me — вызывается на login/logout, чтобы смена
 *  пользователя не жила на старом ответе до истечения TTL. */
export function invalidateMeCache(): void {
  meCache = null;
}

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
      // Через модульный кэш: параллельные маунты хука делят один сетевой запрос.
      const u = await fetchMe();
      if (cancelled) return;
      if (u) {
        setUser(u);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
        }
      } else {
        setUser(null);
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      }
      setLoading(false);
    }
    void sync();
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
    invalidateMeCache();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setUser(null);
    router.push("/");
    router.refresh();
  }, [router]);

  return { user, loading, logout };
}
