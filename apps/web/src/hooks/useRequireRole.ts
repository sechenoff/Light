"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useCurrentUser, type UserRole } from "../lib/auth";
import { toast } from "../components/ToastProvider";

export function useRequireRole(allowed: UserRole[]) {
  const router = useRouter();
  const { user, loading } = useCurrentUser();
  // Stabilize array reference so callers can pass inline arrays without effect churn.
  const allowedKey = allowed.join(",");

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (!allowed.includes(user.role)) {
      toast.error("Нет доступа");
      router.replace("/day");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loading, allowedKey, router]);

  return { user, loading, authorized: !!user && allowed.includes(user.role) };
}
